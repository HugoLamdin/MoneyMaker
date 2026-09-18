import historicalData from "../data/uk-adjusted-history.json" with { type: "json" };

export type MarketAsset = {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  sma50: number;
  movingAverageSessions: number;
  signalBandPercent: number;
  trend: "UPTREND" | "DOWNTREND" | "NEUTRAL";
  action: "BUY" | "SELL" | "HOLD";
  chart: number[];
  assetClass: "BENCHMARK" | "EQUITY" | "CRYPTO";
  executionCalendar: "UK_COMMON_SESSION" | "CRYPTO_24_7";
};

export type RiskSettings = {
  maxPositionPercent: number;
  stopLossPercent: number;
  cashReservePercent: number;
};

export type BacktestSummary = {
  dataSource: string;
  priceField: string;
  snapshotAsOfDate: string;
  snapshotAgeDays: number;
  startDate: string;
  endDate: string;
  executionLagSessions: number;
  periodDays: number;
  initialCapital: number;
  finalValue: number;
  returnPercent: number;
  grossFinalValue: number;
  grossReturnPercent: number;
  netFinalValue: number;
  netReturnPercent: number;
  tradingCosts: number;
  costAssumptions: TradingCostAssumptions;
  defaultSafetyScenario: "BASE";
  costScenarios: CostScenarioResult[];
  executionCostThreshold: {
    status: "FOUND" | "ABOVE_SEARCH_BOUND" | "NO_PASSING_LEVEL";
    maximumPassingMultiplier: number | null;
    headroomFromBaseMultiplier: number | null;
    thresholdAssumptions: TradingCostAssumptions | null;
    lowerBoundMultiplier: number;
    upperBoundMultiplier: number;
    precisionMultiplier: number;
    explanation: string;
  };
  benchmarkReturnPercent: number;
  excessReturnPercent: number;
  maxDrawdownPercent: number;
  winRatePercent: number;
  turnoverPercent: number;
  closedTrades: number;
  safetyPassed: boolean;
  safetyChecks: Array<{ label: string; passed: boolean; actual: number; limit: number; comparison: "MAX" | "MIN" | "GT" }>;
  benchmarkPolicy: {
    benchmark: "FTSE 100";
    requiredMinimumExcessReturnPercent: number;
    passed: boolean;
    rationale: string;
  };
  methodology: {
    splitDate: string;
    developmentStartDate: string;
    developmentEndDate: string;
    holdoutStartDate: string;
    holdoutEndDate: string;
    selectionRule: string;
    selectedStrategyId: string;
    selectedStrategyName: string;
  };
  candidates: Array<{
    id: string;
    name: string;
    movingAverageSessions: number;
    signalBandPercent: number;
    stopLossPercent: number;
    cashReservePercent: number;
    developmentGrossReturnPercent: number;
    developmentNetReturnPercent: number;
    developmentMaxDrawdownPercent: number;
    developmentTurnoverPercent: number;
    holdoutGrossReturnPercent: number;
    holdoutNetReturnPercent: number;
    holdoutBenchmarkReturnPercent: number;
    holdoutMaxDrawdownPercent: number;
    holdoutTurnoverPercent: number;
    selected: boolean;
  }>;
  regimes: Array<{
    regime: "BULL" | "BEAR" | "SIDEWAYS";
    startDate: string;
    endDate: string;
    sessions: number;
    returnPercent: number;
    benchmarkReturnPercent: number;
    maxDrawdownPercent: number;
  }>;
};

export type TradingCostAssumptions = {
  currency: "GBP";
  commissionPerOrder: number;
  spreadBpsPerSide: number;
  slippageBpsPerSide: number;
  stampDutyBpsOnBuys: number;
  description: string;
};

export type CostScenarioResult = {
  id: "LOW" | "BASE" | "HIGH";
  name: string;
  assumptions: TradingCostAssumptions;
  netFinalValue: number;
  netReturnPercent: number;
  tradingCosts: number;
  excessReturnPercent: number;
  maxDrawdownPercent: number;
  safetyPassed: boolean;
};

export type CustomTradingCostInput = Pick<
  TradingCostAssumptions,
  "commissionPerOrder" | "spreadBpsPerSide" | "slippageBpsPerSide"
>;
export type BuyCandidate = {
  symbol: string;
  existingValue: number;
};

export function planBuyAllocations(
  startingCash: number,
  totalValue: number,
  settings: Pick<RiskSettings, "maxPositionPercent" | "cashReservePercent">,
  candidates: BuyCandidate[],
): Map<string, number> {
  const allocations = new Map<string, number>();
  let availableToSpend = Math.max(0, startingCash - totalValue * (settings.cashReservePercent / 100));
  candidates.forEach((candidate, index) => {
    const positionCapacity = Math.max(
      0,
      totalValue * (settings.maxPositionPercent / 100) - candidate.existingValue,
    );
    const allocation = Math.min(positionCapacity, availableToSpend / (candidates.length - index));
    allocations.set(candidate.symbol, allocation);
    availableToSpend -= allocation;
  });
  return allocations;
}

