import { describe, expect, it, vi, afterEach } from "vitest";
import {
  getInstallationToken,
  resolveInstallToken,
  listInstallationRepos,
} from "./installToken";
import type { Env } from "../types";

// ---------------------------------------------------------------------------
// FakeD1 — local copy of the project pattern (see session.test.ts)
// ---------------------------------------------------------------------------

type FakeResult = { [k: string]: unknown };

interface FakeStmt {
  sql: string;
  args: unknown[];
  run: () => Promise<{ meta: { changes: number } }>;
  first: <T = FakeResult>() => Promise<T | null>;
  all: <T = FakeResult>() => Promise<{ results: T[] }>;
}

function makeFakeStmt(
  sql: string,
  args: unknown[],
  rows: FakeResult[],
  changes = 0,
): FakeStmt {
  return {
    sql,
    args,
    run: vi.fn().mockResolvedValue({ meta: { changes } }),
    first: vi.fn().mockResolvedValue(rows[0] ?? null),
    all: vi.fn().mockResolvedValue({ results: rows }),
  };
}

function makeFakeDb(
  stmtFactory: (sql: string, args: unknown[]) => FakeStmt,
): D1Database {
  const recorded: FakeStmt[] = [];

  const db = {
    prepare(sql: string) {
      let directStmt: FakeStmt | null = null;
      const getDirectStmt = (): FakeStmt => {
        if (!directStmt) {
          directStmt = stmtFactory(sql, []);
          recorded.push(directStmt);
        }
        return directStmt;
      };

      return {
        first<T = FakeResult>(): Promise<T | null> {
          return getDirectStmt().first<T>();
        },
        run(): Promise<{ meta: { changes: number } }> {
          return getDirectStmt().run();
        },
        all<T = FakeResult>(): Promise<{ results: T[] }> {
          return getDirectStmt().all<T>();
        },
        bind(...args: unknown[]) {
          const stmt = stmtFactory(sql, args);
          recorded.push(stmt);
          return stmt;
        },
      };
    },
    batch: vi.fn(async (stmts: FakeStmt[]) => {
      await Promise.all(stmts.map((s) => s.run()));
      return stmts.map(() => ({ results: [], meta: { changes: 0 } }));
    }),
    _recorded: recorded,
  } as unknown as D1Database & { _recorded: FakeStmt[] };

  return db;
}

// ---------------------------------------------------------------------------
// Test key generation helpers (mirrors jwt.test.ts pattern)
// ---------------------------------------------------------------------------

async function generateTestKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  ) as Promise<CryptoKeyPair>;
}

async function exportPrivateKeyAsB64(key: CryptoKey): Promise<string> {
  const der = (await crypto.subtle.exportKey("pkcs8", key)) as ArrayBuffer;
  return btoa(String.fromCharCode(...new Uint8Array(der)));
}

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

/** Generate a fresh 32-byte INSTALL_TOKEN_KEY as base64. */
function generateInstallTokenKey(): string {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...raw));
}

/** Encrypt a plaintext token using the same AES-GCM approach as tokenCrypto
 *  so we can seed install_tokens with a realistic encrypted row.
 *  NOTE: this is a test-local helper — it imports from tokenCrypto which
 *  doesn't exist yet, so it will also fail at import time (expected RED). */
// We'll use a simple approach: store a known "encrypted" value using the
// real tokenCrypto module once it exists. For now, tests that need a seeded
// encrypted row (cache-hit path) import encryptToken directly.
import { importDek, encryptToken, decryptToken } from "./tokenCrypto";

// ---------------------------------------------------------------------------
// Fake env builder
// ---------------------------------------------------------------------------

async function buildFakeEnv(
  overrides: Partial<Env> = {},
): Promise<{ env: Env; appPrivKeyB64: string; installTokenKeyB64: string }> {
  const pair = await generateTestKeyPair();
  const appPrivKeyB64 = await exportPrivateKeyAsB64(pair.privateKey);
  const installTokenKeyB64 = generateInstallTokenKey();

  const env: Env = {
    DB: null as unknown as D1Database, // overridden per test
    ASSETS: null as unknown as Fetcher,
    GITHUB_ORG: "TestOrg",
    GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
    GITHUB_APP_ID: "999999",
    GITHUB_APP_CLIENT_ID: "Iv1.test",
    GITHUB_APP_CLIENT_SECRET: "test-client-secret",
    GITHUB_APP_PRIVATE_KEY: appPrivKeyB64,
    GITHUB_APP_WEBHOOK_SECRET: "test-app-webhook-secret",
    INSTALL_TOKEN_KEY: installTokenKeyB64,
    ...overrides,
  } as unknown as Env;

  return { env, appPrivKeyB64, installTokenKeyB64 };
}

