// @vitest-environment jsdom
// Port of frontend/zk-sync.test.js — the seal/decrypt/migration logic tests the
// adversarial review flagged as unported. Mocks map: ./auth.js → @/lib/api
// (apiFetch returns parsed JSON directly, no .json() wrapper), ./zk-session.js →
// ./session, ./zk-crypto.js → ./crypto.

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  apiFetchMock,
  isZkUnlockedMock,
  ensureZkKeyPairMock,
  hasZkKeyPairMock,
  deleteZkKeyPairMock,
  openContentMock,
  parseEnvelopeVersionMock,
  sealWithAccountKeyMock,
} = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  isZkUnlockedMock: vi.fn(),
  ensureZkKeyPairMock: vi.fn(),
  hasZkKeyPairMock: vi.fn(),
  deleteZkKeyPairMock: vi.fn(),
  openContentMock: vi.fn(),
  parseEnvelopeVersionMock: vi.fn(),
  sealWithAccountKeyMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  ApiError: class ApiError extends Error {},
}));

vi.mock("./session", () => ({
  isZkUnlocked: () => isZkUnlockedMock(),
  getSessionAccountKey: () => {
    throw new Error("ZK locked");
  },
  getSessionKeyFp: () => "fp12345678",
}));

vi.mock("./crypto", () => ({
  ensureZkKeyPair: (...args: unknown[]) => ensureZkKeyPairMock(...args),
  openContent: (...args: unknown[]) => openContentMock(...args),
  parseEnvelopeVersion: (...args: unknown[]) => parseEnvelopeVersionMock(...args),
  hasZkKeyPair: (...args: unknown[]) => hasZkKeyPairMock(...args),
  sealContent: vi.fn(),
  sealWithAccountKey: (...args: unknown[]) => sealWithAccountKeyMock(...args),
  openContentDual: vi.fn(),
  deleteZkKeyPair: (...args: unknown[]) => deleteZkKeyPairMock(...args),
}));

import {
  LOCKED_TITLE_LABEL,
  applyZkDecryption,
  fetchZkPayloadRows,
  invalidateZkPayloadCache,
  isZkMigrationIncomplete,
  migrateV1PayloadsToAccountKey,
} from "./sync";

