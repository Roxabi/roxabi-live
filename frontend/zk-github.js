// zk-github.js — browser-side GitHub user token + GraphQL relay (#142 S3)

import { api } from './auth.js';

const TOKEN_KEY = 'roxabi:gh-user-token';
const REAUTH_KEY = 'roxabi:zk-reauth-proof';

export function getGithubUserToken() {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function setGithubUserToken(token) {
  if (token) sessionStorage.setItem(TOKEN_KEY, token);
  else sessionStorage.removeItem(TOKEN_KEY);
}

export function getZkReauthProof() {
  return sessionStorage.getItem(REAUTH_KEY);
}

export function clearZkReauthProof() {
  sessionStorage.removeItem(REAUTH_KEY);
}

/** Consume ?zk_reauth= from URL after OAuth step-up redirect. */
export async function consumeZkReauthFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('zk_reauth');
  if (!code) return false;

  params.delete('zk_reauth');
  const qs = params.toString();
  const next = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`;
  window.history.replaceState({}, '', next);

  const resp = await api('/api/zk/consume-reauth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!resp.ok) return false;
  const { reauth_proof } = await resp.json();
  if (reauth_proof) sessionStorage.setItem(REAUTH_KEY, reauth_proof);
  return true;
}

/** Consume ?zk_handoff= from URL after OAuth redirect. */
export async function consumeZkHandoffFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('zk_handoff');
  if (!code) return false;

  params.delete('zk_handoff');
  const qs = params.toString();
  const next = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`;
  window.history.replaceState({}, '', next);

  const resp = await api('/api/zk/consume-handoff', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const { github_token } = await resp.json();
  setGithubUserToken(github_token);
  return true;
}

export function zkLoginUrl(redirect = '/') {
  const dest = encodeURIComponent(redirect);
  return `/login?zk=1&redirect=${dest}`;
}

/** Relay GraphQL to GitHub via Worker (CORS-safe). */
export async function githubGraphql(query, variables, githubToken) {
  const token = githubToken ?? getGithubUserToken();
  if (!token) throw new Error('github_user_token missing');

  const resp = await api('/api/zk/github/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-User-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await resp.json();
  if (body.errors) {
    throw new Error(body.errors[0]?.message ?? 'graphql error');
  }
  return body.data;
}

const ISSUE_CONTENT_QUERY = `
  query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      issue(number: $number) { title body }
    }
  }
`;

function parseIssueKey(key) {
  const hash = key.lastIndexOf('#');
  if (hash < 0) return null;
  const repo = key.slice(0, hash);
  const number = Number(key.slice(hash + 1));
  const slash = repo.indexOf('/');
  if (slash < 0 || !Number.isFinite(number)) return null;
  return {
    owner: repo.slice(0, slash),
    name: repo.slice(slash + 1),
    number,
  };
}

/**
 * Fetch title+body for issue keys (batched aliases, 25 per request).
 * @returns {Map<string, { title: string|null, body: string|null }>}
 */
export async function fetchIssueContentMap(issueKeys, githubToken) {
  const parsed = issueKeys
    .map((key) => ({ key, ...parseIssueKey(key) }))
    .filter((p) => p.owner && p.name && p.number);

  const out = new Map();
  const BATCH = 25;

  for (let i = 0; i < parsed.length; i += BATCH) {
    const chunk = parsed.slice(i, i + BATCH);
    const fields = chunk
      .map((p, idx) =>
        `i${idx}: repository(owner: ${JSON.stringify(p.owner)}, name: ${JSON.stringify(p.name)}) {
          issue(number: ${p.number}) { title body }
        }`,
      )
      .join('\n');
    const query = `query { ${fields} }`;
    const data = await githubGraphql(query, undefined, githubToken);
    chunk.forEach((p, idx) => {
      const issue = data?.[`i${idx}`]?.issue;
      if (issue) {
        out.set(p.key, {
          title: issue.title ?? null,
          body: issue.body ?? null,
        });
      }
    });
  }

  return out;
}