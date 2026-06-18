/** ZK mode helpers (#142). */

export async function userZkOptIn(
  db: D1Database,
  userId: number,
): Promise<boolean> {
  const row = await db
    .prepare(`SELECT zk_opt_in FROM users WHERE id = ?`)
    .bind(userId)
    .first<{ zk_opt_in: number }>();
  return row?.zk_opt_in === 1;
}

/** Issue keys that have at least one zk_payloads ciphertext row. */
export async function loadZkSealedIssueKeys(
  db: D1Database,
): Promise<Set<string>> {
  const rows = await db
    .prepare(`SELECT DISTINCT issue_key FROM zk_payloads`)
    .all<{ issue_key: string }>();
  return new Set((rows.results ?? []).map((r) => r.issue_key));
}

export async function isIssueZkSealed(
  db: D1Database,
  issueKey: string,
): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS one FROM zk_payloads WHERE issue_key = ? LIMIT 1`)
    .bind(issueKey)
    .first<{ one: number }>();
  return row != null;
}

/** Title written into issues.payload — null when issue content is sealed. */
export function d1PayloadTitle(
  title: string | null | undefined,
  issueKey: string,
  sealedKeys: ReadonlySet<string>,
): string | null {
  if (sealedKeys.has(issueKey)) return null;
  return title ?? null;
}

/** Wipe plaintext content from issues.payload after sealing. */
export async function scrubIssuePayloads(
  db: D1Database,
  issueKeys: string[],
): Promise<void> {
  const unique = [...new Set(issueKeys)];
  for (let i = 0; i < unique.length; i += 90) {
    const chunk = unique.slice(i, i + 90);
    const ph = chunk.map(() => "?").join(",");
    await db
      .prepare(`UPDATE issues SET payload = json_object() WHERE key IN (${ph})`)
      .bind(...chunk)
      .run();
  }
}