const SYMBOLS = ["FTSE", "SHEL", "AZN", "HSBA", "ULVR", "BTC-GBP", "ETH-GBP"] as const;
type Symbol = (typeof SYMBOLS)[number];
const ASSET_CLASS: Record<Symbol, MarketAsset["assetClass"]> = {
  FTSE: "BENCHMARK", SHEL: "EQUITY", AZN: "EQUITY", HSBA: "EQUITY", ULVR: "EQUITY",
  "BTC-GBP": "CRYPTO", "ETH-GBP": "CRYPTO",
};
const INVESTABLE_SYMBOLS = SYMBOLS.filter((symbol) => ASSET_CLASS[symbol] !== "BENCHMARK");
type HistoricalSnapshot = {
  metadata: {
    source: string;
    importedAt: string;
    priceField: string;
    startDate: string;
    endDate: string;
    sessions: number;
    names: Record<string, string>;
  };
  dates: string[];
  series: Partial<Record<string, number[]>>;
};

const HISTORY = historicalData as HistoricalSnapshot;
const MAX_SNAPSHOT_AGE_DAYS = 7;
export function getMarketSessionDate(): string {
  return HISTORY.metadata.endDate;
}
export const UK_TRADING_COST_SCENARIOS = [
  {
    id: "LOW" as const,
    name: "Low cost",
    assumptions: {
      currency: "GBP" as const,
      commissionPerOrder: 0,
      spreadBpsPerSide: 2,
      slippageBpsPerSide: 2,
      stampDutyBpsOnBuys: 50,
      description: "Each UK share order pays no commission, 2 bps half-spread and 2 bps slippage; buys also pay 50 bps UK stamp duty.",
    },
  },
  {
    id: "BASE" as const,
    name: "Base cost",
    assumptions: {
      currency: "GBP" as const,
      commissionPerOrder: 5,
      spreadBpsPerSide: 5,
      slippageBpsPerSide: 5,
      stampDutyBpsOnBuys: 50,
      description: "Each UK share order pays £5 commission, 5 bps half-spread and 5 bps slippage; buys also pay 50 bps UK stamp duty.",
    },
  },
  {
    id: "HIGH" as const,
    name: "High cost",
    assumptions: {
      currency: "GBP" as const,
      commissionPerOrder: 10,
      spreadBpsPerSide: 10,
      slippageBpsPerSide: 10,
      stampDutyBpsOnBuys: 50,
      description: "Each UK share order pays £10 commission, 10 bps half-spread and 10 bps slippage; buys also pay 50 bps UK stamp duty.",
    },
  },
];
export const UK_TRADING_COSTS = UK_TRADING_COST_SCENARIOS[1].assumptions;
const EXECUTION_COST_THRESHOLD_UPPER_MULTIPLIER = 10;
const EXECUTION_COST_THRESHOLD_PRECISION = 0.001;
type ExecutionCostThresholdSearch = Pick<
  BacktestSummary["executionCostThreshold"],
  "status" | "maximumPassingMultiplier" | "lowerBoundMultiplier" | "upperBoundMultiplier" | "precisionMultiplier"
>;