describe("fetchZkPayloadRows", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    invalidateZkPayloadCache();
  });

  it("dedupes concurrent GETs and serves cache on subsequent calls", async () => {
    apiFetchMock.mockResolvedValue({ payloads: [{ issue_key: "Roxabi/live#1" }] });

    const [a, b] = await Promise.all([fetchZkPayloadRows(), fetchZkPayloadRows()]);
    expect(a).toEqual(b);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);

    await fetchZkPayloadRows();
    expect(apiFetchMock).toHaveBeenCalledTimes(1);

    invalidateZkPayloadCache();
    await fetchZkPayloadRows();
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("applyZkDecryption", () => {
  beforeEach(() => {
    invalidateZkPayloadCache();
    apiFetchMock.mockReset();
    isZkUnlockedMock.mockReset();
    ensureZkKeyPairMock.mockReset();
  });

  it("marks only user-sealed issues as locked when account key mode is locked", async () => {
    isZkUnlockedMock.mockReturnValue(false);
    apiFetchMock.mockResolvedValue({
      payloads: [{ issue_key: "Roxabi/live#1", encrypted_payload: "v2" }],
    });
    const nodes = [
      { key: "Roxabi/live#1", title: null },
      { key: "Roxabi/live#2", title: null },
    ];

    await applyZkDecryption(nodes, "alice", { accountKeyMode: true });

    expect(ensureZkKeyPairMock).not.toHaveBeenCalled();
    expect(nodes[0].title).toBe(LOCKED_TITLE_LABEL);
    expect(nodes[1].title).toBeNull();
  });
});

describe("migrateV1PayloadsToAccountKey", () => {
  beforeEach(() => {
    invalidateZkPayloadCache();
    sessionStorage.clear();
    apiFetchMock.mockReset();
    hasZkKeyPairMock.mockReset();
    deleteZkKeyPairMock.mockReset();
    openContentMock.mockReset();
    parseEnvelopeVersionMock.mockReset();
    sealWithAccountKeyMock.mockReset();
    ensureZkKeyPairMock.mockReset();
  });

  it("retains keypair when all v1 rows fail to decrypt", async () => {
    hasZkKeyPairMock.mockResolvedValue(true);
    parseEnvelopeVersionMock.mockReturnValue(1);
    openContentMock.mockRejectedValue(new Error("decrypt failed"));
    ensureZkKeyPairMock.mockResolvedValue({ privateKey: {} });
    apiFetchMock.mockResolvedValue({
      payloads: [{ issue_key: "Roxabi/live#1", encrypted_payload: "v1" }],
    });

    const count = await migrateV1PayloadsToAccountKey("alice", {} as CryptoKey, "fp12345678");

    expect(count).toBe(0);
    expect(deleteZkKeyPairMock).not.toHaveBeenCalled();
  });

  it("retains keypair on partial v1 migration", async () => {
    hasZkKeyPairMock.mockResolvedValue(true);
    parseEnvelopeVersionMock.mockReturnValue(1);
    openContentMock
      .mockResolvedValueOnce({ title: "ok", body: null })
      .mockRejectedValueOnce(new Error("decrypt failed"));
    sealWithAccountKeyMock.mockResolvedValue("v2-payload");
    ensureZkKeyPairMock.mockResolvedValue({ privateKey: {} });
    apiFetchMock.mockResolvedValue({
      payloads: [
        { issue_key: "Roxabi/live#1", encrypted_payload: "v1a" },
        { issue_key: "Roxabi/live#2", encrypted_payload: "v1b" },
      ],
    });

    const count = await migrateV1PayloadsToAccountKey("alice", {} as CryptoKey, "fp12345678");

    expect(count).toBe(1);
    expect(deleteZkKeyPairMock).not.toHaveBeenCalled();
  });

  it("deletes keypair when all v1 rows migrate successfully", async () => {
    hasZkKeyPairMock.mockResolvedValue(true);
    parseEnvelopeVersionMock.mockReturnValue(1);
    openContentMock.mockResolvedValue({ title: "t", body: null });
    sealWithAccountKeyMock.mockResolvedValue("v2-payload");
    ensureZkKeyPairMock.mockResolvedValue({ privateKey: {} });
    apiFetchMock
      .mockResolvedValueOnce({
        payloads: [{ issue_key: "Roxabi/live#1", encrypted_payload: "v1" }],
      })
      .mockResolvedValueOnce({});

    const count = await migrateV1PayloadsToAccountKey("alice", {} as CryptoKey, "fp12345678");

    expect(count).toBe(1);
    expect(deleteZkKeyPairMock).toHaveBeenCalledWith("alice");
  });

  it("clears the incomplete flag after a fully successful migration", async () => {
    sessionStorage.setItem("roxabi:zk-migrate-incomplete", "1");
    expect(isZkMigrationIncomplete()).toBe(true);

    hasZkKeyPairMock.mockResolvedValue(true);
    parseEnvelopeVersionMock.mockReturnValue(1);
    openContentMock.mockResolvedValue({ title: "t", body: null });
    sealWithAccountKeyMock.mockResolvedValue("v2-payload");
    ensureZkKeyPairMock.mockResolvedValue({ privateKey: {} });
    apiFetchMock
      .mockResolvedValueOnce({
        payloads: [{ issue_key: "Roxabi/live#1", encrypted_payload: "v1" }],
      })
      .mockResolvedValueOnce({});

    await migrateV1PayloadsToAccountKey("alice", {} as CryptoKey, "fp12345678");

    expect(isZkMigrationIncomplete()).toBe(false);
  });
});
