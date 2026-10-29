import { Pool, type PoolClient } from "pg";
const globalDb = globalThis as unknown as { flowblockPool?: Pool };
export function db(): Pool {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_NOT_CONFIGURED");
  return (globalDb.flowblockPool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 8,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000,
  }));
}
export async function transaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export async function consumeQuota(owner: string, kind: string, limit: number) {
  return transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `${owner}:${kind}`,
    ]);
    const result = await client.query<{ count: string }>(
      "SELECT count(*) FROM usage_events WHERE owner_id=$1 AND kind=$2 AND created_at > now()-interval '1 day'",
      [owner, kind],
    );
    if (Number(result.rows[0].count) >= limit) return false;
    await client.query(
      "INSERT INTO usage_events(owner_id,kind) VALUES($1,$2)",
      [owner, kind],
    );
    return true;
  });
}
