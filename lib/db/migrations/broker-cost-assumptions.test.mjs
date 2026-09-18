import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;

test("broker cost assumptions migration creates an idempotent user-owned table", { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  const schema = `broker_cost_assumptions_test_${process.pid}_${Date.now()}`;

  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await client.query(`CREATE TABLE "quant_users" ("id" integer PRIMARY KEY)`);

    const migration = await readFile(new URL("./0002_add_broker_cost_assumptions.sql", import.meta.url), "utf8");
    await client.query(migration);
    await client.query(migration);
    await client.query(`INSERT INTO "quant_users" ("id") VALUES (1)`);
    await client.query(`
      INSERT INTO "quant_broker_cost_assumptions"
        ("user_id", "commission_per_order", "spread_bps_per_side", "slippage_bps_per_side")
      VALUES (1, 7.5, 4, 6)
    `);

    const { rows } = await client.query(`
      SELECT "user_id", "commission_per_order", "spread_bps_per_side",
             "slippage_bps_per_side", "updated_at"
      FROM "quant_broker_cost_assumptions"
    `);
    assert.equal(rows.length, 1);
    assert.deepEqual(
      {
        userId: rows[0].user_id,
        commissionPerOrder: rows[0].commission_per_order,
        spreadBpsPerSide: rows[0].spread_bps_per_side,
        slippageBpsPerSide: rows[0].slippage_bps_per_side,
      },
      {
        userId: 1,
        commissionPerOrder: 7.5,
        spreadBpsPerSide: 4,
        slippageBpsPerSide: 6,
      },
    );
    assert.ok(rows[0].updated_at instanceof Date);

    await assert.rejects(
      client.query(`
        INSERT INTO "quant_broker_cost_assumptions"
          ("user_id", "commission_per_order", "spread_bps_per_side", "slippage_bps_per_side")
        VALUES (999, 1, 1, 1)
      `),
      /foreign key constraint/,
    );
  } finally {
    await client.query("ROLLBACK");
    await client.query("RESET search_path");
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    client.release();
    await pool.end();
  }
});