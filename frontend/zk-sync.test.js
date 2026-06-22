import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.fn();
const isZkUnlockedMock = vi.fn();
const ensureZkKeyPairMock = vi.fn();
const hasZkKeyPairMock = vi.fn();
const deleteZkKeyPairMock = vi.fn();
const openContentMock = vi.fn();
const parseEnvelopeVersionMock = vi.fn();
const sealWithAccountKeyMock = vi.fn();

vi.mock("./auth.js", () => ({
  api: (...args) => apiMock(...args),
}));

vi.mock("./zk-session.js", () => ({
  isZkUnlocked: () => isZkUnlockedMock(),
  getSessionAccountKey: () => {
    throw new Error("ZK locked");
  },
}));

vi.mock("./zk-crypto.js", () => ({
  ensureZkKeyPair: (...args) => ensureZkKeyPairMock(...args),
  openContent: (...args) => openContentMock(...args),
  parseEnvelopeVersion: (...args) => parseEnvelopeVersionMock(...args),
  hasZkKeyPair: (...args) => hasZkKeyPairMock(...args),
  sealContent: vi.fn(),
  sealWithAccountKey: (...args) => sealWithAccountKeyMock(...args),
  openContentDual: vi.fn(),
  deleteZkKeyPair: (...args) => deleteZkKeyPairMock(...args),
}));

const {
  applyZkDecryption,
  fetchZkPayloadRows,
  invalidateZkPayloadCache,
  migrateV1PayloadsToAccountKey,
  isZkMigrationIncomplete,
  LOCKED_TITLE_LABEL,
} = await import("./zk-sync.js");

describe("fetchZkPayloadRows", () => {
  beforeEach(() => {
    apiMock.mockReset();
    invalidateZkPayloadCache();
  });

  it("dedupes concurrent GETs and serves cache on subsequent calls", async () => {
    apiMock.mockResolvedValue({
      json: async () => ({ payloads: [{ issue_key: "Roxabi/live#1" }] }),
    });

    const [a, b] = await Promise.all([fetchZkPayloadRows(), fetchZkPayloadRows()]);
    expect(a).toEqual(b);
    expect(apiMock).toHaveBeenCalledTimes(1);

    await fetchZkPayloadRows();
    expect(apiMock).toHaveBeenCalledTimes(1);

    invalidateZkPayloadCache();
    await fetchZkPayloadRows();
    expect(apiMock).toHaveBeenCalledTimes(2);
  });
});

describe("applyZkDecryption", () => {
  beforeEach(() => {
    invalidateZkPayloadCache();
    apiMock.mockReset();
    isZkUnlockedMock.mockReset();
    ensureZkKeyPairMock.mockReset();
  });

  it("marks only user-sealed issues as locked when account key mode is locked", async () => {
    isZkUnlockedMock.mockReturnValue(false);
    apiMock.mockResolvedValue({
      json: async () => ({
        payloads: [{ issue_key: "Roxabi/live#1", encrypted_payload: "v2" }],
      }),
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
    apiMock.mockReset();
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
    apiMock.mockResolvedValue({
      json: async () => ({
        payloads: [{ issue_key: "Roxabi/live#1", encrypted_payload: "v1" }],
      }),
    });

    const count = await migrateV1PayloadsToAccountKey("alice", {}, "fp12345678");

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
    apiMock.mockResolvedValue({
      json: async () => ({
        payloads: [
          { issue_key: "Roxabi/live#1", encrypted_payload: "v1a" },
          { issue_key: "Roxabi/live#2", encrypted_payload: "v1b" },
        ],
      }),
    });

    const count = await migrateV1PayloadsToAccountKey("alice", {}, "fp12345678");

    expect(count).toBe(1);
    expect(deleteZkKeyPairMock).not.toHaveBeenCalled();
  });

  it("deletes keypair when all v1 rows migrate successfully", async () => {
    hasZkKeyPairMock.mockResolvedValue(true);
    parseEnvelopeVersionMock.mockReturnValue(1);
    openContentMock.mockResolvedValue({ title: "t", body: null });
    sealWithAccountKeyMock.mockResolvedValue("v2-payload");
    ensureZkKeyPairMock.mockResolvedValue({ privateKey: {} });
    apiMock
      .mockResolvedValueOnce({
        json: async () => ({
          payloads: [{ issue_key: "Roxabi/live#1", encrypted_payload: "v1" }],
        }),
      })
      .mockResolvedValueOnce({});

    const count = await migrateV1PayloadsToAccountKey("alice", {}, "fp12345678");

    expect(count).toBe(1);
    expect(deleteZkKeyPairMock).toHaveBeenCalledWith("alice");
  });

  it("clears the incomplete flag after a fully successful migration", async () => {
    // Simulate a prior partial migration having set the signal this session.
    sessionStorage.setItem("roxabi:zk-migrate-incomplete", "1");
    expect(isZkMigrationIncomplete()).toBe(true);

    hasZkKeyPairMock.mockResolvedValue(true);
    parseEnvelopeVersionMock.mockReturnValue(1);
    openContentMock.mockResolvedValue({ title: "t", body: null });
    sealWithAccountKeyMock.mockResolvedValue("v2-payload");
    ensureZkKeyPairMock.mockResolvedValue({ privateKey: {} });
    apiMock
      .mockResolvedValueOnce({
        json: async () => ({
          payloads: [{ issue_key: "Roxabi/live#1", encrypted_payload: "v1" }],
        }),
      })
      .mockResolvedValueOnce({});

    await migrateV1PayloadsToAccountKey("alice", {}, "fp12345678");

    expect(isZkMigrationIncomplete()).toBe(false);
  });
});