export function findExecutionCostThreshold(
  selectedStrategyId: string,
  evaluate: (multiplier: number, selectedStrategyId: string) => boolean,
  upperBoundMultiplier = EXECUTION_COST_THRESHOLD_UPPER_MULTIPLIER,
  precisionMultiplier = EXECUTION_COST_THRESHOLD_PRECISION,
): ExecutionCostThresholdSearch {
  const lowerBoundMultiplier = 0;
  const zeroCostsPass = evaluate(lowerBoundMultiplier, selectedStrategyId);
  if (!zeroCostsPass) {
    return {
      status: "NO_PASSING_LEVEL",
      maximumPassingMultiplier: null,
      lowerBoundMultiplier,
      upperBoundMultiplier,
      precisionMultiplier,
    };
  }
  if (evaluate(upperBoundMultiplier, selectedStrategyId)) {
    return {
      status: "ABOVE_SEARCH_BOUND",
      maximumPassingMultiplier: upperBoundMultiplier,
      lowerBoundMultiplier,
      upperBoundMultiplier,
      precisionMultiplier,
    };
  }

  let lower = lowerBoundMultiplier;
  let upper = upperBoundMultiplier;
  while (upper - lower > precisionMultiplier) {
    const midpoint = (lower + upper) / 2;
    if (evaluate(midpoint, selectedStrategyId)) lower = midpoint;
    else upper = midpoint;
  }
  return {
    status: "FOUND",
    maximumPassingMultiplier: lower,
    lowerBoundMultiplier,
    upperBoundMultiplier,
    precisionMultiplier,
  };
}
export const CRYPTO_TRADING_COSTS: TradingCostAssumptions = {
  currency: "GBP",
  commissionPerOrder: 1,
  spreadBpsPerSide: 15,
  slippageBpsPerSide: 10,
  stampDutyBpsOnBuys: 0,
  description: "Crypto orders assume £1 commission, 15 bps half-spread and 10 bps slippage; UK stamp duty does not apply.",
};
const PRICE_HISTORY = Object.fromEntries(
  SYMBOLS.map((symbol) => {
    const series = HISTORY.series[symbol];
    if (!series || series.length !== HISTORY.dates.length) {
      throw new Error(`Trusted market history is missing aligned ${symbol} prices`);
    }
    return [
      symbol,
      series.map((price) => ASSET_CLASS[symbol] === "EQUITY" ? price / 100 : price),
    ];
  }),
) as Record<Symbol, number[]>;
const REGIME_WINDOWS = [
  { regime: "SIDEWAYS" as const, startDate: "2024-01-02", endDate: "2024-08-05" },
  { regime: "BEAR" as const, startDate: "2024-08-05", endDate: "2025-04-07" },
  { regime: "BULL" as const, startDate: "2025-04-07", endDate: HISTORY.metadata.endDate },
];
const HOLDOUT_START_DATE = "2024-01-02";
type StrategyRule = {
  id: string;
  name: string;
  movingAverageSessions: number;
  signalBandPercent: number;
};

export type SimulationExecution = {
  session: number;
  symbol: string;
  action: "BUY" | "SELL";
  price: number;
  reason: "SIGNAL" | "STOP_LOSS";
  notional: number;
  transactionCost: number;
  cashAfter: number;
};

type SimulationTrace = {
  executions: SimulationExecution[];
  finalPositionSymbols: string[];
  initialCapital: number;
  cashReserve: number;
  finalCash: number;
  finalValue: number;
  returnPercent: number;
  benchmarkReturnPercent: number;
  tradingCosts: number;
};
const STRATEGY_RULES: StrategyRule[] = [
  { id: "baseline-sma50", name: "Baseline SMA50", movingAverageSessions: 50, signalBandPercent: 1.4 },
  { id: "fast-sma20", name: "Fast SMA20", movingAverageSessions: 20, signalBandPercent: 1 },
  { id: "balanced-sma50", name: "Balanced SMA50", movingAverageSessions: 50, signalBandPercent: 0.5 },
  { id: "slow-sma100", name: "Slow SMA100", movingAverageSessions: 100, signalBandPercent: 0.5 },
  { id: "defensive-sma100", name: "Defensive SMA100", movingAverageSessions: 100, signalBandPercent: 1 },
];

function round(value: number, decimals = 2): number {
  return Number(value.toFixed(decimals));
}

export function getSnapshotAgeDays(asOfDate: string, now = Date.now()): number {
  return Math.max(
    0,
    Math.floor((now - Date.parse(`${asOfDate}T23:59:59Z`)) / 86_400_000),
  );
}

export function buildMarketHistory(): Record<string, number[]> {
  return Object.fromEntries(SYMBOLS.map((symbol) => [symbol, [...PRICE_HISTORY[symbol]]]));
}

function actionAt(history: number[], day: number, rule: StrategyRule): "BUY" | "SELL" | "HOLD" {
  if (day < rule.movingAverageSessions - 1) return "HOLD";
  const average = history
    .slice(day - rule.movingAverageSessions + 1, day + 1)
    .reduce((sum, value) => sum + value, 0) / rule.movingAverageSessions;
  const distance = ((history[day] - average) / average) * 100;
  return distance > rule.signalBandPercent ? "BUY" : distance < -rule.signalBandPercent ? "SELL" : "HOLD";
}

type SimulationResult = {
  periodDays: number;
  finalValue: number;
  returnPercent: number;
  benchmarkReturnPercent: number;
  maxDrawdownPercent: number;
  winRatePercent: number;
  turnoverPercent: number;
  closedTrades: number;
  tradingCosts: number;
  rawReturnPercent: number;
  rawBenchmarkReturnPercent: number;
};

export function transactionCost(
  notional: number,
  action: "BUY" | "SELL",
  costs: TradingCostAssumptions = UK_TRADING_COSTS,
): number {
  const variableBps = costs.spreadBpsPerSide
    + costs.slippageBpsPerSide
    + (action === "BUY" ? costs.stampDutyBpsOnBuys : 0);
  return costs.commissionPerOrder + notional * variableBps / 10_000;
}

