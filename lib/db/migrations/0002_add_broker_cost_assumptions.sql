CREATE TABLE IF NOT EXISTS "quant_broker_cost_assumptions" (
  "user_id" integer PRIMARY KEY REFERENCES "quant_users"("id"),
  "commission_per_order" double precision NOT NULL,
  "spread_bps_per_side" double precision NOT NULL,
  "slippage_bps_per_side" double precision NOT NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);