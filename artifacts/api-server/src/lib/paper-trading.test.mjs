import assert from "node:assert/strict";
import test from "node:test";
import {
  isExecutionDue,
  nextExecutionSession,
  nextTradingSession,
  pendingSignalAssets,
  stopLossAssets,
} from "./paper-trading.ts";

const asset = (symbol, action, price = 100) => ({
  symbol,
  name: symbol,
  action,
  price,
  change: 0,
  changePercent: 0,
  sma50: 100,
  movingAverageSessions: 50,
  signalBandPercent: 1,
  trend: "NEUTRAL",
  chart: [],
  assetClass: symbol === "FTSE" ? "BENCHMARK" : symbol.endsWith("-GBP") ? "CRYPTO" : "EQUITY",
  executionCalendar: symbol.endsWith("-GBP") ? "CRYPTO_24_7" : "UK_COMMON_SESSION",
});

test("paper BUY and SELL signals are not due in their closing session", () => {
  const executeAfter = nextTradingSession("2026-09-18");
  assert.equal(executeAfter.toISOString(), "2026-09-21T00:00:00.000Z");
  assert.equal(isExecutionDue(executeAfter, "2026-09-18"), false);
  assert.equal(isExecutionDue(executeAfter, "2026-09-21"), true);
});

test("stop-loss exits use the same next-session eligibility rule", () => {
  const stopped = stopLossAssets(
    [asset("SHEL", "HOLD", 89), asset("AZN", "HOLD", 95)],
    [{ symbol: "SHEL", averagePrice: 100 }, { symbol: "AZN", averagePrice: 100 }],
    10,
  );
  assert.deepEqual(stopped.map(({ symbol }) => symbol), ["SHEL"]);
  assert.equal(isExecutionDue(nextTradingSession("2026-09-17"), "2026-09-17"), false);
});

test("FTSE remains excluded from signal and stop-loss paper orders", () => {
  assert.deepEqual(
    pendingSignalAssets([asset("FTSE", "BUY"), asset("SHEL", "BUY")]).map(({ symbol }) => symbol),
    ["SHEL"],
  );
  assert.deepEqual(
    stopLossAssets([asset("FTSE", "SELL", 80)], [{ symbol: "FTSE", averagePrice: 100 }], 10),
    [],
  );
});

test("crypto remains investable and schedules on the next calendar day", () => {
  assert.equal(
    nextExecutionSession("2026-09-18", "CRYPTO_24_7").toISOString(),
    "2026-09-19T00:00:00.000Z",
  );
  assert.deepEqual(
    pendingSignalAssets([asset("FTSE", "BUY"), asset("BTC-GBP", "BUY")]).map(({ symbol }) => symbol),
    ["BTC-GBP"],
  );
});