export function affordableBuyNotional(
  totalBudget: number,
  costs: TradingCostAssumptions = UK_TRADING_COSTS,
): number {
  const variableRate = (
    costs.spreadBpsPerSide
    + costs.slippageBpsPerSide
    + costs.stampDutyBpsOnBuys
  ) / 10_000;
  return Math.max(0, (totalBudget - costs.commissionPerOrder) / (1 + variableRate));
}

function simulate(
  settings: RiskSettings,
  rule: StrategyRule,
  startDay: number,
  endDay: number,
  history: Record<Symbol, number[]> = PRICE_HISTORY,
  trace?: SimulationTrace,
  applyTradingCosts = true,
  costs: TradingCostAssumptions = UK_TRADING_COSTS,
): SimulationResult {
  const initialCapital = 10_000;
  let cash = initialCapital;
  let peak = initialCapital;
  let maxDrawdownPercent = 0;
  let tradedValue = 0;
  let wins = 0;
  let closedTrades = 0;
  let tradingCosts = 0;
  const positions = new Map<string, { quantity: number; entryPrice: number }>();
  let pendingOrders: Array<{ symbol: Symbol; action: "BUY" | "SELL"; reason: "SIGNAL" | "STOP_LOSS" }> = [];
  const investableSymbols = INVESTABLE_SYMBOLS.filter((symbol) => history[symbol]?.length);

  for (let day = startDay; day <= endDay; day += 1) {
    for (const order of pendingOrders.filter((item) => item.action === "SELL")) {
      const position = positions.get(order.symbol);
      if (!position) continue;
      const price = history[order.symbol][day];
      const proceeds = position.quantity * price;
       const assetCosts = ASSET_CLASS[order.symbol] === "CRYPTO" ? CRYPTO_TRADING_COSTS : costs;
       const cost = applyTradingCosts ? transactionCost(proceeds, "SELL", assetCosts) : 0;
      cash += proceeds - cost;
      tradingCosts += cost;
      tradedValue += proceeds;
      closedTrades += 1;
      if (price > position.entryPrice) wins += 1;
      positions.delete(order.symbol);
      trace?.executions.push({
        session: day,
        symbol: order.symbol,
        action: "SELL",
        price,
        reason: order.reason,
        notional: round(proceeds),
        transactionCost: round(cost),
        cashAfter: round(cash),
      });
    }

    const valueBeforeBuys = cash + [...positions.entries()].reduce(
      (sum, [symbol, position]) => sum + position.quantity * history[symbol as Symbol][day],
      0,
    );
    const buyOrders = pendingOrders
      .filter((item) => item.action === "BUY" && !positions.has(item.symbol))
      .map((item) => ({
        symbol: item.symbol,
        existingValue: 0,
        reason: item.reason,
      }));
    const allocations = planBuyAllocations(cash, valueBeforeBuys, settings, buyOrders);
    for (const order of buyOrders) {
      const allocation = allocations.get(order.symbol) ?? 0;
      if (allocation <= 0) continue;
      const price = history[order.symbol][day];
       const assetCosts = ASSET_CLASS[order.symbol] === "CRYPTO" ? CRYPTO_TRADING_COSTS : costs;
       const notional = applyTradingCosts ? affordableBuyNotional(allocation, assetCosts) : allocation;
      if (notional <= 0) continue;
       const cost = applyTradingCosts ? transactionCost(notional, "BUY", assetCosts) : 0;
      positions.set(order.symbol, { quantity: notional / price, entryPrice: price });
      cash -= notional + cost;
      tradingCosts += cost;
      tradedValue += notional;
      trace?.executions.push({
        session: day,
        symbol: order.symbol,
        action: "BUY",
        price,
        reason: order.reason,
        notional: round(notional),
        transactionCost: round(cost),
        cashAfter: round(cash),
      });
    }

    const nextOrders: Array<{ symbol: Symbol; action: "BUY" | "SELL"; reason: "SIGNAL" | "STOP_LOSS" }> = [];
    for (const symbol of investableSymbols) {
      const price = history[symbol][day];
      const action = actionAt(history[symbol], day, rule);
      const previousAction = actionAt(history[symbol], day - 1, rule);
      const position = positions.get(symbol);
      const stopped = position && price <= position.entryPrice * (1 - settings.stopLossPercent / 100);
      if (position && (stopped || (action === "SELL" && previousAction !== "SELL"))) {
        nextOrders.push({ symbol, action: "SELL", reason: stopped ? "STOP_LOSS" : "SIGNAL" });
      } else if (!position && action === "BUY" && previousAction !== "BUY") {
        nextOrders.push({ symbol, action: "BUY", reason: "SIGNAL" });
      }
    }
    pendingOrders = nextOrders;

    const value = cash + [...positions.entries()].reduce(
      (sum, [symbol, position]) => sum + position.quantity * history[symbol as Symbol][day],
      0,
    );
    peak = Math.max(peak, value);
    maxDrawdownPercent = Math.max(maxDrawdownPercent, ((peak - value) / peak) * 100);
  }

  const finalValue = cash + [...positions.entries()].reduce(
    (sum, [symbol, position]) => sum + position.quantity * history[symbol as Symbol][endDay],
    0,
  );
  const returnPercent = ((finalValue - initialCapital) / initialCapital) * 100;
  const benchmarkReturnPercent = ((history.FTSE[endDay] - history.FTSE[startDay]) / history.FTSE[startDay]) * 100;
  const winRatePercent = closedTrades ? (wins / closedTrades) * 100 : 0;
  const turnoverPercent = (tradedValue / initialCapital) * 100;
  if (trace) {
    trace.finalPositionSymbols = [...positions.keys()];
    trace.finalCash = round(cash);
    trace.finalValue = round(finalValue);
    trace.returnPercent = round(returnPercent);
    trace.benchmarkReturnPercent = round(benchmarkReturnPercent);
    trace.tradingCosts = round(tradingCosts);
  }
  return {
    periodDays: endDay - startDay + 1,
    finalValue: round(finalValue),
    returnPercent: round(returnPercent),
    benchmarkReturnPercent: round(benchmarkReturnPercent),
    maxDrawdownPercent: round(maxDrawdownPercent),
    winRatePercent: round(winRatePercent),
    turnoverPercent: round(turnoverPercent),
    closedTrades,
    tradingCosts: round(tradingCosts),
    rawReturnPercent: returnPercent,
    rawBenchmarkReturnPercent: benchmarkReturnPercent,
  };
}

