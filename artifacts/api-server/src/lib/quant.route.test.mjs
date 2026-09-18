import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { and, eq } from "drizzle-orm";
import app from "../app.ts";
import {
  brokerCostAssumptionsTable,
  db,
  pool,
  portfoliosTable,
  positionsTable,
  signalsTable,
  usersTable,
} from "@workspace/db";
import {
  affordableBuyNotional,
  CRYPTO_TRADING_COSTS,
  getMarketSessionDate,
  transactionCost,
  UK_TRADING_COSTS,
} from "./market.ts";
import { nextTradingSession } from "./paper-trading.ts";
import { setBrokerReadinessResolver } from "../routes/quant.ts";

let server;
let baseUrl;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      const address = server.address();
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await pool.end();
});

async function registerTemporaryUser() {
  const email = `paper-route-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "RouteTest123!" }),
  });
  assert.equal(response.status, 201);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
  assert.ok(user);
  return { user, cookie };
}

async function getDashboard(cookie) {
  const response = await fetch(`${baseUrl}/api/dashboard`, { headers: { cookie } });
  assert.equal(response.status, 200);
  return response.json();
}

async function deleteTemporaryUser(userId) {
  await db.delete(brokerCostAssumptionsTable).where(eq(brokerCostAssumptionsTable.userId, userId));
  await db.delete(signalsTable).where(eq(signalsTable.userId, userId));
  await db.delete(positionsTable).where(eq(positionsTable.userId, userId));
  await db.delete(portfoliosTable).where(eq(portfoliosTable.userId, userId));
  await db.delete(usersTable).where(eq(usersTable.id, userId));
}

function assertClose(actual, expected, tolerance = 1e-8) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `Expected ${actual} to be within ${tolerance} of ${expected}`,
  );
}

function assertValidationError(body, expectedFields) {
  assert.equal(body.error, "Invalid request.");
  assert.equal(body.code, "VALIDATION_ERROR");
  assert.ok(Array.isArray(body.fields));
  for (const [field, code, message] of expectedFields) {
    assert.deepEqual(
      body.fields.find((entry) => entry.field === field),
      { field, code, message },
    );
  }
}

test("paper executions apply UK costs to buy quantities, cash, and sell proceeds", async () => {
  const { user, cookie } = await registerTemporaryUser();
  const due = new Date(`${getMarketSessionDate()}T00:00:00.000Z`);

  try {
    const initialCash = 1_000;
    await db
      .update(portfoliosTable)
      .set({ cash: initialCash, maxPositionPercent: 25, cashReservePercent: 0 })
      .where(eq(portfoliosTable.userId, user.id));
    await db.insert(signalsTable).values({
      userId: user.id,
      symbol: "SHEL",
      name: "Shell",
      action: "BUY",
      price: 1,
      sma50: 1,
      reason: "Route test costed buy",
      executeAfter: due,
    });

    const buyDashboard = await getDashboard(cookie);
    const asset = buyDashboard.assets.find((item) => item.symbol === "SHEL");
    const bought = buyDashboard.positions.find((position) => position.symbol === "SHEL");
    assert.ok(asset);
    assert.ok(bought);

    const budget = initialCash * 0.25;
    const buyNotional = affordableBuyNotional(budget);
    const buyCost = transactionCost(buyNotional, "BUY");
    assertClose(buyCost, UK_TRADING_COSTS.commissionPerOrder
      + buyNotional * UK_TRADING_COSTS.spreadBpsPerSide / 10_000
      + buyNotional * UK_TRADING_COSTS.slippageBpsPerSide / 10_000
      + buyNotional * UK_TRADING_COSTS.stampDutyBpsOnBuys / 10_000);
    assertClose(bought.quantity, buyNotional / asset.price, 1e-6);

    const [portfolioAfterBuy] = await db
      .select()
      .from(portfoliosTable)
      .where(eq(portfoliosTable.userId, user.id))
      .limit(1);
    assertClose(portfolioAfterBuy.cash, initialCash - buyNotional - buyCost);

    await db.insert(signalsTable).values({
      userId: user.id,
      symbol: "SHEL",
      name: "Shell",
      action: "SELL",
      price: asset.price,
      sma50: asset.sma50,
      reason: "Route test costed sell",
      executeAfter: due,
    });
    await getDashboard(cookie);

    const sellNotional = (buyNotional / asset.price) * asset.price;
    const sellCost = transactionCost(sellNotional, "SELL");
    const [portfolioAfterSell] = await db
      .select()
      .from(portfoliosTable)
      .where(eq(portfoliosTable.userId, user.id))
      .limit(1);
    assertClose(
      portfolioAfterSell.cash,
      initialCash - buyNotional - buyCost + sellNotional - sellCost,
    );
    const [remainingPosition] = await db
      .select()
      .from(positionsTable)
      .where(and(eq(positionsTable.userId, user.id), eq(positionsTable.symbol, "SHEL")))
      .limit(1);
    assert.equal(remainingPosition, undefined);
  } finally {
    await deleteTemporaryUser(user.id);
  }
});

test("paper crypto buys use crypto costs without UK stamp duty", async () => {
  const { user, cookie } = await registerTemporaryUser();
  const due = new Date(`${getMarketSessionDate()}T00:00:00.000Z`);

  try {
    const initialCash = 1_000;
    await db
      .update(portfoliosTable)
      .set({ cash: initialCash, maxPositionPercent: 25, cashReservePercent: 0 })
      .where(eq(portfoliosTable.userId, user.id));
    await db.insert(signalsTable).values({
      userId: user.id,
      symbol: "BTC-GBP",
      name: "Bitcoin / GBP",
      action: "BUY",
      price: 1,
      sma50: 1,
      reason: "Route test crypto buy",
      executeAfter: due,
    });

    const dashboard = await getDashboard(cookie);
    const asset = dashboard.assets.find((item) => item.symbol === "BTC-GBP");
    const bought = dashboard.positions.find((position) => position.symbol === "BTC-GBP");
    assert.equal(asset?.assetClass, "CRYPTO");
    assert.equal(asset?.executionCalendar, "CRYPTO_24_7");
    assert.ok(bought);

    const budget = initialCash * 0.25;
    const buyNotional = affordableBuyNotional(budget, CRYPTO_TRADING_COSTS);
    const buyCost = transactionCost(buyNotional, "BUY", CRYPTO_TRADING_COSTS);
    assert.equal(CRYPTO_TRADING_COSTS.stampDutyBpsOnBuys, 0);
    assertClose(bought.quantity, buyNotional / asset.price, 1e-6);
    const [portfolio] = await db
      .select()
      .from(portfoliosTable)
      .where(eq(portfoliosTable.userId, user.id))
      .limit(1);
    assertClose(portfolio.cash, initialCash - buyNotional - buyCost);
  } finally {
    await deleteTemporaryUser(user.id);
  }
});

test("paper buys stay pending when cash cannot cover the commission", async () => {
  const { user, cookie } = await registerTemporaryUser();

  try {
    await db
      .update(portfoliosTable)
      .set({ cash: UK_TRADING_COSTS.commissionPerOrder - 0.01, maxPositionPercent: 100, cashReservePercent: 0 })
      .where(eq(portfoliosTable.userId, user.id));
    await db.insert(signalsTable).values({
      userId: user.id,
      symbol: "SHEL",
      name: "Shell",
      action: "BUY",
      price: 1,
      sma50: 1,
      reason: "Route test insufficient cash",
      executeAfter: new Date(`${getMarketSessionDate()}T00:00:00.000Z`),
    });

    const dashboard = await getDashboard(cookie);
    assert.equal(dashboard.positions.some((position) => position.symbol === "SHEL"), false);
    assert.equal(
      dashboard.signals.find((signal) => signal.reason === "Route test insufficient cash")?.status,
      "PENDING",
    );
    const [portfolio] = await db
      .select()
      .from(portfoliosTable)
      .where(eq(portfoliosTable.userId, user.id))
      .limit(1);
    assertClose(portfolio.cash, UK_TRADING_COSTS.commissionPerOrder - 0.01);
  } finally {
    await deleteTemporaryUser(user.id);
  }
});

test("paper sells deduct commission even when it exceeds the holding value", async () => {
  const { user, cookie } = await registerTemporaryUser();

  try {
    const initialCash = 100;
    await db
      .update(portfoliosTable)
      .set({ cash: initialCash })
      .where(eq(portfoliosTable.userId, user.id));
    const initialDashboard = await getDashboard(cookie);
    const asset = initialDashboard.assets.find((item) => item.symbol === "SHEL");
    assert.ok(asset);
    const quantity = 1 / asset.price;
    await db.insert(positionsTable).values({
      userId: user.id,
      symbol: "SHEL",
      name: asset.name,
      quantity,
      averagePrice: asset.price,
    });
    await db.insert(signalsTable).values({
      userId: user.id,
      symbol: "SHEL",
      name: asset.name,
      action: "SELL",
      price: asset.price,
      sma50: asset.sma50,
      reason: "Route test sub-commission sell",
      executeAfter: new Date(`${getMarketSessionDate()}T00:00:00.000Z`),
    });

    const dashboard = await getDashboard(cookie);
    const notional = quantity * asset.price;
    assertClose(dashboard.cash, initialCash + notional - transactionCost(notional, "SELL"), 0.01);
    assert.equal(dashboard.positions.some((position) => position.symbol === "SHEL"), false);
    assert.equal(
      dashboard.signals.find((signal) => signal.reason === "Route test sub-commission sell")?.status,
      "COMPLETED",
    );
  } finally {
    await deleteTemporaryUser(user.id);
  }
});

test("dashboard delays paper orders until the next session and never executes FTSE", async () => {
  const { user, cookie } = await registerTemporaryUser();
  const marketSession = getMarketSessionDate();
  const executeAfter = nextTradingSession(marketSession);

  try {
    await db.insert(signalsTable).values([
      {
        userId: user.id,
        symbol: "SHEL",
        name: "Shell",
        action: "BUY",
        price: 1,
        sma50: 1,
        reason: "Route test pending buy",
        executeAfter,
      },
      {
        userId: user.id,
        symbol: "FTSE",
        name: "FTSE 100",
        action: "BUY",
        price: 1,
        sma50: 1,
        reason: "Route test benchmark exclusion",
        executeAfter: new Date(`${marketSession}T00:00:00.000Z`),
      },
    ]);

    let dashboard = await getDashboard(cookie);
    assert.equal(dashboard.positions.some((position) => position.symbol === "SHEL"), false);
    assert.equal(dashboard.positions.some((position) => position.symbol === "FTSE"), false);
    const pendingBuy = dashboard.signals.find((signal) => signal.reason === "Route test pending buy");
    assert.equal(pendingBuy.status, "PENDING");
    assert.equal(pendingBuy.orderType, "SIGNAL");
    assert.equal(pendingBuy.scheduledExecutionAt, executeAfter.toISOString());

    await db
      .update(signalsTable)
      .set({ executeAfter: new Date(`${marketSession}T00:00:00.000Z`) })
      .where(and(
        eq(signalsTable.userId, user.id),
        eq(signalsTable.symbol, "SHEL"),
        eq(signalsTable.action, "BUY"),
      ));

    dashboard = await getDashboard(cookie);
    assert.equal(dashboard.positions.some((position) => position.symbol === "SHEL"), true);
    assert.equal(dashboard.positions.some((position) => position.symbol === "FTSE"), false);
    const completedBuy = dashboard.signals.find((signal) => signal.reason === "Route test pending buy");
    assert.equal(completedBuy.status, "COMPLETED");

    const [shellPosition] = await db
      .select()
      .from(positionsTable)
      .where(and(eq(positionsTable.userId, user.id), eq(positionsTable.symbol, "SHEL")))
      .limit(1);
    assert.ok(shellPosition);
    await db
      .update(positionsTable)
      .set({ averagePrice: shellPosition.averagePrice * 100 })
      .where(eq(positionsTable.id, shellPosition.id));

    dashboard = await getDashboard(cookie);
    assert.equal(dashboard.positions.some((position) => position.symbol === "SHEL"), true);
    const [pendingStop] = await db
      .select()
      .from(signalsTable)
      .where(and(
        eq(signalsTable.userId, user.id),
        eq(signalsTable.symbol, "SHEL"),
        eq(signalsTable.action, "SELL"),
        eq(signalsTable.autoInvested, false),
      ))
      .limit(1);
    assert.ok(pendingStop);
    assert.equal(pendingStop.origin, "STOP_LOSS");
    assert.equal(pendingStop.executeAfter?.toISOString(), executeAfter.toISOString());
    await db
      .update(signalsTable)
      .set({ reason: "Protective exit copy changed" })
      .where(eq(signalsTable.id, pendingStop.id));
    dashboard = await getDashboard(cookie);
    const pendingStopSignal = dashboard.signals.find((signal) => signal.id === pendingStop.id);
    assert.equal(pendingStopSignal.status, "PENDING");
    assert.equal(pendingStopSignal.orderType, "STOP_LOSS");
    assert.equal(pendingStopSignal.scheduledExecutionAt, executeAfter.toISOString());

    await db
      .update(signalsTable)
      .set({ executeAfter: new Date(`${marketSession}T00:00:00.000Z`) })
      .where(eq(signalsTable.id, pendingStop.id));
    dashboard = await getDashboard(cookie);
    assert.equal(dashboard.positions.some((position) => position.symbol === "SHEL"), false);
    const completedStopSignal = dashboard.signals.find((signal) => signal.id === pendingStop.id);
    assert.equal(completedStopSignal.status, "COMPLETED");
  } finally {
    await deleteTemporaryUser(user.id);
  }
});

test("trading mode reports a stable broker setup action when broker verification is missing", async () => {
  const { user, cookie } = await registerTemporaryUser();
  setBrokerReadinessResolver(() => false);

  try {
    const response = await fetch(`${baseUrl}/api/trading-mode`, {
      headers: { cookie },
    });
    assert.equal(response.status, 200);
    const mode = await response.json();
    const blocker = mode.blockers.find(({ code }) => code === "BROKER_NOT_VERIFIED");

    assert.equal(blocker?.action, "BROKER_SETUP");
  } finally {
    setBrokerReadinessResolver();
    await deleteTemporaryUser(user.id);
  }
});

test("LIVE mode stays locked when the FTSE benchmark approval policy fails", async () => {
  const { user, cookie } = await registerTemporaryUser();
  setBrokerReadinessResolver(() => true);

  try {
    const response = await fetch(`${baseUrl}/api/trading-mode`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({ mode: "LIVE" }),
    });
    const body = await response.json();

    assert.equal(response.status, 409);
    assert.match(body.error, /Excess return vs FTSE/);
    assert.match(body.error, /must be above 0/);
    assert.doesNotMatch(body.error, /supported broker connection/i);

    const modeResponse = await fetch(`${baseUrl}/api/trading-mode`, {
      headers: { cookie },
    });
    assert.equal(modeResponse.status, 200);
    const mode = await modeResponse.json();
    assert.equal(mode.mode, "PAPER");
    assert.equal(mode.brokerReady, true);
    assert.equal(mode.historicalPolicyReady, false);
    const blocker = mode.blockers.find(({ code }) => code === "HISTORICAL_EXCESS_RETURN_VS_FTSE");
    assert.equal(blocker?.action, "BACKTEST_DETAILS");

    const [portfolio] = await db
      .select()
      .from(portfoliosTable)
      .where(eq(portfoliosTable.userId, user.id))
      .limit(1);
    assert.equal(portfolio?.mode, "PAPER");
  } finally {
    setBrokerReadinessResolver();
    await deleteTemporaryUser(user.id);
  }
});

test("signed-out visitors cannot change a portfolio's trading mode", async () => {
  const { user } = await registerTemporaryUser();

  try {
    const response = await fetch(`${baseUrl}/api/trading-mode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "LIVE" }),
    });
    const body = await response.json();

    assert.equal(response.status, 401);
    assert.equal(body.error, "Authentication required");

    const [portfolio] = await db
      .select()
      .from(portfoliosTable)
      .where(eq(portfoliosTable.userId, user.id))
      .limit(1);
    assert.equal(portfolio?.mode, "PAPER");
  } finally {
    await deleteTemporaryUser(user.id);
  }
});

