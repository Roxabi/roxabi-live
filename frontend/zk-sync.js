// zk-sync.js — seal-on-enable + decrypt-on-load + GitHub content sync (#142 S2/S3, #216 PR 4)

import { api } from "./auth.js";
import {
  deleteZkKeyPair,
  ensureZkKeyPair,
  hasZkKeyPair,
  openContent,
  openContentDual,
  parseEnvelopeVersion,
  sealContent,
  sealWithAccountKey,
} from "./zk-crypto.js";
import { fetchIssueContentMap, getGithubUserToken } from "./zk-github.js";
import { getSessionAccountKey, getSessionKeyFp, isZkUnlocked } from "./zk-session.js";

const BULK = 200;

/** Label when graph title was redacted and this user has no ciphertext row (#216 hybrid multi-user). */
export const SEALED_TITLE_LABEL = "(sealed)";

/** Label when ZK session is locked — distinct from sealed / not-yet-imported. */
export const LOCKED_TITLE_LABEL = "(locked)";

async function putPayloadBatches(payloads) {
  for (let i = 0; i < payloads.length; i += BULK) {
    await api("/api/zk/payloads", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payloads: payloads.slice(i, i + BULK) }),
    });
  }
}

async function sealNodes(nodes, githubLogin, contentByKey) {
  const payloads = [];

  if (isZkUnlocked()) {
    const accountKey = getSessionAccountKey();
    const key_fp = getSessionKeyFp();
    if (!key_fp) throw new Error("key_fp required for accountKey seal");

    for (const node of nodes) {
      const fromGh = contentByKey?.get(node.key);
      const title = fromGh?.title ?? node.title;
      if (!title && !fromGh?.body) continue;

      const encrypted_payload = await sealWithAccountKey(accountKey, {
        title: title ?? null,
        body: fromGh?.body ?? null,
      });
      payloads.push({
        issue_key: node.key,
        key_fp,
        encrypted_payload,
      });
    }
  } else {
    const { publicKey, pubkeyFp } = await ensureZkKeyPair(githubLogin);

    for (const node of nodes) {
      const fromGh = contentByKey?.get(node.key);
      const title = fromGh?.title ?? node.title;
      if (!title && !fromGh?.body) continue;

      const encrypted_payload = await sealContent(publicKey, {
        title: title ?? null,
        body: fromGh?.body ?? null,
      });
      payloads.push({
        issue_key: node.key,
        pubkey_fp: pubkeyFp,
        encrypted_payload,
      });
    }
  }

  if (payloads.length > 0) {
    await putPayloadBatches(payloads);
  }
  return payloads.length;
}

/**
 * On first enroll: decrypt v1 ECIES payloads with local ECDH key, re-seal v2,
 * upload with key_fp, then delete roxabi-zk-v1 keypair (#216 PR 5).
 * @returns {Promise<number>} count of migrated rows
 */
export async function migrateV1PayloadsToAccountKey(githubLogin, accountKey, key_fp) {
  if (!(await hasZkKeyPair(githubLogin))) return 0;

  const resp = await api("/api/zk/payloads");
  const { payloads } = await resp.json();
  const v1Rows = (payloads ?? []).filter(
    (row) => parseEnvelopeVersion(row.encrypted_payload) === 1,
  );
  if (v1Rows.length === 0) {
    clearZkMigrationIncomplete();
    await deleteZkKeyPair(githubLogin);
    return 0;
  }

  const { privateKey } = await ensureZkKeyPair(githubLogin);
  const migrated = [];

  for (const row of v1Rows) {
    try {
      const content = await openContent(privateKey, row.encrypted_payload);
      const encrypted_payload = await sealWithAccountKey(accountKey, content);
      migrated.push({
        issue_key: row.issue_key,
        key_fp,
        encrypted_payload,
      });
    } catch {
      /* skip undecryptable rows */
    }
  }

  if (migrated.length > 0) {
    await putPayloadBatches(migrated);
    console.info("[zk]", { event: "zk.migrate.v1_to_v2.count", count: migrated.length });
  }

  if (migrated.length === v1Rows.length) {
    clearZkMigrationIncomplete();
    await deleteZkKeyPair(githubLogin);
  } else {
    // Partial migration: KEEP the v1 keypair (rows would otherwise orphan,
    // permanently undecryptable) and signal the UI to prompt the user to finish
    // on the original device. Never silently drop undecryptable v1 rows.
    const skipped = v1Rows.length - migrated.length;
    console.warn("[zk]", { event: "zk.migrate.v1_to_v2.incomplete", skipped });
    try {
      sessionStorage.setItem("roxabi:zk-migrate-incomplete", String(skipped));
    } catch {
      /* sessionStorage unavailable */
    }
  }
  return migrated.length;
}

/** Clear the partial-migration signal after a clean or complete migration. */
export function clearZkMigrationIncomplete() {
  try {
    sessionStorage.removeItem("roxabi:zk-migrate-incomplete");
  } catch {
    /* sessionStorage unavailable */
  }
}

/** True when the last v1→v2 migration left undecryptable rows behind. */
export function isZkMigrationIncomplete() {
  try {
    return sessionStorage.getItem("roxabi:zk-migrate-incomplete") !== null;
  } catch {
    return false;
  }
}