// ---------------------------------------------------------------------------
// FakeD1 factory for install token scenarios
// ---------------------------------------------------------------------------

/**
 * Build a FakeD1 seeded with tenants + install_tokens + tenant_repo_access rows.
 * The stmtFactory inspects the SQL to route queries to the right fixture data.
 */
function buildSeededDb(opts: {
  tenant?: {
    id: number;
    installation_id: number;
    account_login: string;
    account_type: string;
    suspended_at: string | null;
  };
  installToken?: {
    tenant_id: number;
    token_enc: string;
    token_iv: string;
    expires_at: string; // ISO 8601
  };
  repoAccess?: { tenant_id: number; repo: string }[];
  /** Track upsert calls to install_tokens */
  upsertCapture?: Array<{ sql: string; args: unknown[] }>;
}): D1Database {
  const {
    tenant,
    installToken,
    repoAccess = [],
    upsertCapture,
  } = opts;

  return makeFakeDb((sql, args) => {
    const sqlLower = sql.toLowerCase();

    // Capture upsert/insert into install_tokens
    if (
      upsertCapture &&
      (sqlLower.includes("insert") || sqlLower.includes("update")) &&
      sqlLower.includes("install_tokens")
    ) {
      upsertCapture.push({ sql, args });
      return makeFakeStmt(sql, args, [], 1);
    }

    // Query on install_tokens (cache lookup)
    if (sqlLower.includes("install_tokens")) {
      if (installToken) {
        return makeFakeStmt(sql, args, [installToken as unknown as FakeResult]);
      }
      return makeFakeStmt(sql, args, []); // cache miss
    }

    // JOIN query: SQL contains both "tenant_repo_access" and "join" — this branch must
    // precede the bare tenant_repo_access branch because the JOIN SQL includes both table
    // names and would be incorrectly intercepted by that branch, returning the wrong row
    // shape ({tenant_id, repo} instead of {id, installation_id, suspended_at}).
    if (sqlLower.includes("tenant_repo_access") && sqlLower.includes("join")) {
      const matchingAccess = repoAccess.find((r) => args.includes(r.repo));
      if (matchingAccess && tenant) {
        return makeFakeStmt(sql, args, [tenant as unknown as FakeResult]);
      }
      return makeFakeStmt(sql, args, []); // no matching tenant
    }

    // Query on tenant_repo_access (bare — no JOIN)
    if (sqlLower.includes("tenant_repo_access")) {
      const matchingRow = repoAccess.find(
        (r) => args.includes(r.repo),
      );
      if (matchingRow) {
        return makeFakeStmt(sql, args, [matchingRow as unknown as FakeResult]);
      }
      return makeFakeStmt(sql, args, []); // no access row
    }

    // Query on tenants (suspended check or JOIN)
    if (sqlLower.includes("tenants")) {
      if (tenant) {
        return makeFakeStmt(sql, args, [tenant as unknown as FakeResult]);
      }
      return makeFakeStmt(sql, args, []);
    }

    // Default: empty result
    return makeFakeStmt(sql, args, [], 0);
  });
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

/** ISO timestamp offset from now by `seconds`. */
function nowPlusSeconds(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// getInstallationToken — cache fresh path
// ---------------------------------------------------------------------------

describe("getInstallationToken — cache fresh", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the decrypted token from cache when expires_at > now+5min, without calling fetch", async () => {
    // Arrange
    const { env, installTokenKeyB64 } = await buildFakeEnv();
    const dek = await importDek(installTokenKeyB64);
    const plaintext = "ghs_cached_fresh_token";
    const { enc, iv } = await encryptToken(dek, plaintext);

    const db = buildSeededDb({
      tenant: {
        id: 1,
        installation_id: 42,
        account_login: "TestOrg",
        account_type: "Organization",
        suspended_at: null,
      },
      installToken: {
        tenant_id: 1,
        token_enc: enc,
        token_iv: iv,
        expires_at: nowPlusSeconds(10 * 60), // 10 min from now — well past 5-min threshold
      },
    });

    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;

    // Act
    const token = await getInstallationToken(db, { ...env, DB: db }, 1, 42);

    // Assert
    expect(token).toBe(plaintext);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getInstallationToken — cache stale/miss path
// ---------------------------------------------------------------------------

describe("getInstallationToken — cache stale/missing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls GitHub mint endpoint once when cache is missing, returns fresh token", async () => {
    // Arrange
    const { env } = await buildFakeEnv();
    const freshToken = "ghs_freshly_minted_token";
    const upsertCapture: Array<{ sql: string; args: unknown[] }> = [];

    const db = buildSeededDb({
      tenant: {
        id: 1,
        installation_id: 42,
        account_login: "TestOrg",
        account_type: "Organization",
        suspended_at: null,
      },
      // No installToken row → cache miss
      upsertCapture,
    });

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          token: freshToken,
          expires_at: nowPlusSeconds(3600),
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    // Act
    const token = await getInstallationToken(db, { ...env, DB: db }, 1, 42);

    // Assert
    expect(token).toBe(freshToken);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The fetch URL must reference the installation ID
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain("42");
    expect(calledUrl).toContain("access_tokens");
    // Assert upsert was issued to install_tokens cache
    expect(upsertCapture.length).toBeGreaterThanOrEqual(1);
    expect(upsertCapture[0].sql.toLowerCase()).toContain("install_tokens");
  });

  it("calls GitHub mint endpoint once when cache is stale (expires_at ≤ now+5min)", async () => {
    // Arrange
    const { env, installTokenKeyB64 } = await buildFakeEnv();
    const dek = await importDek(installTokenKeyB64);
    const staleToken = "ghs_stale_token";
    const { enc, iv } = await encryptToken(dek, staleToken);
    const freshToken = "ghs_new_token_after_refresh";
    const upsertCapture: Array<{ sql: string; args: unknown[] }> = [];

    const db = buildSeededDb({
      tenant: {
        id: 1,
        installation_id: 42,
        account_login: "TestOrg",
        account_type: "Organization",
        suspended_at: null,
      },
      installToken: {
        tenant_id: 1,
        token_enc: enc,
        token_iv: iv,
        expires_at: nowPlusSeconds(2 * 60), // 2 min — within the 5-min stale window
      },
      upsertCapture,
    });

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          token: freshToken,
          expires_at: nowPlusSeconds(3600),
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    // Act
    const token = await getInstallationToken(db, { ...env, DB: db }, 1, 42);

    // Assert
    expect(token).toBe(freshToken);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("after a mint, the stored token_enc value is NOT the plaintext token (real decryption round-trip)", async () => {
    // Arrange
    const { env, installTokenKeyB64 } = await buildFakeEnv();
    const freshToken = "ghs_freshly_minted_secret";
    const upsertCapture: Array<{ sql: string; args: unknown[] }> = [];

    const db = buildSeededDb({
      tenant: {
        id: 1,
        installation_id: 42,
        account_login: "TestOrg",
        account_type: "Organization",
        suspended_at: null,
      },
      upsertCapture,
    });

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          token: freshToken,
          expires_at: nowPlusSeconds(3600),
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    ) as typeof fetch;

    // Act
    await getInstallationToken(db, { ...env, DB: db }, 1, 42);

    // Assert — upsert must have been called
    expect(upsertCapture.length).toBeGreaterThanOrEqual(1);
    const upsertArgs = upsertCapture[upsertCapture.length - 1].args;

    // None of the args should literally be the plaintext (basic guard)
    expect(upsertArgs).not.toContain(freshToken);

    // Real guard: recover token_enc and token_iv by SQL parameter position
    // INSERT INTO install_tokens (tenant_id, token_enc, token_iv, expires_at, updated_at)
    // VALUES (?, ?, ?, ?, ?)
    // .bind(tenantId, enc, iv, expires_at, updatedAt)
    //        idx 0    1    2   3           4
    const storedTokenEnc = upsertArgs[1] as string;
    const storedTokenIv = upsertArgs[2] as string;
    expect(typeof storedTokenEnc).toBe("string");
    expect(typeof storedTokenIv).toBe("string");

    // Decrypt and verify round-trip — this FAILS if impl stored plaintext instead of ciphertext
    const dek = await importDek(installTokenKeyB64);
    const recovered = await decryptToken(dek, storedTokenEnc, storedTokenIv);
    expect(recovered).toBe(freshToken);
  });
});

// ---------------------------------------------------------------------------
// resolveInstallToken — fail-closed guards
// ---------------------------------------------------------------------------

describe("resolveInstallToken — fail-closed guards", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws when no tenant_repo_access row exists for the given owner/name", async () => {
    // Arrange
    const { env } = await buildFakeEnv();

    // DB has no tenant_repo_access for "owner/missing-repo"
    const db = buildSeededDb({
      tenant: {
        id: 1,
        installation_id: 42,
        account_login: "owner",
        account_type: "Organization",
        suspended_at: null,
      },
      repoAccess: [], // no access rows
    });

    // Act + Assert — fail-closed: unknown repo must not produce a token
    await expect(
      resolveInstallToken(db, { ...env, DB: db }, "owner", "missing-repo"),
    ).rejects.toThrow();
  });

  it("throws when the owning tenant has suspended_at set (suspended guard)", async () => {
    // Arrange
    const { env, installTokenKeyB64 } = await buildFakeEnv();
    const dek = await importDek(installTokenKeyB64);
    const { enc, iv } = await encryptToken(dek, "ghs_some_token");

    // DB has access row but tenant is suspended
    const db = buildSeededDb({
      tenant: {
        id: 1,
        installation_id: 42,
        account_login: "owner",
        account_type: "Organization",
        suspended_at: "2026-06-01T00:00:00.000Z", // non-null → suspended
      },
      installToken: {
        tenant_id: 1,
        token_enc: enc,
        token_iv: iv,
        expires_at: nowPlusSeconds(10 * 60),
      },
      repoAccess: [{ tenant_id: 1, repo: "owner/my-repo" }],
    });

    // Act + Assert — suspended tenant must be rejected
    await expect(
      resolveInstallToken(db, { ...env, DB: db }, "owner", "my-repo"),
    ).rejects.toThrow();
  });

  it("resolves to the decrypted token via cache-hit when tenant is active", async () => {
    // Arrange
    const { env, installTokenKeyB64 } = await buildFakeEnv();
    const dek = await importDek(installTokenKeyB64);
    const plaintext = "ghs_live_token";
    const { enc, iv } = await encryptToken(dek, plaintext);

    const db = buildSeededDb({
      tenant: {
        id: 1,
        installation_id: 42,
        account_login: "owner",
        account_type: "Organization",
        suspended_at: null, // active — not suspended
      },
      installToken: {
        tenant_id: 1,
        token_enc: enc,
        token_iv: iv,
        expires_at: nowPlusSeconds(10 * 60), // fresh — well beyond 5-min stale window
      },
      repoAccess: [{ tenant_id: 1, repo: "owner/active-repo" }],
    });

    // Act
    const token = await resolveInstallToken(
      db,
      { ...env, DB: db },
      "owner",
      "active-repo",
    );

    // Assert — cache-hit decrypt path returns the expected plaintext token
    expect(token).toBe(plaintext);
  });
});

