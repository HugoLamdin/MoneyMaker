import { Router, type IRouter } from "express";
import { desc, eq, and, gte, lte } from "drizzle-orm";
import { brokerCostAssumptionsTable, db, portfoliosTable, positionsTable, signalsTable, usersTable } from "@workspace/db";
import {
  AuthResponse,
  CompareCustomTradingCostsBody,
  CompareCustomTradingCostsResponse,
  DepositCashBody,
  DepositCashResponse,
  GetCustomTradingCostsResponse,
  GetAssetsResponse,
  GetCurrentUserResponse,
  GetDashboardResponse,
  GetSignalsResponse,
  LoginBody,
  LoginResponse,
  RegisterBody,
  RegisterResponse,
  GetTradingModeResponse,
  SetTradingModeBody,
  SetTradingModeResponse,
  UpdateRiskSettingsBody,
  UpdateRiskSettingsResponse,
  WithdrawCashBody,
  WithdrawCashResponse,
} from "@workspace/api-zod";
import {
  clearSession,
  getCurrentUser,
  hashPassword,
  publicUser,
  setSession,
  verifyPassword,
} from "../lib/auth";
import {
  affordableBuyNotional,
  buildMarketAssets,
  compareCustomTradingCosts,
  getMarketSessionDate,
  planBuyAllocations,
  runBacktest,
  transactionCost,
  CRYPTO_TRADING_COSTS,
  type MarketAsset,
  type RiskSettings,
} from "../lib/market";
import { nextExecutionSession, pendingSignalAssets, stopLossAssets } from "../lib/paper-trading";
import historicalData from "../data/uk-adjusted-history.json" with { type: "json" };

const router: IRouter = Router();
type ValidationFieldError = {
  field: string;
  code: "INVALID_VALUE" | "REQUIRED";
  message: "Enter a valid value." | "This field is required.";
};

type InputValidationError = {
  issues: Array<{
    code: string;
    path: Array<string | number>;
    received?: unknown;
  }>;
};

function validationFieldErrors(error: InputValidationError): ValidationFieldError[] {
  return error.issues.map((issue): ValidationFieldError => {
    const required = issue.code === "invalid_type" && issue.received === "undefined";
    return {
      field: issue.path.join(".") || "request",
      code: required ? "REQUIRED" : "INVALID_VALUE",
      message: required ? "This field is required." : "Enter a valid value.",
    };
  });
}

function sendValidationError(
  res: Parameters<Parameters<IRouter["post"]>[1]>[1],
  error: InputValidationError,
): void {
  res.status(400).json({
    error: "Invalid request.",
    code: "VALIDATION_ERROR",
    fields: validationFieldErrors(error),
  });
}

type PriceRevisionAuditEntry = {
  symbol: string;
  date: string;
  oldPrice: number;
  newPrice: number;
  percentageChange: number;
  approvalDate: string;
};
const priceRevisionAudit =
  (historicalData.metadata as typeof historicalData.metadata & {
    priceRevisionAudit?: PriceRevisionAuditEntry[];
  }).priceRevisionAudit ?? [];
type BrokerReadinessResolver = (userId: number) => boolean | Promise<boolean>;
const unavailableBrokerReadiness: BrokerReadinessResolver = () => false;
let resolveBrokerReadiness = unavailableBrokerReadiness;

export function setBrokerReadinessResolver(resolver?: BrokerReadinessResolver): void {
  resolveBrokerReadiness = resolver ?? unavailableBrokerReadiness;
}

async function requireUser(req: Parameters<Parameters<IRouter["get"]>[1]>[0], res: Parameters<Parameters<IRouter["get"]>[1]>[1]) {
  const user = await getCurrentUser(req);
  if (!user) {
    res.status(401).json({ error: "Authentication required" });
    return null;
  }
  return user;
}

async function ensurePortfolio(userId: number) {
  const [existing] = await db.select().from(portfoliosTable).where(eq(portfoliosTable.userId, userId)).limit(1);
  if (existing) return existing;
  const [created] = await db.insert(portfoliosTable).values({ userId, cash: 10000 }).returning();
  return created;
}