async function loadSealedIssueKeys() {
  const payloadResp = await api("/api/zk/payloads")
    .then((r) => r.json())
    .catch(() => ({ payloads: [] }));
  return new Set((payloadResp.payloads ?? []).map((p) => p.issue_key));
}

/**
 * Seal issues missing from zk_payloads. With structure-only sync, node.title is
 * always null — fetch title/body from GitHub when a user token is available.
 * @returns {Promise<{ sealed: number, needsGithubLink: boolean }>}
 */
async function sealUnsealedNodes(nodes, githubLogin, sealedKeys) {
  const toSeal = (nodes ?? []).filter((n) => !sealedKeys.has(n.key));
  if (toSeal.length === 0) return { sealed: 0, needsGithubLink: false };

  let contentByKey = null;
  const token = getGithubUserToken();
  if (token) {
    try {
      contentByKey = await fetchIssueContentMap(
        toSeal.map((n) => n.key),
        token,
      );
    } catch {
      /* best-effort — user can retry via Link GitHub */
    }
  }

  const newlySealed = await sealNodes(toSeal, githubLogin, contentByKey);

  return {
    sealed: newlySealed,
    needsGithubLink: !token || newlySealed < toSeal.length,
  };
}

/**
 * Seal visible graph titles into zk_payloads.
 * @param {Array<{ key: string, title: string|null }>} nodes
 */
export async function sealGraphTitles(nodes, githubLogin) {
  const sealed = await loadSealedIssueKeys();
  return sealUnsealedNodes(nodes, githubLogin, sealed);
}

/**
 * Ensure private mode is active: zk_opt_in on server + seal any unsealed issues.
 * Legacy path when ZK_ACCOUNT_KEY flag is off — uses per-device ECDH v1.
 */
export async function ensurePrivateMode(githubLogin) {
  await api("/api/zk-opt-in", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });

  const graphData = await api("/api/graph").then((r) => r.json());
  const sealed = await loadSealedIssueKeys();
  return sealUnsealedNodes(graphData.nodes ?? [], githubLogin, sealed);
}

/**
 * Seal any unsealed graph titles with accountKey v2 (flag-on path).
 * Requires unlocked session.
 */
/** @returns {Promise<{ sealed: number, needsGithubLink: boolean }|null>} */
export async function ensureAccountKeySealing(githubLogin, nodes) {
  if (!isZkUnlocked()) return null;

  const sealed = await loadSealedIssueKeys();
  return sealUnsealedNodes(nodes, githubLogin, sealed);
}

/**
 * Fetch title+body from GitHub and re-seal zk_payloads.
 */
export async function syncZkContentFromGitHub(nodes, githubLogin, githubToken) {
  const token = githubToken ?? getGithubUserToken();
  if (!token) return { synced: 0, skipped: "no_token" };

  const sealed = await loadSealedIssueKeys();
  const toSync = (nodes ?? []).filter((n) => !sealed.has(n.key));
  if (toSync.length === 0) return { synced: 0, skipped: null };

  const contentByKey = await fetchIssueContentMap(
    toSync.map((n) => n.key),
    token,
  );
  await sealNodes(toSync, githubLogin, contentByKey);
  return { synced: contentByKey.size, skipped: null };
}

/**
 * Decrypt server-redacted titles for the current user.
 * @param {Array<{ key: string, title: string|null }>} nodes
 * @param {string} githubLogin
 * @param {{ accountKeyMode?: boolean }} [opts]
 */
export async function applyZkDecryption(nodes, githubLogin, opts = {}) {
  const { accountKeyMode = false } = opts;

  const { payloads } = await api("/api/zk/payloads")
    .then((r) => r.json())
    .catch(() => ({ payloads: [] }));
  const byKey = new Map((payloads ?? []).map((p) => [p.issue_key, p]));

  if (accountKeyMode && !isZkUnlocked()) {
    for (const node of nodes) {
      if (node.title == null && byKey.has(node.key)) node.title = LOCKED_TITLE_LABEL;
    }
    return;
  }

  if (isZkUnlocked()) {
    const accountKey = getSessionAccountKey();
    const keys = { accountKey };
    if (await hasZkKeyPair(githubLogin)) {
      const { privateKey } = await ensureZkKeyPair(githubLogin);
      keys.privateKey = privateKey;
    }

    for (const node of nodes) {
      const row = byKey.get(node.key);
      if (!row) continue;
      const v = parseEnvelopeVersion(row.encrypted_payload);
      if (v === 1 && !keys.privateKey) {
        node.title = "(needs migration)";
        continue;
      }
      try {
        const content = await openContentDual(keys, row.encrypted_payload);
        node.title = content.title ?? SEALED_TITLE_LABEL;
        if (content.body != null) node.body = content.body;
      } catch {
        node.title = "(decrypt error)";
      }
    }
    return;
  }

  const { privateKey } = await ensureZkKeyPair(githubLogin);

  for (const node of nodes) {
    const row = byKey.get(node.key);
    if (!row) continue;
    try {
      const content = await openContent(privateKey, row.encrypted_payload);
      node.title = content.title ?? SEALED_TITLE_LABEL;
      if (content.body != null) node.body = content.body;
    } catch {
      node.title = "(decrypt error)";
    }
  }
}
