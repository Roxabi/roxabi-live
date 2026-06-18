// zk-sync.js — seal-on-enable + decrypt-on-load + GitHub content sync (#142 S2/S3)

import { api } from './auth.js';
import { ensureZkKeyPair, sealContent, openContent } from './zk-crypto.js';
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
  const { publicKey, pubkeyFp } = await ensureZkKeyPair(githubLogin);
  const payloads = [];

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

  if (payloads.length > 0) {
    await putPayloadBatches(payloads);
  }
}

/**
 * Seal visible graph titles into zk_payloads (call before enabling zk_opt_in).
 * @param {Array<{ key: string, title: string|null }>} nodes
 */
export async function sealGraphTitles(nodes, githubLogin) {
  await sealNodes(nodes, githubLogin, null);
}

/**
 * Fetch title+body from GitHub and re-seal zk_payloads (ZK users with user token).
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
 * Decrypt server-redacted titles for zk_opt_in users.
 * @param {Array<{ key: string, title: string|null }>} nodes
 */
export async function applyZkDecryption(nodes, githubLogin) {
  const resp = await api('/api/zk/payloads');
  const { payloads } = await resp.json();
  const byKey = new Map((payloads ?? []).map((p) => [p.issue_key, p]));
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