async function recordFreshSignals(userId: number, assets: MarketAsset[], settings: RiskSettings): Promise<void> {
  const positions = await db.select().from(positionsTable).where(eq(positionsTable.userId, userId));
  const stoppedSymbols = new Set(stopLossAssets(assets, positions, settings.stopLossPercent).map((asset) => asset.symbol));
  const actionableAssets = pendingSignalAssets(assets);
  const candidates = new Map(actionableAssets.map((asset) => [`${asset.symbol}:${asset.action}`, {
    asset,
    action: asset.action as "BUY" | "SELL",
    stopLoss: false,
  }]));
  for (const asset of assets.filter((item) => stoppedSymbols.has(item.symbol))) {
    candidates.set(`${asset.symbol}:SELL`, { asset, action: "SELL", stopLoss: true });
  }
  const cutoff = new Date(Date.now() - 1000 * 60 * 60 * 12);
  for (const { asset, action, stopLoss } of candidates.values()) {
    const executeAfter = nextExecutionSession(getMarketSessionDate(), asset.executionCalendar);
    const [recent] = await db
      .select()
      .from(signalsTable)
      .where(
        and(
          eq(signalsTable.userId, userId),
          eq(signalsTable.symbol, asset.symbol),
          eq(signalsTable.action, action),
          gte(signalsTable.createdAt, cutoff),
        ),
      )
      .limit(1);
    if (!recent) {
      await db.insert(signalsTable).values({
        userId,
        symbol: asset.symbol,
        name: asset.name,
        action,
        price: asset.price,
        sma50: asset.sma50,
        origin: stopLoss ? "STOP_LOSS" : "TREND_MODEL",
        executeAfter,
        reason:
          stopLoss
            ? `Price fell at least ${settings.stopLossPercent.toFixed(1)}% below the paper position's average price.`
            : action === "BUY"
            ? `Price is ${(((asset.price - asset.sma50) / asset.sma50) * 100).toFixed(1)}% above the ${asset.movingAverageSessions}-day moving average.`
            : `Price is ${(((asset.sma50 - asset.price) / asset.sma50) * 100).toFixed(1)}% below the ${asset.movingAverageSessions}-day moving average.`,
      });
    }
  }
}

async function autoSellNewSignals(userId: number, assets: MarketAsset[]): Promise<void> {
  const positions = await db.select().from(positionsTable).where(eq(positionsTable.userId, userId));
  const positionBySymbol = new Map(positions.map((position) => [position.symbol, position]));
  const dueSells = await db
    .select({ id: signalsTable.id, symbol: signalsTable.symbol })
    .from(signalsTable)
    .where(and(
      eq(signalsTable.userId, userId),
      eq(signalsTable.action, "SELL"),
      eq(signalsTable.autoInvested, false),
      lte(signalsTable.executeAfter, new Date()),
    ));
  const dueBySymbol = new Map(dueSells.map((signal) => [signal.symbol, signal.id]));
  const sellAssets = assets.filter((asset) => asset.assetClass !== "BENCHMARK" && dueBySymbol.has(asset.symbol));
  if (sellAssets.length === 0) return;

  await db.transaction(async (tx) => {
    const [portfolio] = await tx.select().from(portfoliosTable).where(eq(portfoliosTable.userId, userId)).limit(1);
    if (!portfolio) return;

    let saleProceeds = 0;
    let soldPosition = false;
    for (const asset of sellAssets) {
      const pendingSellId = dueBySymbol.get(asset.symbol);
      if (!pendingSellId) continue;

      const [position] = await tx
        .select()
        .from(positionsTable)
        .where(and(eq(positionsTable.userId, userId), eq(positionsTable.symbol, asset.symbol)))
        .limit(1);
      if (position) {
        const notional = position.quantity * asset.price;
        saleProceeds += notional - transactionCost(notional, "SELL", asset.assetClass === "CRYPTO" ? CRYPTO_TRADING_COSTS : undefined);
        soldPosition = true;
        await tx.delete(positionsTable).where(eq(positionsTable.id, position.id));
      }
      await tx
        .update(signalsTable)
        .set({ autoInvested: true })
        .where(eq(signalsTable.id, pendingSellId));
    }

    if (soldPosition) {
      await tx
        .update(portfoliosTable)
        .set({ cash: portfolio.cash + saleProceeds, updatedAt: new Date() })
        .where(eq(portfoliosTable.userId, userId));
    }
  });
}