// ---------------------------------------------------------------------------
// listInstallationRepos — W2 pagination bound (#160)
// ---------------------------------------------------------------------------

describe("listInstallationRepos — W2 pagination bound", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  function fullPage(): Response {
    // Exactly 100 repos → a "full" page that signals more pages may follow.
    const repositories = Array.from({ length: 100 }, (_, i) => ({
      full_name: `o/repo-${i}`,
    }));
    return new Response(JSON.stringify({ repositories }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("caps pagination at MAX_PAGES (10) and warns on truncation when every page is full", async () => {
    const fetchMock = vi.fn(async () => fullPage());
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const repos = await listInstallationRepos("fake-token");

    expect(fetchMock).toHaveBeenCalledTimes(10); // MAX_PAGES — never exceeded
    expect(repos).toHaveLength(1000); // 10 pages × 100 repos
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("MAX_PAGES"));
  });

  it("passes an AbortSignal (per-page timeout) on every fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ repositories: [{ full_name: "o/r" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await listInstallationRepos("fake-token");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const opts = fetchMock.mock.calls[0][1] as RequestInit;
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it("stops early on a short final page and does NOT warn (normal case)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ repositories: [{ full_name: "o/only" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const repos = await listInstallationRepos("fake-token");

    expect(fetchMock).toHaveBeenCalledTimes(1); // short page → single fetch
    expect(repos).toEqual(["o/only"]);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
