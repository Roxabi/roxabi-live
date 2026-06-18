// zk-sync.js — seal-on-enable + decrypt-on-load + GitHub content sync (#142 S2/S3, #216 PR 4)

import { api } from './auth.js';
import {
  ensureZkKeyPair,
  sealContent,
  openContent,
  sealWithAccountKey,
  openContentDual,
  parseEnvelopeVersion,
  hasZkKeyPair,
} from './zk-crypto.js';
import {
  isZkUnlocked,
  getSessionAccountKey,
  getSessionKeyFp,
} from './zk-session.js';
import { fetchIssueContentMap, getGithubUserToken } from './zk-github.js';

const BULK = 200;

async function putPayloadBatches(payloads) {
  for (let i = 0; i < payloads.length; i += BULK) {
    await api('/api/zk/payloads', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payloads: payloads.slice(i, i + BULK) }),
    });
  }
}

async function sealNodes(nodes, githubLogin, contentByKey) {
  const payloads = [];

  if (isZkUnlocked()) {
    const accountKey = getSessionAccountKey();
    const key_fp = getSessionKeyFp();
    if (!key_fp) throw new Error('key_fp required for accountKey seal');

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
}

/**
 * Seal visible graph titles into zk_payloads.
 * @param {Array<{ key: string, title: string|null }>} nodes
 */
export async function sealGraphTitles(nodes, githubLogin) {
  await sealNodes(nodes, githubLogin, null);
}

/**
 * Ensure private mode is active: zk_opt_in on server + seal any unsealed issues.
 * Legacy path when ZK_ACCOUNT_KEY flag is off — uses per-device ECDH v1.
 */
export async function ensurePrivateMode(githubLogin) {
  await api('/api/zk-opt-in', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  });

  const [graphData, payloadResp] = await Promise.all([
    api('/api/graph').then((r) => r.json()),
    api('/api/zk/payloads')
      .then((r) => r.json())
      .catch(() => ({ payloads: [] })),
  ]);

  const sealed = new Set((payloadResp.payloads ?? []).map((p) => p.issue_key));
  const toSeal = (graphData.nodes ?? []).filter(
    (n) => n.title != null && !sealed.has(n.key),
  );
  if (toSeal.length > 0) {
    await sealGraphTitles(toSeal, githubLogin);
  }
}

/**
 * Seal any unsealed graph titles with accountKey v2 (flag-on path).
 * Requires unlocked session.
 */
export async function ensureAccountKeySealing(githubLogin, nodes) {
  if (!isZkUnlocked()) return;

  const payloadResp = await api('/api/zk/payloads')
    .then((r) => r.json())
    .catch(() => ({ payloads: [] }));
  const sealed = new Set((payloadResp.payloads ?? []).map((p) => p.issue_key));
  const toSeal = (nodes ?? []).filter(
    (n) => n.title != null && !sealed.has(n.key),
  );
  if (toSeal.length > 0) {
    await sealGraphTitles(toSeal, githubLogin);
  }
}

/**
 * Fetch title+body from GitHub and re-seal zk_payloads.
 */
export async function syncZkContentFromGitHub(nodes, githubLogin, githubToken) {
  const token = githubToken ?? getGithubUserToken();
  if (!token) return { synced: 0, skipped: 'no_token' };

  const keys = nodes.map((n) => n.key);
  const contentByKey = await fetchIssueContentMap(keys, token);
  await sealNodes(nodes, githubLogin, contentByKey);
  return { synced: contentByKey.size, skipped: null };
}

/**
 * Decrypt server-redacted titles for the current user.
 * @param {Array<{ key: string, title: string|null }>} nodes
 */
export async function applyZkDecryption(nodes, githubLogin) {
  const resp = await api('/api/zk/payloads');
  const { payloads } = await resp.json();
  const byKey = new Map((payloads ?? []).map((p) => [p.issue_key, p]));

  if (isZkUnlocked()) {
    const accountKey = getSessionAccountKey();
    const keys = { accountKey };
    if (await hasZkKeyPair(githubLogin)) {
      const { privateKey } = await ensureZkKeyPair(githubLogin);
      keys.privateKey = privateKey;
    }

    for (const node of nodes) {
      const row = byKey.get(node.key);
      if (!row) {
        if (node.title == null) node.title = '(sealed)';
        continue;
      }
      const v = parseEnvelopeVersion(row.encrypted_payload);
      if (v === 1 && !keys.privateKey) {
        node.title = '(needs migration)';
        continue;
      }
      try {
        const content = await openContentDual(keys, row.encrypted_payload);
        node.title = content.title ?? '(sealed)';
        if (content.body != null) node.body = content.body;
      } catch {
        node.title = '(decrypt error)';
      }
    }
    return;
  }

  const { privateKey } = await ensureZkKeyPair(githubLogin);

  for (const node of nodes) {
    const row = byKey.get(node.key);
    if (!row) {
      if (node.title == null) node.title = '(sealed)';
      continue;
    }
    try {
      const content = await openContent(privateKey, row.encrypted_payload);
      node.title = content.title ?? '(sealed)';
      if (content.body != null) node.body = content.body;
    } catch {
      node.title = '(decrypt error)';
    }
  }
}