async function autoInvestNewBuySignals(userId: number, assets: MarketAsset[], settings: RiskSettings): Promise<void> {
  const dueBuys = await db
    .select({ id: signalsTable.id, symbol: signalsTable.symbol })
    .from(signalsTable)
    .where(and(
      eq(signalsTable.userId, userId),
      eq(signalsTable.action, "BUY"),
      eq(signalsTable.autoInvested, false),
      lte(signalsTable.executeAfter, new Date()),
    ));
  const pendingBySymbol = new Map(dueBuys.map((signal) => [signal.symbol, signal.id]));
  const buyAssets = assets.filter((asset) => asset.assetClass !== "BENCHMARK" && pendingBySymbol.has(asset.symbol));
  if (buyAssets.length === 0) return;

  await db.transaction(async (tx) => {
    const [portfolio] = await tx.select().from(portfoliosTable).where(eq(portfoliosTable.userId, userId)).limit(1);
    if (!portfolio || portfolio.cash <= 0) return;

    const existingPositions = await tx.select().from(positionsTable).where(eq(positionsTable.userId, userId));
    const assetBySymbol = new Map(assets.map((asset) => [asset.symbol, asset]));
    const investedValue = existingPositions.reduce(
      (sum, position) => sum + position.quantity * (assetBySymbol.get(position.symbol)?.price ?? position.averagePrice),
      0,
    );
    const totalValue = portfolio.cash + investedValue;
    const eligibleAssets = buyAssets;
    const allocations = planBuyAllocations(
      portfolio.cash,
      totalValue,
      settings,
      eligibleAssets.map((asset) => ({
        symbol: asset.symbol,
        existingValue: (existingPositions.find((position) => position.symbol === asset.symbol)?.quantity ?? 0) * asset.price,
      })),
    );
    let spent = 0;
    for (const asset of eligibleAssets) {
      const pendingBuyId = pendingBySymbol.get(asset.symbol);
      if (!pendingBuyId) continue;
      const existing = existingPositions.find((position) => position.symbol === asset.symbol);
      const allocation = allocations.get(asset.symbol) ?? 0;
      if (allocation <= 0) continue;
      const costs = asset.assetClass === "CRYPTO" ? CRYPTO_TRADING_COSTS : undefined;
       const notional = affordableBuyNotional(allocation, costs);
      if (notional <= 0) continue;
       const cost = transactionCost(notional, "BUY", costs);
      const quantity = notional / asset.price;

      if (existing) {
        const nextQuantity = existing.quantity + quantity;
        const nextAveragePrice =
          (existing.quantity * existing.averagePrice + quantity * asset.price) / nextQuantity;
        await tx
          .update(positionsTable)
          .set({
            quantity: nextQuantity,
            averagePrice: nextAveragePrice,
            name: asset.name,
            updatedAt: new Date(),
          })
          .where(eq(positionsTable.id, existing.id));
      } else {
        await tx.insert(positionsTable).values({
          userId,
          symbol: asset.symbol,
          name: asset.name,
          quantity,
          averagePrice: asset.price,
        });
      }
      spent += notional + cost;
      await tx.update(signalsTable).set({ autoInvested: true }).where(eq(signalsTable.id, pendingBuyId));
    }

    await tx
      .update(portfoliosTable)
      .set({ cash: portfolio.cash - spent, updatedAt: new Date() })
      .where(eq(portfoliosTable.userId, userId));
  });
}

