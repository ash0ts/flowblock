import "./env";
// Media jobs run in the Python worker; this command reports pending work.
import { Pool } from "pg";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  const result = await pool.query(
    "SELECT kind,status,count(*) FROM jobs GROUP BY kind,status",
  );
  console.table(result.rows);
} finally {
  await pool.end();
}