export function passesBenchmarkApprovalPolicy(
  strategyReturnPercent: number,
  benchmarkReturnPercent: number,
): boolean {
  return strategyReturnPercent > benchmarkReturnPercent;
}

export function simulateDeterministicFixture(
  history: Record<Symbol, number[]>,
  settings: RiskSettings,
  rule: Pick<StrategyRule, "movingAverageSessions" | "signalBandPercent">,
  costs: TradingCostAssumptions = UK_TRADING_COSTS,
): SimulationTrace {
  const fixtureSymbols = SYMBOLS.filter((symbol) => history[symbol]?.length);
  if (!fixtureSymbols.includes("FTSE")) {
    throw new Error("Fixture history must include the FTSE benchmark");
  }
  const lengths = fixtureSymbols.map((symbol) => history[symbol]?.length);
  if (lengths.some((length) => !length || length !== lengths[0])) {
    throw new Error("Fixture history must have one aligned price for every symbol and session");
  }
  const initialCapital = 10_000;
  const trace: SimulationTrace = {
    executions: [],
    finalPositionSymbols: [],
    initialCapital,
    cashReserve: initialCapital * settings.cashReservePercent / 100,
    finalCash: initialCapital,
    finalValue: initialCapital,
    returnPercent: 0,
    benchmarkReturnPercent: 0,
    tradingCosts: 0,
  };
  simulate(
    settings,
    { id: "deterministic-fixture", name: "Deterministic fixture", ...rule },
    0,
    lengths[0]! - 1,
    history,
    trace,
    true,
    costs,
  );
  return trace;
}

function evaluateDevelopmentCandidates(settings: RiskSettings) {
  const startDay = Math.max(...STRATEGY_RULES.map((rule) => rule.movingAverageSessions));
  const developmentEndDay = HISTORY.dates.indexOf(HOLDOUT_START_DATE) - 1;
  return STRATEGY_RULES.map((rule) => ({
    rule,
    settings,
    developmentGross: simulate(settings, rule, startDay, developmentEndDay, PRICE_HISTORY, undefined, false),
    developmentNet: simulate(settings, rule, startDay, developmentEndDay),
  }));
}

function selectDevelopmentWinner(settings: RiskSettings) {
  return [...evaluateDevelopmentCandidates(settings)].sort((a, b) =>
    b.developmentNet.returnPercent - a.developmentNet.returnPercent
    || a.developmentNet.maxDrawdownPercent - b.developmentNet.maxDrawdownPercent
    || a.developmentNet.turnoverPercent - b.developmentNet.turnoverPercent
  )[0];
}

function holdoutSafetyPassed(
  result: ReturnType<typeof simulate>,
  snapshotAgeDays: number,
  regimeCount: number,
) {
  const excessReturn = result.rawReturnPercent - result.rawBenchmarkReturnPercent;
  return snapshotAgeDays <= MAX_SNAPSHOT_AGE_DAYS
    && result.periodDays >= 450
    && result.maxDrawdownPercent <= 20
    && result.closedTrades >= 8
    && regimeCount >= 3
    && result.rawReturnPercent >= 0
    && excessReturn > 0;
}