async function dashboardPayload(userId: number) {
  const user = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  const [account] = user;
  let portfolio = await ensurePortfolio(userId);
  const riskSettings = {
    maxPositionPercent: portfolio.maxPositionPercent,
    stopLossPercent: portfolio.stopLossPercent,
    cashReservePercent: portfolio.cashReservePercent,
  };
  const assets = buildMarketAssets(riskSettings);
  await recordFreshSignals(userId, assets, riskSettings);
  await autoSellNewSignals(userId, assets);
  await autoInvestNewBuySignals(userId, assets, riskSettings);
  portfolio = await ensurePortfolio(userId);
  const [signals] = await Promise.all([
    db.select().from(signalsTable).where(eq(signalsTable.userId, userId)).orderBy(desc(signalsTable.createdAt)).limit(12),
  ]);
  const positions = await db.select().from(positionsTable).where(eq(positionsTable.userId, userId));
  const assetBySymbol = new Map(assets.map((asset) => [asset.symbol, asset]));
  const positionPayload = positions.map((position) => {
    const asset = assetBySymbol.get(position.symbol);
    const currentPrice = asset?.price ?? position.averagePrice;
    const marketValue = position.quantity * currentPrice;
    return {
      id: position.id,
      symbol: position.symbol,
      name: asset?.name ?? position.name,
      quantity: Number(position.quantity.toFixed(6)),
      averagePrice: Number(position.averagePrice.toFixed(2)),
      currentPrice: Number(currentPrice.toFixed(2)),
      marketValue: Number(marketValue.toFixed(2)),
      unrealizedPnl: Number(((currentPrice - position.averagePrice) * position.quantity).toFixed(2)),
    };
  });
  const invested = positionPayload.reduce((total, position) => total + position.marketValue, 0);
  const dailyPnl = positions.reduce((total, position) => {
    const asset = assetBySymbol.get(position.symbol);
    return total + (asset?.change ?? 0) * position.quantity;
  }, 0);
  return {
    user: publicUser(account),
    cash: Number(portfolio.cash.toFixed(2)),
    invested: Number(invested.toFixed(2)),
    totalValue: Number((portfolio.cash + invested).toFixed(2)),
    dailyPnl: Number(dailyPnl.toFixed(2)),
    assets,
    signals: signals.map((signal) => ({
      id: signal.id,
      symbol: signal.symbol,
      name: signal.name,
      action: signal.action as "BUY" | "SELL",
      orderType: signal.origin === "STOP_LOSS" ? "STOP_LOSS" as const : "SIGNAL" as const,
      status: signal.autoInvested ? "COMPLETED" as const : "PENDING" as const,
      price: signal.price,
      sma50: signal.sma50,
      createdAt: signal.createdAt.toISOString(),
      scheduledExecutionAt: signal.executeAfter?.toISOString() ?? null,
      reason: signal.reason,
    })),
    positions: positionPayload,
    riskSettings,
    backtest: runBacktest(riskSettings),
    priceRevisionAudit: priceRevisionAudit.map((revision) => ({
      symbol: revision.symbol,
      marketDate: revision.date,
      oldPrice: revision.oldPrice,
      newPrice: revision.newPrice,
      percentageChange: revision.percentageChange,
      approvalDate: revision.approvalDate,
    })),
  };
}

