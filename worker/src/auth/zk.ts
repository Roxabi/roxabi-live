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