function scaledExecutionCosts(multiplier: number): TradingCostAssumptions {
  const commissionPerOrder = UK_TRADING_COSTS.commissionPerOrder * multiplier;
  const spreadBpsPerSide = UK_TRADING_COSTS.spreadBpsPerSide * multiplier;
  const slippageBpsPerSide = UK_TRADING_COSTS.slippageBpsPerSide * multiplier;
  return {
    currency: "GBP",
    commissionPerOrder,
    spreadBpsPerSide,
    slippageBpsPerSide,
    stampDutyBpsOnBuys: UK_TRADING_COSTS.stampDutyBpsOnBuys,
    description: `Broker-controlled costs at ${round(multiplier, 3)}× base: £${round(commissionPerOrder, 3)} commission, ${round(spreadBpsPerSide, 3)} bps half-spread and ${round(slippageBpsPerSide, 3)} bps slippage per side; UK stamp duty remains fixed at 50 bps on buys.`,
  };
}

export function runBacktest(settings: RiskSettings): BacktestSummary {
  const startDay = Math.max(...STRATEGY_RULES.map((rule) => rule.movingAverageSessions));
  const holdoutStartDay = HISTORY.dates.indexOf(HOLDOUT_START_DATE);
  const developmentEndDay = holdoutStartDay - 1;
  const endDay = HISTORY.dates.length - 1;
  const evaluatedCandidates = evaluateDevelopmentCandidates(settings).map((candidate) => ({
    ...candidate,
    holdoutGross: simulate(settings, candidate.rule, holdoutStartDay, endDay, PRICE_HISTORY, undefined, false),
    holdoutNet: simulate(settings, candidate.rule, holdoutStartDay, endDay),
  }));
  const selectedRuleId = selectDevelopmentWinner(settings).rule.id;
  const selected = evaluatedCandidates.find((candidate) => candidate.rule.id === selectedRuleId)!;
  const result = selected.holdoutNet;
  const grossResult = selected.holdoutGross;
  const regimes = REGIME_WINDOWS.map((window) => {
    const regimeStart = Math.max(holdoutStartDay, HISTORY.dates.indexOf(window.startDate));
    const regimeEnd = HISTORY.dates.indexOf(window.endDate);
    const regimeResult = simulate(selected.settings, selected.rule, regimeStart, regimeEnd);
    return {
      regime: window.regime,
      startDate: HISTORY.dates[regimeStart],
      endDate: window.endDate,
      sessions: regimeResult.periodDays,
      returnPercent: regimeResult.returnPercent,
      benchmarkReturnPercent: regimeResult.benchmarkReturnPercent,
      maxDrawdownPercent: regimeResult.maxDrawdownPercent,
    };
  });
  const snapshotAgeDays = getSnapshotAgeDays(HISTORY.metadata.endDate);
  const rawExcessReturnPercent = result.rawReturnPercent - result.rawBenchmarkReturnPercent;
  const excessReturnPercent = round(rawExcessReturnPercent);
  const rawChecks = [
    { label: "Snapshot age (days)", actual: snapshotAgeDays, limit: MAX_SNAPSHOT_AGE_DAYS, comparison: "MAX" as const },
    { label: "Holdout sessions", actual: result.periodDays, limit: 450, comparison: "MIN" as const },
    { label: "Maximum drawdown", actual: result.maxDrawdownPercent, limit: 20, comparison: "MAX" as const },
    { label: "Closed trades", actual: result.closedTrades, limit: 8, comparison: "MIN" as const },
    { label: "Market regimes", actual: regimes.length, limit: 3, comparison: "MIN" as const },
    { label: "Net total return", actual: result.returnPercent, limit: 0, comparison: "MIN" as const },
    { label: "Excess return vs FTSE", actual: rawExcessReturnPercent, limit: 0, comparison: "GT" as const },
  ];
  const safetyChecks = rawChecks.map((check) => ({
    ...check,
    passed: check.comparison === "MAX"
      ? check.actual <= check.limit
      : check.comparison === "GT"
        ? check.actual > check.limit
        : check.actual >= check.limit,
  }));
  const costScenarios = UK_TRADING_COST_SCENARIOS.map((scenario) => {
    const scenarioResult = scenario.id === "BASE"
      ? result
      : simulate(settings, selected.rule, holdoutStartDay, endDay, PRICE_HISTORY, undefined, true, scenario.assumptions);
    const scenarioExcessReturn = scenarioResult.rawReturnPercent - scenarioResult.rawBenchmarkReturnPercent;
    const scenarioSafetyPassed = holdoutSafetyPassed(scenarioResult, snapshotAgeDays, regimes.length);
    return {
      id: scenario.id,
      name: scenario.name,
      assumptions: scenario.assumptions,
      netFinalValue: scenarioResult.finalValue,
      netReturnPercent: scenarioResult.returnPercent,
      tradingCosts: scenarioResult.tradingCosts,
      excessReturnPercent: round(scenarioExcessReturn),
      maxDrawdownPercent: scenarioResult.maxDrawdownPercent,
      safetyPassed: scenarioSafetyPassed,
    };
  });
  const evaluateCostMultiplier = (multiplier: number, strategyId: string) => {
    const thresholdRule = evaluatedCandidates.find((candidate) => candidate.rule.id === strategyId)?.rule;
    if (!thresholdRule) throw new Error(`Selected development strategy ${strategyId} is unavailable`);
    const thresholdResult = simulate(
      settings,
      thresholdRule,
      holdoutStartDay,
      endDay,
      PRICE_HISTORY,
      undefined,
      true,
      scaledExecutionCosts(multiplier),
    );
    return holdoutSafetyPassed(thresholdResult, snapshotAgeDays, regimes.length);
  };
  const thresholdSearch = findExecutionCostThreshold(selectedRuleId, evaluateCostMultiplier);
  const maximumPassingMultiplier = thresholdSearch.maximumPassingMultiplier;
  const thresholdStatus = thresholdSearch.status;
  const roundedMaximumPassingMultiplier = maximumPassingMultiplier === null
    ? null
    : round(maximumPassingMultiplier, 3);
  const executionCostThreshold: BacktestSummary["executionCostThreshold"] = {
    status: thresholdStatus,
    maximumPassingMultiplier: roundedMaximumPassingMultiplier,
    headroomFromBaseMultiplier: roundedMaximumPassingMultiplier === null
      ? null
      : round(roundedMaximumPassingMultiplier - 1, 3),
    thresholdAssumptions: roundedMaximumPassingMultiplier === null
      ? null
      : scaledExecutionCosts(roundedMaximumPassingMultiplier),
    lowerBoundMultiplier: thresholdSearch.lowerBoundMultiplier,
    upperBoundMultiplier: thresholdSearch.upperBoundMultiplier,
    precisionMultiplier: thresholdSearch.precisionMultiplier,
    explanation: thresholdStatus === "NO_PASSING_LEVEL"
      ? "No passing level exists in the search range, even with broker-controlled costs reduced to zero. The fixed development winner is tested without reselection; UK stamp duty remains fixed."
      : thresholdStatus === "ABOVE_SEARCH_BOUND"
        ? "The fixed development winner still passes at the 10× search ceiling, so the true threshold is higher. Commission, spread and slippage scale together; UK stamp duty remains fixed."
        : "Highest tested multiplier that still passes the full holdout safety policy. The development winner is fixed before the search; commission, spread and slippage scale together while UK stamp duty remains fixed.",
  };

  return {
    dataSource: HISTORY.metadata.source,
    priceField: HISTORY.metadata.priceField,
    snapshotAsOfDate: HISTORY.metadata.endDate,
    snapshotAgeDays,
    startDate: HISTORY.dates[holdoutStartDay],
    endDate: HISTORY.metadata.endDate,
    executionLagSessions: 1,
    periodDays: result.periodDays,
    initialCapital: 10_000,
    finalValue: result.finalValue,
    returnPercent: result.returnPercent,
    grossFinalValue: grossResult.finalValue,
    grossReturnPercent: grossResult.returnPercent,
    netFinalValue: result.finalValue,
    netReturnPercent: result.returnPercent,
    tradingCosts: result.tradingCosts,
    costAssumptions: UK_TRADING_COSTS,
    defaultSafetyScenario: "BASE",
    costScenarios,
    executionCostThreshold,
    benchmarkReturnPercent: result.benchmarkReturnPercent,
    excessReturnPercent,
    maxDrawdownPercent: result.maxDrawdownPercent,
    winRatePercent: result.winRatePercent,
    turnoverPercent: result.turnoverPercent,
    closedTrades: result.closedTrades,
    safetyPassed: safetyChecks.every((check) => check.passed),
    safetyChecks: safetyChecks.map((check) => ({ ...check, actual: round(check.actual) })),
    benchmarkPolicy: {
      benchmark: "FTSE 100",
      requiredMinimumExcessReturnPercent: 0,
      passed: passesBenchmarkApprovalPolicy(result.rawReturnPercent, result.rawBenchmarkReturnPercent),
      rationale: "Active strategy risk is approved only when net holdout return strictly beats a passive FTSE 100 investment.",
    },
    methodology: {
      splitDate: HOLDOUT_START_DATE,
      developmentStartDate: HISTORY.dates[startDay],
      developmentEndDate: HISTORY.dates[developmentEndDay],
      holdoutStartDate: HISTORY.dates[holdoutStartDay],
      holdoutEndDate: HISTORY.dates[endDay],
      selectionRule: "Highest net development return after UK trading costs; then lower drawdown and turnover",
      selectedStrategyId: selected.rule.id,
      selectedStrategyName: selected.rule.name,
    },
    candidates: evaluatedCandidates.map((candidate) => ({
      id: candidate.rule.id,
      name: candidate.rule.name,
      movingAverageSessions: candidate.rule.movingAverageSessions,
      signalBandPercent: candidate.rule.signalBandPercent,
      stopLossPercent: candidate.settings.stopLossPercent,
      cashReservePercent: candidate.settings.cashReservePercent,
      developmentGrossReturnPercent: candidate.developmentGross.returnPercent,
      developmentNetReturnPercent: candidate.developmentNet.returnPercent,
      developmentMaxDrawdownPercent: candidate.developmentNet.maxDrawdownPercent,
      developmentTurnoverPercent: candidate.developmentNet.turnoverPercent,
      holdoutGrossReturnPercent: candidate.holdoutGross.returnPercent,
      holdoutNetReturnPercent: candidate.holdoutNet.returnPercent,
      holdoutBenchmarkReturnPercent: candidate.holdoutNet.benchmarkReturnPercent,
      holdoutMaxDrawdownPercent: candidate.holdoutNet.maxDrawdownPercent,
      holdoutTurnoverPercent: candidate.holdoutNet.turnoverPercent,
      selected: candidate.rule.id === selected.rule.id,
    })),
    regimes,
  };
}