async function tradingModePayload(userId: number) {
  const portfolio = await ensurePortfolio(userId);
  const brokerReady = await resolveBrokerReadiness(userId);
  const brokerConfigured = brokerReady;
  const backtest = runBacktest({
    maxPositionPercent: portfolio.maxPositionPercent,
    stopLossPercent: portfolio.stopLossPercent,
    cashReservePercent: portfolio.cashReservePercent,
  });
  const historicalPolicyReady = backtest.safetyPassed;
  const historicalBlockers = backtest.safetyChecks
    .filter((check) => !check.passed)
    .map((check) => {
      const requirement = check.comparison === "MAX"
        ? `must be ${check.limit} or lower`
        : check.comparison === "GT"
          ? `must be above ${check.limit}`
          : `must be ${check.limit} or higher`;
      return {
        code: `HISTORICAL_${check.label.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`,
        message: `${check.label} is ${check.actual}; it ${requirement}.`,
        action: check.label === "Maximum drawdown" ? "RISK_SETTINGS" as const : "BACKTEST_DETAILS" as const,
      };
    });
  const blockers = [
    ...(!brokerReady ? [{
      code: "BROKER_NOT_VERIFIED",
      message: "A supported broker connection has not been verified.",
      action: "BROKER_SETUP" as const,
    }] : []),
    ...historicalBlockers,
  ];
  const liveTradingAvailable = brokerReady && historicalPolicyReady;
  return {
    mode: portfolio.mode as "PAPER" | "LIVE",
    brokerProvider: null,
    brokerConfigured,
    brokerReady,
    historicalPolicyReady,
    blockers,
    liveTradingAvailable,
  };
}

router.post("/auth/register", async (req, res): Promise<void> => {
  const parsed = RegisterBody.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const email = parsed.data.email.trim().toLowerCase();
  const [existing] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
  if (existing) {
    res.status(409).json({ error: "An account with that email already exists." });
    return;
  }
  const [user] = await db
    .insert(usersTable)
    .values({ email, passwordHash: hashPassword(parsed.data.password) })
    .returning();
  await ensurePortfolio(user.id);
  setSession(res, user.id);
  res.status(201).json(RegisterResponse.parse({ user: publicUser(user) }));
});

router.post("/auth/login", async (req, res): Promise<void> => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const email = parsed.data.email.trim().toLowerCase();
  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
  if (!user || !verifyPassword(parsed.data.password, user.passwordHash)) {
    res.status(401).json({ error: "Email or password is incorrect." });
    return;
  }
  setSession(res, user.id);
  res.json(LoginResponse.parse({ user: publicUser(user) }));
});

router.post("/auth/logout", (_req, res): void => {
  clearSession(res);
  res.sendStatus(204);
});

