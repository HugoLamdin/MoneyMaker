import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;

test("signal origin migration backfills existing records safely", { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  const schema = `signal_origin_test_${process.pid}_${Date.now()}`;

  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await client.query(`
      CREATE TABLE "quant_signals" (
        "action" text NOT NULL,
        "reason" text NOT NULL
      )
    `);
    await client.query(`
      INSERT INTO "quant_signals" ("action", "reason") VALUES
        ('SELL', 'Price fell at least 8.0% below the paper position''s average price.'),
        ('SELL', 'Price is below the moving average.'),
        ('BUY', 'Price fell at least 8.0% but this is not a protective sell.')
    `);

    const migration = await readFile(new URL("./0001_add_signal_origin.sql", import.meta.url), "utf8");
    await client.query(migration);
    const { rows } = await client.query(
      `SELECT "action", "reason", "origin" FROM "quant_signals" ORDER BY "action", "reason"`,
    );

    assert.deepEqual(rows.map(({ action, origin }) => [action, origin]), [
      ["BUY", "TREND_MODEL"],
      ["SELL", "STOP_LOSS"],
      ["SELL", "TREND_MODEL"],
    ]);
  } finally {
    await client.query("RESET search_path");
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    client.release();
    await pool.end();
  }
});