export function compareCustomTradingCosts(
  settings: RiskSettings,
  customCosts: CustomTradingCostInput,
): CustomCostScenarioResult {
  const holdoutStartDay = HISTORY.dates.indexOf(HOLDOUT_START_DATE);
  const endDay = HISTORY.dates.length - 1;
  const selected = selectDevelopmentWinner(settings);
  const assumptions: TradingCostAssumptions = {
    currency: "GBP",
    ...customCosts,
    stampDutyBpsOnBuys: UK_TRADING_COSTS.stampDutyBpsOnBuys,
    description: `Each UK share order pays £${customCosts.commissionPerOrder} commission, ${customCosts.spreadBpsPerSide} bps half-spread and ${customCosts.slippageBpsPerSide} bps slippage; buys also pay 50 bps UK stamp duty.`,
  };
  const result = simulate(
    settings,
    selected.rule,
    holdoutStartDay,
    endDay,
    PRICE_HISTORY,
    undefined,
    true,
    assumptions,
  );

  return {
    id: "CUSTOM",
    name: "Your broker",
    comparisonOnly: true,
    controlsSafetyGate: false,
    assumptions,
    netFinalValue: result.finalValue,
    netReturnPercent: result.returnPercent,
    tradingCosts: result.tradingCosts,
    excessReturnPercent: round(result.rawReturnPercent - result.rawBenchmarkReturnPercent),
    maxDrawdownPercent: result.maxDrawdownPercent,
  };
}
export function buildMarketAssets(settings: RiskSettings): MarketAsset[] {
  const selectedRule = selectDevelopmentWinner(settings).rule;
  return SYMBOLS.map((symbol) => {
    const history = PRICE_HISTORY[symbol];
    const price = history[history.length - 1];
    const previous = history[history.length - 2];
    const movingAverage = history.slice(-selectedRule.movingAverageSessions).reduce((total, value) => total + value, 0) / selectedRule.movingAverageSessions;
    const change = price - previous;
    const changePercent = (change / previous) * 100;
    const distance = (price - movingAverage) / movingAverage;
    const trend = distance > 0.008 ? "UPTREND" : distance < -0.008 ? "DOWNTREND" : "NEUTRAL";
    const action = actionAt(history, history.length - 1, selectedRule);

    return {
      symbol,
      name: HISTORY.metadata.names[symbol],
      price: round(price, 2),
      change: round(change, 2),
      changePercent: round(changePercent, 2),
      sma50: round(movingAverage, 2),
      movingAverageSessions: selectedRule.movingAverageSessions,
      signalBandPercent: selectedRule.signalBandPercent,
      trend,
      action,
      chart: history.slice(-30).map((value) => round(value, 2)),
      assetClass: ASSET_CLASS[symbol],
      executionCalendar: ASSET_CLASS[symbol] === "CRYPTO" ? "CRYPTO_24_7" : "UK_COMMON_SESSION",
    };
  });
}

export type CustomCostScenarioResult = Omit<CostScenarioResult, "id" | "safetyPassed"> & {
  id: "CUSTOM";
  comparisonOnly: true;
  controlsSafetyGate: false;
};