router.get("/auth/me", async (req, res): Promise<void> => {
  const user = await getCurrentUser(req);
  if (!user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  res.json(GetCurrentUserResponse.parse(publicUser(user)));
});

router.get("/dashboard", async (req, res): Promise<void> => {
  const user = await requireUser(req, res);
  if (!user) return;
  res.json(GetDashboardResponse.parse(await dashboardPayload(user.id)));
});

router.get("/backtest/custom-cost", async (req, res): Promise<void> => {
  const user = await requireUser(req, res);
  if (!user) return;
  const [saved] = await db
    .select({
      commissionPerOrder: brokerCostAssumptionsTable.commissionPerOrder,
      spreadBpsPerSide: brokerCostAssumptionsTable.spreadBpsPerSide,
      slippageBpsPerSide: brokerCostAssumptionsTable.slippageBpsPerSide,
    })
    .from(brokerCostAssumptionsTable)
    .where(eq(brokerCostAssumptionsTable.userId, user.id))
    .limit(1);
  res.json(GetCustomTradingCostsResponse.parse(saved ?? null));
});

router.post("/backtest/custom-cost", async (req, res): Promise<void> => {
  const user = await requireUser(req, res);
  if (!user) return;
  const parsed = CompareCustomTradingCostsBody.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const portfolio = await ensurePortfolio(user.id);
  const settings = {
    maxPositionPercent: portfolio.maxPositionPercent,
    stopLossPercent: portfolio.stopLossPercent,
    cashReservePercent: portfolio.cashReservePercent,
  };
  await db
    .insert(brokerCostAssumptionsTable)
    .values({ userId: user.id, ...parsed.data })
    .onConflictDoUpdate({
      target: brokerCostAssumptionsTable.userId,
      set: { ...parsed.data, updatedAt: new Date() },
    });
  res.json(CompareCustomTradingCostsResponse.parse(compareCustomTradingCosts(settings, parsed.data)));
});

router.get("/assets", async (req, res): Promise<void> => {
  const user = await requireUser(req, res);
  if (!user) return;
  const portfolio = await ensurePortfolio(user.id);
  res.json(GetAssetsResponse.parse(buildMarketAssets({
    maxPositionPercent: portfolio.maxPositionPercent,
    stopLossPercent: portfolio.stopLossPercent,
    cashReservePercent: portfolio.cashReservePercent,
  })));
});

router.get("/signals", async (req, res): Promise<void> => {
  const user = await requireUser(req, res);
  if (!user) return;
  const signals = await db
    .select()
    .from(signalsTable)
    .where(eq(signalsTable.userId, user.id))
    .orderBy(desc(signalsTable.createdAt))
    .limit(50);
  res.json(
    GetSignalsResponse.parse(
      signals.map((signal) => ({
        id: signal.id,
        symbol: signal.symbol,
        name: signal.name,
        action: signal.action as "BUY" | "SELL",
        orderType: signal.origin === "STOP_LOSS" ? "STOP_LOSS" as const : "SIGNAL" as const,
        status: signal.autoInvested ? "COMPLETED" as const : "PENDING" as const,
        price: signal.price,
        sma50: signal.sma50,
        createdAt: signal.createdAt.toISOString(),
        scheduledExecutionAt: signal.executeAfter?.toISOString() ?? null,
        reason: signal.reason,
      })),
    ),
  );
});

router.get("/trading-mode", async (req, res): Promise<void> => {
  const user = await requireUser(req, res);
  if (!user) return;
  res.json(GetTradingModeResponse.parse(await tradingModePayload(user.id)));
});

router.post("/trading-mode", async (req, res): Promise<void> => {
  const user = await requireUser(req, res);
  if (!user) return;
  const parsed = SetTradingModeBody.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const current = await tradingModePayload(user.id);
  if (parsed.data.mode === "LIVE" && !current.liveTradingAvailable) {
    res.status(409).json({
      error: `Live mode is locked: ${current.blockers.map((blocker) => blocker.message).join(" ")}`,
    });
    return;
  }
  await db
    .update(portfoliosTable)
    .set({ mode: parsed.data.mode, updatedAt: new Date() })
    .where(eq(portfoliosTable.userId, user.id));
  res.json(SetTradingModeResponse.parse(await tradingModePayload(user.id)));
});

router.put("/risk-settings", async (req, res): Promise<void> => {
  const user = await requireUser(req, res);
  if (!user) return;
  const parsed = UpdateRiskSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  await ensurePortfolio(user.id);
  await db
    .update(portfoliosTable)
    .set({ ...parsed.data, mode: "PAPER", updatedAt: new Date() })
    .where(eq(portfoliosTable.userId, user.id));
  res.json(UpdateRiskSettingsResponse.parse(await dashboardPayload(user.id)));
});

async function updateCash(
  req: Parameters<Parameters<IRouter["post"]>[1]>[0],
  res: Parameters<Parameters<IRouter["post"]>[1]>[1],
  operation: "deposit" | "withdraw",
): Promise<void> {
  const user = await requireUser(req, res);
  if (!user) return;
  const parsed = (operation === "deposit" ? DepositCashBody : WithdrawCashBody).safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const portfolio = await ensurePortfolio(user.id);
  if (operation === "withdraw" && portfolio.cash < parsed.data.amount) {
    res.status(400).json({ error: "Withdrawal exceeds available mock cash." });
    return;
  }
  const nextCash = portfolio.cash + (operation === "deposit" ? parsed.data.amount : -parsed.data.amount);
  const [updated] = await db
    .update(portfoliosTable)
    .set({ cash: nextCash, updatedAt: new Date() })
    .where(eq(portfoliosTable.userId, user.id))
    .returning();
  const response = { cash: Number(updated.cash.toFixed(2)) };
  res.json((operation === "deposit" ? DepositCashResponse : WithdrawCashResponse).parse(response));
}

router.post("/cash/deposit", async (req, res): Promise<void> => updateCash(req, res, "deposit"));
router.post("/cash/withdraw", async (req, res): Promise<void> => updateCash(req, res, "withdraw"));

export default router;