test("forged session cookies cannot change a portfolio's trading mode", async () => {
  const { user, cookie } = await registerTemporaryUser();
  const finalCharacter = cookie.at(-1);
  const forgedCookie = `${cookie.slice(0, -1)}${finalCharacter === "0" ? "1" : "0"}`;

  try {
    const response = await fetch(`${baseUrl}/api/trading-mode`, {
      method: "POST",
      headers: {
        cookie: forgedCookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({ mode: "LIVE" }),
    });
    const body = await response.json();

    assert.equal(response.status, 401);
    assert.equal(body.error, "Authentication required");

    const [portfolio] = await db
      .select()
      .from(portfoliosTable)
      .where(eq(portfoliosTable.userId, user.id))
      .limit(1);
    assert.equal(portfolio?.mode, "PAPER");
  } finally {
    await deleteTemporaryUser(user.id);
  }
});

test("invalid trading modes are rejected without changing the portfolio", async () => {
  const { user, cookie } = await registerTemporaryUser();

  try {
    await db
      .update(portfoliosTable)
      .set({ mode: "LIVE" })
      .where(eq(portfoliosTable.userId, user.id));

    const response = await fetch(`${baseUrl}/api/trading-mode`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({ mode: "SIMULATION" }),
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assertValidationError(body, [
      ["mode", "INVALID_VALUE", "Enter a valid value."],
    ]);

    const [portfolio] = await db
      .select()
      .from(portfoliosTable)
      .where(eq(portfoliosTable.userId, user.id))
      .limit(1);
    assert.equal(portfolio?.mode, "LIVE");
  } finally {
    await deleteTemporaryUser(user.id);
  }
});

test("account settings share stable field-level validation errors", async () => {
  const { user, cookie } = await registerTemporaryUser();

  try {
    const cases = [
      {
        path: "/api/risk-settings",
        method: "PUT",
        body: {
          maxPositionPercent: 1,
          cashReservePercent: 70,
        },
        fields: [
          ["maxPositionPercent", "INVALID_VALUE", "Enter a valid value."],
          ["stopLossPercent", "REQUIRED", "This field is required."],
          ["cashReservePercent", "INVALID_VALUE", "Enter a valid value."],
        ],
      },
      {
        path: "/api/backtest/custom-cost",
        method: "POST",
        body: {
          commissionPerOrder: -1,
          spreadBpsPerSide: 4,
          slippageBpsPerSide: 6,
          currency: "GBP",
        },
        fields: [
          ["commissionPerOrder", "INVALID_VALUE", "Enter a valid value."],
        ],
      },
    ];

    for (const entry of cases) {
      const response = await fetch(`${baseUrl}${entry.path}`, {
        method: entry.method,
        headers: {
          cookie,
          "content-type": "application/json",
        },
        body: JSON.stringify(entry.body),
      });
      assert.equal(response.status, 400);
      assertValidationError(await response.json(), entry.fields);
    }
  } finally {
    await deleteTemporaryUser(user.id);
  }
});

test("custom broker costs are saved per user and returned as comparison-only", async () => {
  const { user, cookie } = await registerTemporaryUser();

  try {
    const emptySavedResponse = await fetch(`${baseUrl}/api/backtest/custom-cost`, {
      headers: { cookie },
    });
    assert.equal(emptySavedResponse.status, 200);
    assert.equal(await emptySavedResponse.json(), null);

    const response = await fetch(`${baseUrl}/api/backtest/custom-cost`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        commissionPerOrder: 7.5,
        spreadBpsPerSide: 4,
        slippageBpsPerSide: 6,
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.id, "CUSTOM");
    assert.equal(body.comparisonOnly, true);
    assert.equal(body.controlsSafetyGate, false);
    assert.equal(body.assumptions.commissionPerOrder, 7.5);
    assert.equal(body.assumptions.stampDutyBpsOnBuys, 50);
    assert.equal(typeof body.netReturnPercent, "number");

    const savedResponse = await fetch(`${baseUrl}/api/backtest/custom-cost`, {
      headers: { cookie },
    });
    assert.equal(savedResponse.status, 200);
    assert.deepEqual(await savedResponse.json(), {
      commissionPerOrder: 7.5,
      spreadBpsPerSide: 4,
      slippageBpsPerSide: 6,
    });

    const invalidResponse = await fetch(`${baseUrl}/api/backtest/custom-cost`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        commissionPerOrder: -1,
        spreadBpsPerSide: 4,
        slippageBpsPerSide: 6,
      }),
    });
    assert.equal(invalidResponse.status, 400);
    assertValidationError(await invalidResponse.json(), [
      ["commissionPerOrder", "INVALID_VALUE", "Enter a valid value."],
    ]);

    const unchangedSavedResponse = await fetch(`${baseUrl}/api/backtest/custom-cost`, {
      headers: { cookie },
    });
    assert.deepEqual(await unchangedSavedResponse.json(), {
      commissionPerOrder: 7.5,
      spreadBpsPerSide: 4,
      slippageBpsPerSide: 6,
    });
  } finally {
    await deleteTemporaryUser(user.id);
  }
});
