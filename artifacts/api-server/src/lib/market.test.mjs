import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  attachPriceRevisionAudit,
  assertNoMaterialPriceRevisions,
  findMaterialPriceRevisions,
  refreshMarketHistory,
  validateSnapshot,
} from "../../scripts/import-market-history.mjs";
import {
  buildMarketAssets,
  CRYPTO_TRADING_COSTS,
  compareCustomTradingCosts,
  findExecutionCostThreshold,
  getSnapshotAgeDays,
  passesBenchmarkApprovalPolicy,
  planBuyAllocations,
  runBacktest,
  simulateDeterministicFixture,
} from "./market.ts";

test("finds the highest passing execution-cost point without changing the selected winner", () => {
  const selectedStrategyId = "fixed-development-winner";
  const evaluatedStrategyIds = [];
  const exactThreshold = 3.4567;
  const threshold = findExecutionCostThreshold(
    selectedStrategyId,
    (multiplier, strategyId) => {
      evaluatedStrategyIds.push(strategyId);
      return multiplier <= exactThreshold;
    },
  );

  assert.equal(threshold.status, "FOUND");
  assert.ok(threshold.maximumPassingMultiplier !== null);
  const passesFixturePolicy = (multiplier) => multiplier <= exactThreshold;
  assert.equal(passesFixturePolicy(threshold.maximumPassingMultiplier), true);
  assert.equal(
    passesFixturePolicy(threshold.maximumPassingMultiplier + threshold.precisionMultiplier),
    false,
  );
  assert.ok(evaluatedStrategyIds.length > 2);
  assert.deepEqual(new Set(evaluatedStrategyIds), new Set([selectedStrategyId]));
});

test("reports a lower bound when the fixed winner remains safe at the search ceiling", () => {
  const evaluatedStrategyIds = [];
  const threshold = findExecutionCostThreshold(
    "upper-bound-winner",
    (_multiplier, strategyId) => {
      evaluatedStrategyIds.push(strategyId);
      return true;
    },
  );

  assert.deepEqual(threshold, {
    status: "ABOVE_SEARCH_BOUND",
    maximumPassingMultiplier: 10,
    lowerBoundMultiplier: 0,
    upperBoundMultiplier: 10,
    precisionMultiplier: 0.001,
  });
  assert.deepEqual(evaluatedStrategyIds, ["upper-bound-winner", "upper-bound-winner"]);
});

test("reports no passing level when the fixed winner fails with zero broker-controlled costs", () => {
  const evaluatedMultipliers = [];
  const threshold = findExecutionCostThreshold(
    "failing-winner",
    (multiplier, strategyId) => {
      assert.equal(strategyId, "failing-winner");
      evaluatedMultipliers.push(multiplier);
      return false;
    },
  );

  assert.equal(threshold.status, "NO_PASSING_LEVEL");
  assert.equal(threshold.maximumPassingMultiplier, null);
  assert.deepEqual(evaluatedMultipliers, [0]);
});

const snapshot = JSON.parse(
  await readFile(new URL("../data/uk-adjusted-history.json", import.meta.url), "utf8"),
);
validateSnapshot(snapshot);

