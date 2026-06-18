// zk-sync.js — seal-on-enable + decrypt-on-load (#142 S2)

import { api } from './auth.js';
import { ensureZkKeyPair, sealTitle, openTitle } from './zk-crypto.js';

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

/**
 * Seal visible graph titles into zk_payloads (call before enabling zk_opt_in).
 * @param {Array<{ key: string, title: string|null }>} nodes
 */
export async function sealGraphTitles(nodes, githubLogin) {
  const { publicKey, pubkeyFp } = await ensureZkKeyPair(githubLogin);
  const payloads = [];

  for (const node of nodes) {
    if (!node.title) continue;
    const encrypted_payload = await sealTitle(publicKey, node.title);
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
      node.title = await openTitle(privateKey, row.encrypted_payload);
    } catch {
      node.title = '(decrypt error)';
    }
  }
}