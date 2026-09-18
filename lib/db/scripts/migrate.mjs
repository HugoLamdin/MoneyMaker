import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL must be set");

const migrationsDirectory = fileURLToPath(new URL("../migrations", import.meta.url));
const migrationNames = (await readdir(migrationsDirectory))
  .filter((name) => name.endsWith(".sql"))
  .sort();
const pool = new Pool({ connectionString: databaseUrl });
const client = await pool.connect();

try {
  await client.query(`
    CREATE TABLE IF NOT EXISTS "_workspace_migrations" (
      "name" text PRIMARY KEY,
      "applied_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);

  for (const name of migrationNames) {
    await client.query("BEGIN");
    try {
      const claimed = await client.query(
        `INSERT INTO "_workspace_migrations" ("name")
         VALUES ($1)
         ON CONFLICT DO NOTHING
         RETURNING "name"`,
        [name],
      );
      if (claimed.rowCount === 1) {
        await client.query(await readFile(path.join(migrationsDirectory, name), "utf8"));
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
} finally {
  client.release();
  await pool.end();
}