function nextIsoDate(date) {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

test("trusted market assets include GBP crypto with explicit metadata and costs", () => {
  const assets = buildMarketAssets({
    maxPositionPercent: 25,
    stopLossPercent: 10,
    cashReservePercent: 20,
  });
  const bitcoin = assets.find((item) => item.symbol === "BTC-GBP");
  const ethereum = assets.find((item) => item.symbol === "ETH-GBP");
  assert.equal(bitcoin?.assetClass, "CRYPTO");
  assert.equal(bitcoin?.executionCalendar, "CRYPTO_24_7");
  assert.ok((bitcoin?.price ?? 0) > 1_000);
  assert.equal(ethereum?.assetClass, "CRYPTO");
  assert.equal(CRYPTO_TRADING_COSTS.stampDutyBpsOnBuys, 0);
});

function providerFetchFor(replacement, mutateResponse = () => {}) {
  const tickerToSymbol = Object.fromEntries(
    Object.entries(replacement.metadata.tickers).map(([symbol, ticker]) => [ticker, symbol]),
  );
  return async (url) => {
    const ticker = decodeURIComponent(new URL(url).pathname.split("/").at(-1));
    const symbol = tickerToSymbol[ticker];
    const result = {
      meta: {
        symbol: ticker,
        exchangeTimezoneName: replacement.metadata.timezones?.[symbol] ?? "Europe/London",
      },
      timestamp: replacement.dates.map((date) => Date.parse(`${date}T12:00:00Z`) / 1000),
      indicators: { adjclose: [{ adjclose: [...replacement.series[symbol]] }] },
    };
    mutateResponse({ symbol, result });
    return { ok: true, json: async () => ({ chart: { result: [result], error: null } }) };
  };
}

async function withTemporarySnapshot(run) {
  const directory = await mkdtemp(join(tmpdir(), "market-refresh-"));
  const destinationPath = join(directory, "history.json");
  const originalBytes = `${JSON.stringify(snapshot, null, 2)}\n`;
  await writeFile(destinationPath, originalBytes, "utf8");
  try {
    await run({ destinationPath, originalBytes });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function assertTemporaryFileRemoved(destinationPath) {
  const temporaryPrefix = `${destinationPath.split("/").at(-1)}.tmp-`;
  assert.deepEqual(
    (await readdir(destinationPath.slice(0, destinationPath.lastIndexOf("/"))))
      .filter((name) => name.startsWith(temporaryPrefix)),
    [],
  );
}

function fileSystemFailing(stage, message = `${stage} failed`) {
  return {
    readFile: async (path, encoding) => {
      if (stage === "validation-read" && String(path).includes(".tmp-")) throw new Error(message);
      return readFile(path, encoding);
    },
    writeFile: async (...args) => {
      if (stage === "write") throw new Error(message);
      return writeFile(...args);
    },
    rename: async (...args) => {
      if (stage === "rename") throw new Error(message);
      return rename(...args);
    },
    rm: async (...args) => {
      if (stage === "cleanup") throw new Error(message);
      return rm(...args);
    },
  };
}

test("does not create cash when current cash is below the reserve target", () => {
  const allocations = planBuyAllocations(
    1_000,
    10_000,
    { maxPositionPercent: 25, cashReservePercent: 20 },
    [{ symbol: "SHEL", existingValue: 0 }],
  );
  assert.equal(allocations.get("SHEL"), 0);
});

test("allocates nothing when there are no eligible pending purchases", () => {
  const allocations = planBuyAllocations(
    5_000,
    10_000,
    { maxPositionPercent: 25, cashReservePercent: 20 },
    [],
  );
  assert.equal(allocations.size, 0);
});

test("shares spendable cash across multiple buys without breaching reserve", () => {
  const allocations = planBuyAllocations(
    10_000,
    10_000,
    { maxPositionPercent: 50, cashReservePercent: 20 },
    [{ symbol: "SHEL", existingValue: 0 }, { symbol: "AZN", existingValue: 0 }],
  );
  const spent = [...allocations.values()].reduce((sum, value) => sum + value, 0);
  assert.equal(allocations.get("SHEL"), 4_000);
  assert.equal(allocations.get("AZN"), 4_000);
  assert.equal(10_000 - spent, 2_000);
});

test("enforces the cap after accounting for an existing holding", () => {
  const allocations = planBuyAllocations(
    5_000,
    10_000,
    { maxPositionPercent: 25, cashReservePercent: 20 },
    [{ symbol: "SHEL", existingValue: 2_400 }],
  );
  assert.equal(allocations.get("SHEL"), 100);
});

test("executes close-derived buy signals exactly one session later and never buys FTSE", () => {
  const trace = simulateDeterministicFixture(
    {
      FTSE: [100, 100, 130, 140, 150],
      SHEL: [100, 100, 130, 140, 150],
      AZN: [100, 100, 100, 100, 100],
      HSBA: [100, 100, 100, 100, 100],
      ULVR: [100, 100, 100, 100, 100],
    },
    { maxPositionPercent: 25, stopLossPercent: 10, cashReservePercent: 20 },
    { movingAverageSessions: 2, signalBandPercent: 5 },
  );
  assert.deepEqual(
    trace.executions.map(({ session, symbol, action, price }) => ({ session, symbol, action, price })),
    [{ session: 3, symbol: "SHEL", action: "BUY", price: 140 }],
  );
  assert.deepEqual(trace.finalPositionSymbols, ["SHEL"]);
  assert.ok(trace.executions.every((execution) => execution.symbol !== "FTSE"));
});

test("delays a close-derived stop-loss exit until the next available session", () => {
  const trace = simulateDeterministicFixture(
    {
      FTSE: [100, 100, 100, 100, 100, 100],
      SHEL: [100, 100, 130, 140, 120, 115],
      AZN: [100, 100, 100, 100, 100, 100],
      HSBA: [100, 100, 100, 100, 100, 100],
      ULVR: [100, 100, 100, 100, 100, 100],
    },
    { maxPositionPercent: 25, stopLossPercent: 10, cashReservePercent: 20 },
    { movingAverageSessions: 2, signalBandPercent: 50 },
  );
  assert.deepEqual(trace.executions, []);

  const signalTrace = simulateDeterministicFixture(
    {
      FTSE: [100, 100, 100, 100, 100, 100],
      SHEL: [100, 100, 130, 140, 120, 115],
      AZN: [100, 100, 100, 100, 100, 100],
      HSBA: [100, 100, 100, 100, 100, 100],
      ULVR: [100, 100, 100, 100, 100, 100],
    },
    { maxPositionPercent: 25, stopLossPercent: 10, cashReservePercent: 20 },
    { movingAverageSessions: 2, signalBandPercent: 5 },
  );
  assert.deepEqual(
    signalTrace.executions.map(({ session, action, price, reason }) => ({ session, action, price, reason })),
    [
      { session: 3, action: "BUY", price: 140, reason: "SIGNAL" },
      { session: 5, action: "SELL", price: 115, reason: "STOP_LOSS" },
    ],
  );
});

test("charges an exact UK buy and sell cost ledger without breaching the cash reserve", () => {
  const costs = {
    currency: "GBP",
    commissionPerOrder: 10,
    spreadBpsPerSide: 100,
    slippageBpsPerSide: 200,
    stampDutyBpsOnBuys: 300,
    description: "Deterministic test costs",
  };
  const trace = simulateDeterministicFixture(
    {
      FTSE: [100, 100, 100, 100, 100],
      SHEL: [100, 100, 130, 100, 100],
      AZN: [100, 100, 100, 100, 100],
      HSBA: [100, 100, 100, 100, 100],
      ULVR: [100, 100, 100, 100, 100],
    },
    { maxPositionPercent: 10.7, stopLossPercent: 50, cashReservePercent: 20 },
    { movingAverageSessions: 2, signalBandPercent: 5 },
    costs,
  );

  assert.deepEqual(
    trace.executions.map(({ action, notional, transactionCost, cashAfter }) => ({
      action,
      notional,
      transactionCost,
      cashAfter,
    })),
    [
      { action: "BUY", notional: 1_000, transactionCost: 70, cashAfter: 8_930 },
      { action: "SELL", notional: 1_000, transactionCost: 40, cashAfter: 9_890 },
    ],
  );
  assert.equal(trace.executions[0].transactionCost, 10 + 10 + 20 + 30);
  assert.equal(trace.executions[1].transactionCost, 10 + 10 + 20);
  assert.equal(trace.tradingCosts, 110);
  assert.ok(trace.executions.every((execution) => execution.cashAfter >= trace.cashReserve));
  assert.equal(trace.finalCash, 9_890);
  assert.equal(trace.finalValue, 9_890);
  assert.equal(trace.returnPercent, -1.1);
  assert.equal(trace.benchmarkReturnPercent, 0);
  assert.equal(
    passesBenchmarkApprovalPolicy(trace.returnPercent, trace.benchmarkReturnPercent),
    false,
  );
});

test("real-history strategy selection uses development data and gates on untouched holdout data", () => {
  const result = runBacktest({
    maxPositionPercent: 25,
    stopLossPercent: 8,
    cashReservePercent: 20,
  });
  assert.equal(result.dataSource, "Yahoo Finance chart API");
  assert.equal(result.priceField, "adjusted close");
  assert.equal(result.snapshotAsOfDate, result.endDate);
  const ageCheck = result.safetyChecks.find((check) => check.label === "Snapshot age (days)");
  assert.equal(ageCheck?.actual, result.snapshotAgeDays);
  assert.equal(ageCheck?.passed, result.snapshotAgeDays <= 7);
  assert.equal(result.executionLagSessions, 1);
  assert.equal(result.methodology.holdoutStartDate, "2024-01-02");
  assert.equal(result.startDate, result.methodology.holdoutStartDate);
  assert.equal(result.candidates.length, 5);
  assert.equal(result.candidates.filter((candidate) => candidate.selected).length, 1);
  assert.ok(result.periodDays >= 450);
  assert.deepEqual(result.regimes.map((item) => item.regime), ["SIDEWAYS", "BEAR", "BULL"]);
  assert.ok(result.closedTrades >= 8);
  const drawdownCheck = result.safetyChecks.find((check) => check.label === "Maximum drawdown");
  assert.equal(drawdownCheck?.actual, result.maxDrawdownPercent);
  assert.equal(drawdownCheck?.passed, result.maxDrawdownPercent <= 20);
  assert.equal(result.returnPercent, result.netReturnPercent);
  assert.equal(result.finalValue, result.netFinalValue);
  assert.ok(result.grossReturnPercent >= result.netReturnPercent);
  assert.ok(result.tradingCosts > 0);
  assert.equal(result.costAssumptions.stampDutyBpsOnBuys, 50);
  assert.equal(result.defaultSafetyScenario, "BASE");
  assert.deepEqual(result.costScenarios.map((scenario) => scenario.id), ["LOW", "BASE", "HIGH"]);
  const [lowCost, baseCost, highCost] = result.costScenarios;
  assert.equal(baseCost.netReturnPercent, result.netReturnPercent);
  assert.equal(baseCost.tradingCosts, result.tradingCosts);
  assert.equal(baseCost.safetyPassed, result.safetyPassed);
  assert.ok(lowCost.netReturnPercent >= baseCost.netReturnPercent);
  assert.ok(baseCost.netReturnPercent >= highCost.netReturnPercent);
  assert.ok(lowCost.tradingCosts <= baseCost.tradingCosts);
  assert.ok(baseCost.tradingCosts <= highCost.tradingCosts);
  assert.ok(result.costScenarios.every((scenario) => scenario.assumptions.description.length > 0));
  assert.equal(result.executionCostThreshold.lowerBoundMultiplier, 0);
  assert.equal(result.executionCostThreshold.upperBoundMultiplier, 10);
  assert.equal(result.executionCostThreshold.precisionMultiplier, 0.001);
  assert.match(result.executionCostThreshold.explanation, /fixed development winner|development winner is fixed/i);
  if (result.executionCostThreshold.maximumPassingMultiplier === null) {
    assert.equal(result.executionCostThreshold.status, "NO_PASSING_LEVEL");
    assert.equal(result.executionCostThreshold.headroomFromBaseMultiplier, null);
    assert.equal(result.executionCostThreshold.thresholdAssumptions, null);
  } else {
    assert.equal(
      result.executionCostThreshold.headroomFromBaseMultiplier,
      Number((result.executionCostThreshold.maximumPassingMultiplier - 1).toFixed(3)),
    );
    assert.equal(result.executionCostThreshold.thresholdAssumptions.stampDutyBpsOnBuys, 50);
    assert.equal(
      result.executionCostThreshold.thresholdAssumptions.commissionPerOrder,
      Number((result.costAssumptions.commissionPerOrder * result.executionCostThreshold.maximumPassingMultiplier).toFixed(3)),
    );
  }
  assert.ok(result.candidates.every((candidate) =>
    candidate.developmentGrossReturnPercent >= candidate.developmentNetReturnPercent
    && candidate.holdoutGrossReturnPercent >= candidate.holdoutNetReturnPercent
  ));
  const returnCheck = result.safetyChecks.find((check) => check.label === "Net total return");
  assert.equal(returnCheck?.actual, result.netReturnPercent);
  const benchmarkCheck = result.safetyChecks.find((check) => check.label === "Excess return vs FTSE");
  assert.equal(benchmarkCheck?.actual, result.excessReturnPercent);
  assert.equal(benchmarkCheck?.limit, 0);
  assert.equal(benchmarkCheck?.comparison, "GT");
  assert.equal(benchmarkCheck?.passed, result.excessReturnPercent > 0);
  assert.equal(result.benchmarkPolicy.benchmark, "FTSE 100");
  assert.equal(result.benchmarkPolicy.requiredMinimumExcessReturnPercent, 0);
  assert.equal(result.benchmarkPolicy.passed, benchmarkCheck?.passed);
  assert.equal(result.benchmarkPolicy.passed, false);
  assert.equal(result.safetyPassed, false);
  assert.equal(result.safetyPassed, result.safetyChecks.every((check) => check.passed));
  const selected = result.candidates.find((candidate) => candidate.selected);
  const assets = buildMarketAssets({
    maxPositionPercent: 25,
    stopLossPercent: 8,
    cashReservePercent: 20,
  });
  assert.ok(selected);
  assert.ok(assets.every((asset) => asset.movingAverageSessions === selected.movingAverageSessions));
  assert.ok(assets.every((asset) => asset.signalBandPercent === selected.signalBandPercent));
  assert.equal(selected.stopLossPercent, 8);
  assert.equal(selected.cashReservePercent, 20);
});

test("custom broker costs compare the fixed development winner without controlling safety", () => {
  const settings = {
    maxPositionPercent: 25,
    stopLossPercent: 8,
    cashReservePercent: 20,
  };
  const base = runBacktest(settings);
  const custom = compareCustomTradingCosts(settings, {
    commissionPerOrder: 7.5,
    spreadBpsPerSide: 4,
    slippageBpsPerSide: 6,
  });

  assert.equal(custom.id, "CUSTOM");
  assert.equal(custom.comparisonOnly, true);
  assert.equal(custom.controlsSafetyGate, false);
  assert.equal(custom.assumptions.stampDutyBpsOnBuys, 50);
  assert.match(custom.assumptions.description, /£7\.5 commission/);
  assert.equal(base.defaultSafetyScenario, "BASE");
  assert.deepEqual(base.costScenarios.map((scenario) => scenario.id), ["LOW", "BASE", "HIGH"]);
});

test("benchmark approval requires strict outperformance at unrounded precision", () => {
  assert.equal(passesBenchmarkApprovalPolicy(10, 10), false);
  assert.equal(passesBenchmarkApprovalPolicy(9.9999, 10), false);
  assert.equal(passesBenchmarkApprovalPolicy(10.0001, 10), true);
});

test("rejects a history snapshot without minimum common-date coverage", () => {
  const incomplete = structuredClone(snapshot);
  incomplete.dates = incomplete.dates.slice(0, 899);
  assert.throws(() => validateSnapshot(incomplete), /at least 900 required/);
});

test("rejects a history snapshot with an invalid adjusted price", () => {
  const invalid = structuredClone(snapshot);
  invalid.series.SHEL[100] = 0;
  assert.throws(() => validateSnapshot(invalid), /non-positive or non-finite adjusted price/);
});

test("rejects a history snapshot with a missing historical row", () => {
  const missing = structuredClone(snapshot);
  missing.series.AZN.pop();
  assert.throws(() => validateSnapshot(missing), /AZN does not have one price for every common date/);
});

test("rejects a history snapshot with misaligned date metadata", () => {
  const misaligned = structuredClone(snapshot);
  misaligned.metadata.endDate = misaligned.dates.at(-2);
  assert.throws(() => validateSnapshot(misaligned), /date range metadata does not match the common dates/);
});

test("accepts unchanged overlapping history while allowing new sessions", () => {
  const replacement = structuredClone(snapshot);
  const nextDate = nextIsoDate(snapshot.metadata.endDate);
  replacement.dates.push(nextDate);
  replacement.metadata.endDate = nextDate;
  replacement.metadata.sessions += 1;
  for (const prices of Object.values(replacement.series)) prices.push(prices.at(-1));
  assert.deepEqual(findMaterialPriceRevisions(snapshot, replacement), []);
  assert.doesNotThrow(() => assertNoMaterialPriceRevisions(snapshot, replacement));
});

test("rejects material revisions with a concise symbol and date summary", () => {
  const replacement = structuredClone(snapshot);
  replacement.series.SHEL[100] *= 1.01;
  replacement.series.AZN[200] *= 0.98;
  const revisions = findMaterialPriceRevisions(snapshot, replacement);
  assert.deepEqual(
    revisions.map(({ symbol, date }) => ({ symbol, date })),
    [
      { symbol: "SHEL", date: snapshot.dates[100] },
      { symbol: "AZN", date: snapshot.dates[200] },
    ],
  );
  assert.throws(
    () => assertNoMaterialPriceRevisions(snapshot, replacement),
    new RegExp(`SHEL ${snapshot.dates[100]} 1\\.0%.*AZN ${snapshot.dates[200]} 2\\.0%.*--allow-price-revisions`),
  );
});

test("records approved material revisions with their review details", () => {
  const replacement = structuredClone(snapshot);
  replacement.series.SHEL[100] *= 0.98;
  attachPriceRevisionAudit(
    snapshot,
    replacement,
    findMaterialPriceRevisions(snapshot, replacement),
    "2026-09-18",
  );
  const [auditRecord] = replacement.metadata.priceRevisionAudit;
  assert.deepEqual(auditRecord, {
    symbol: "SHEL",
    date: snapshot.dates[100],
    oldPrice: snapshot.series.SHEL[100],
    newPrice: replacement.series.SHEL[100],
    percentageChange: auditRecord.percentageChange,
    approvalDate: "2026-09-18",
  });
  assert.ok(Math.abs(auditRecord.percentageChange + 2) < 1e-12);
  assert.doesNotThrow(() => validateSnapshot(replacement));
});

test("does not add audit noise when prices have no material revisions", () => {
  const replacement = structuredClone(snapshot);
  attachPriceRevisionAudit(snapshot, replacement, [], "2026-09-18");
  assert.equal(replacement.metadata.priceRevisionAudit, undefined);
});

test("ignores immaterial provider rounding differences", () => {
  const replacement = structuredClone(snapshot);
  replacement.series.HSBA[300] *= 1.009;
  assert.deepEqual(findMaterialPriceRevisions(snapshot, replacement), []);
});

test("a structurally invalid provider refresh preserves the trusted snapshot bytes", async () => {
  await withTemporarySnapshot(async ({ destinationPath, originalBytes }) => {
    const fetchImpl = providerFetchFor(snapshot, ({ symbol, result }) => {
      if (symbol === "AZN") result.indicators.adjclose[0].adjclose.pop();
    });

    await assert.rejects(
      refreshMarketHistory({ destinationPath, fetchImpl }),
      /AZN adjusted-close data is missing or malformed/,
    );
    assert.equal(await readFile(destinationPath, "utf8"), originalBytes);
    await assertTemporaryFileRemoved(destinationPath);
  });
});

test("a material provider revision preserves the trusted snapshot bytes", async () => {
  await withTemporarySnapshot(async ({ destinationPath, originalBytes }) => {
    const replacement = structuredClone(snapshot);
    replacement.series.SHEL[100] *= 1.02;

    await assert.rejects(
      refreshMarketHistory({
        destinationPath,
        fetchImpl: providerFetchFor(replacement),
      }),
      /SHEL .* 2\.0%.*--allow-price-revisions/,
    );
    assert.equal(await readFile(destinationPath, "utf8"), originalBytes);
    await assertTemporaryFileRemoved(destinationPath);
  });
});

for (const stage of ["write", "validation-read", "rename"]) {
  test(`a ${stage} failure preserves the trusted snapshot and removes its temporary file`, async () => {
    await withTemporarySnapshot(async ({ destinationPath, originalBytes }) => {
      await assert.rejects(
        refreshMarketHistory({
          destinationPath,
          fetchImpl: providerFetchFor(snapshot),
          fileSystem: fileSystemFailing(stage),
        }),
        new RegExp(`${stage} failed`),
      );
      assert.equal(await readFile(destinationPath, "utf8"), originalBytes);
      await assertTemporaryFileRemoved(destinationPath);
    });
  });
}

test("a cleanup failure is reported without changing the trusted snapshot", async () => {
  await withTemporarySnapshot(async ({ destinationPath, originalBytes }) => {
    const fileSystem = fileSystemFailing("cleanup");
    fileSystem.readFile = async (path, encoding) => {
      if (String(path).includes(".tmp-")) throw new Error("validation-read failed");
      return readFile(path, encoding);
    };

    await assert.rejects(
      refreshMarketHistory({
        destinationPath,
        fetchImpl: providerFetchFor(snapshot),
        fileSystem,
      }),
      /validation-read failed; temporary-file cleanup also failed: cleanup failed/,
    );
    assert.equal(await readFile(destinationPath, "utf8"), originalBytes);
    const [temporaryName] = (await readdir(destinationPath.slice(0, destinationPath.lastIndexOf("/"))))
      .filter((name) => name.startsWith(`${destinationPath.split("/").at(-1)}.tmp-`));
    assert.equal(
      JSON.parse(await readFile(join(destinationPath.slice(0, destinationPath.lastIndexOf("/")), temporaryName), "utf8"))
        .metadata.source,
      snapshot.metadata.source,
    );
  });
});

test("a rename failure remains clear when cleanup also fails", async () => {
  await withTemporarySnapshot(async ({ destinationPath, originalBytes }) => {
    const fileSystem = fileSystemFailing("rename", "rename failed with EACCES");
    fileSystem.rm = async () => {
      throw new Error("cleanup failed with EBUSY");
    };

    await assert.rejects(
      refreshMarketHistory({
        destinationPath,
        fetchImpl: providerFetchFor(snapshot),
        fileSystem,
      }),
      /rename failed with EACCES; temporary-file cleanup also failed: cleanup failed with EBUSY/,
    );
    assert.equal(await readFile(destinationPath, "utf8"), originalBytes);
  });
});

test("a successful provider refresh replaces the snapshot and removes its temporary file", async () => {
  await withTemporarySnapshot(async ({ destinationPath, originalBytes }) => {
    const replacement = structuredClone(snapshot);
    const nextDate = nextIsoDate(snapshot.metadata.endDate);
    replacement.dates.push(nextDate);
    replacement.metadata.endDate = nextDate;
    replacement.metadata.sessions += 1;
    for (const prices of Object.values(replacement.series)) prices.push(prices.at(-1));

    const imported = await refreshMarketHistory({
      destinationPath,
      fetchImpl: providerFetchFor(replacement),
    });
    const replacementBytes = await readFile(destinationPath, "utf8");

    assert.notEqual(replacementBytes, originalBytes);
    assert.deepEqual(JSON.parse(replacementBytes), imported);
    assert.equal(imported.metadata.sessions, snapshot.metadata.sessions + 1);
    assert.equal(imported.metadata.endDate, nextDate);
    await assertTemporaryFileRemoved(destinationPath);
  });
});

test("overlapping refreshes use isolated temporary files and leave a valid trusted snapshot", async () => {
  await withTemporarySnapshot(async ({ destinationPath }) => {
    const firstReplacement = structuredClone(snapshot);
    const secondReplacement = structuredClone(snapshot);
    const firstDate = nextIsoDate(snapshot.metadata.endDate);
    const secondDate = nextIsoDate(firstDate);

    for (const [replacement, nextDate] of [
      [firstReplacement, firstDate],
      [secondReplacement, secondDate],
    ]) {
      replacement.dates.push(nextDate);
      replacement.metadata.endDate = nextDate;
      replacement.metadata.sessions += 1;
      for (const prices of Object.values(replacement.series)) prices.push(prices.at(-1));
    }

    const stagedPaths = [];
    let releaseValidationReads;
    const validationReadsReleased = new Promise((resolve) => {
      releaseValidationReads = resolve;
    });
    let bothStagedResolve;
    const bothStaged = new Promise((resolve) => {
      bothStagedResolve = resolve;
    });
    const overlappingFileSystem = {
      readFile: async (path, encoding) => {
        if (String(path).includes(".tmp-")) {
          stagedPaths.push(String(path));
          if (stagedPaths.length === 2) bothStagedResolve();
          await validationReadsReleased;
        }
        return readFile(path, encoding);
      },
      writeFile,
      rename,
      rm,
    };

    const refreshes = [
      refreshMarketHistory({
        destinationPath,
        fetchImpl: providerFetchFor(firstReplacement),
        fileSystem: overlappingFileSystem,
      }),
      refreshMarketHistory({
        destinationPath,
        fetchImpl: providerFetchFor(secondReplacement),
        fileSystem: overlappingFileSystem,
      }),
    ];

    await bothStaged;
    assert.equal(new Set(stagedPaths).size, 2);
    releaseValidationReads();
    const importedSnapshots = await Promise.all(refreshes);
    const trustedSnapshot = JSON.parse(await readFile(destinationPath, "utf8"));

    assert.doesNotThrow(() => validateSnapshot(trustedSnapshot));
    assert.ok(importedSnapshots.some((candidate) =>
      candidate.metadata.endDate === trustedSnapshot.metadata.endDate
      && candidate.metadata.sessions === trustedSnapshot.metadata.sessions));
    await assertTemporaryFileRemoved(destinationPath);
  });
});

test("calculates fresh and stale snapshot ages at the seven-day safety boundary", () => {
  const now = Date.parse("2026-09-18T12:00:00Z");
  assert.equal(getSnapshotAgeDays("2026-09-11", now), 6);
  assert.equal(getSnapshotAgeDays("2026-09-10", now), 7);
  assert.equal(getSnapshotAgeDays("2026-09-09", now), 8);
});