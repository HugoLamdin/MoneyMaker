ALTER TABLE "quant_signals"
ADD COLUMN IF NOT EXISTS "origin" text NOT NULL DEFAULT 'TREND_MODEL';

UPDATE "quant_signals"
SET "origin" = 'STOP_LOSS'
WHERE "action" = 'SELL'
  AND "reason" LIKE 'Price fell at least %';