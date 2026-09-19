import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SYMBOLS = {
  FTSE: { ticker: "^FTSE", name: "FTSE 100", currency: "index points" },
  SHEL: { ticker: "SHEL.L", name: "Shell plc", currency: "GBp" },
  AZN: { ticker: "AZN.L", name: "AstraZeneca", currency: "GBp" },
  HSBA: { ticker: "HSBA.L", name: "HSBC Holdings", currency: "GBp" },
  ULVR: { ticker: "ULVR.L", name: "Unilever", currency: "GBp" },
  "BTC-GBP": { ticker: "BTC-GBP", name: "Bitcoin / GBP", currency: "GBP", timezone: "UTC" },
  "ETH-GBP": { ticker: "ETH-GBP", name: "Ethereum / GBP", currency: "GBP", timezone: "UTC" },
};
const assetClassFor = (symbol) => symbol === "FTSE"
  ? "BENCHMARK"
  : symbol.endsWith("-GBP")
    ? "CRYPTO"
    : "EQUITY";
const executionCalendarFor = (symbol) => assetClassFor(symbol) === "CRYPTO"
  ? "CRYPTO_24_7"
  : "UK_COMMON_SESSION";
const START_DATE = "2022-01-31";
const MIN_COMMON_SESSIONS = 900;
const MIN_COVERAGE_RATIO = 0.95;
const MATERIAL_REVISION_RATIO = 0.01;
const MAX_REVISION_SUMMARY_ITEMS = 10;
const SOURCE = "Yahoo Finance chart API";
const PRICE_FIELD = "adjusted close";
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const snapshotPath = resolve(scriptDirectory, "../src/data/uk-adjusted-history.json");
const defaultFileSystem = { readFile, rename, rm, writeFile };

function fail(message) {
  throw new Error(`Market history import rejected: ${message}`);
}

function isIsoDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

export function validateSnapshot(snapshot, {
  allowLegacyUniverse = true,
  allowLegacyAssetMetadata = false,
} = {}) {
  if (!snapshot || typeof snapshot !== "object") fail("snapshot must be an object");
  const { metadata, dates, series } = snapshot;
  if (!metadata || metadata.source !== SOURCE || metadata.priceField !== PRICE_FIELD) {
    fail("source metadata is missing or unexpected");
  }
  if (!isIsoDate(metadata.importedAt) || !isIsoDate(metadata.startDate) || !isIsoDate(metadata.endDate)) {
    fail("metadata dates must use YYYY-MM-DD");
  }
  if (metadata.priceRevisionAudit !== undefined) {
    if (!Array.isArray(metadata.priceRevisionAudit)
      || metadata.priceRevisionAudit.some((record) =>
        !Object.hasOwn(SYMBOLS, record?.symbol)
        || !isIsoDate(record.date)
        || !isIsoDate(record.approvalDate)
        || [record.oldPrice, record.newPrice].some((price) =>
          typeof price !== "number" || !Number.isFinite(price) || price <= 0)
        || typeof record.percentageChange !== "number"
        || !Number.isFinite(record.percentageChange))) {
      fail("price revision audit contains an invalid record");
    }
  }
  if (!Array.isArray(dates) || dates.length < MIN_COMMON_SESSIONS) {
    fail(`only ${dates?.length ?? 0} common sessions; at least ${MIN_COMMON_SESSIONS} required`);
  }
  if (new Set(dates).size !== dates.length || dates.some((date, index) =>
    !isIsoDate(date) || (index > 0 && date <= dates[index - 1]))) {
    fail("common dates must be unique, valid, and ascending");
  }
  if (metadata.startDate !== dates[0] || metadata.endDate !== dates.at(-1) || metadata.sessions !== dates.length) {
    fail("date range metadata does not match the common dates");
  }
  const configuredSymbols = allowLegacyUniverse && !metadata.tickers?.["BTC-GBP"]
    ? Object.keys(metadata.tickers ?? {}).filter((symbol) => Object.hasOwn(SYMBOLS, symbol))
    : Object.keys(SYMBOLS);
  for (const symbol of configuredSymbols) {
    const configuration = SYMBOLS[symbol];
    if (metadata.tickers?.[symbol] !== configuration.ticker
      || metadata.names?.[symbol] !== configuration.name
      || metadata.currency?.[symbol] !== configuration.currency
      || (!allowLegacyAssetMetadata
        && (metadata.timezones?.[symbol] !== (configuration.timezone ?? "Europe/London")
          || metadata.assetClasses?.[symbol] !== assetClassFor(symbol)
          || metadata.executionCalendars?.[symbol] !== executionCalendarFor(symbol)))) {
      fail(`source metadata for ${symbol} is missing or unexpected`);
    }
    const prices = series?.[symbol];
    if (!Array.isArray(prices) || prices.length !== dates.length) {
      fail(`${symbol} does not have one price for every common date`);
    }
    if (prices.some((price) => typeof price !== "number" || !Number.isFinite(price) || price <= 0)) {
      fail(`${symbol} contains a non-positive or non-finite adjusted price`);
    }
  }
  return snapshot;
}

export function findMaterialPriceRevisions(currentSnapshot, replacementSnapshot) {
  validateSnapshot(currentSnapshot);
  validateSnapshot(replacementSnapshot);
  const currentDateIndexes = new Map(
    currentSnapshot.dates.map((date, index) => [date, index]),
  );
  const revisions = [];
  replacementSnapshot.dates.forEach((date, replacementIndex) => {
    const currentIndex = currentDateIndexes.get(date);
    if (currentIndex === undefined) return;
    for (const symbol of Object.keys(SYMBOLS)) {
      const previousPrice = currentSnapshot.series[symbol][currentIndex];
      const replacementPrice = replacementSnapshot.series[symbol][replacementIndex];
      const changeRatio = Math.abs(replacementPrice - previousPrice) / previousPrice;
      if (changeRatio >= MATERIAL_REVISION_RATIO) {
        revisions.push({
          symbol,
          date,
          previousPrice,
          replacementPrice,
          changeRatio,
        });
      }
    }
  });
  return revisions;
}

export function attachPriceRevisionAudit(currentSnapshot, replacementSnapshot, revisions, approvalDate) {
  if (revisions.length === 0) {
    if (currentSnapshot.metadata.priceRevisionAudit) {
      replacementSnapshot.metadata.priceRevisionAudit = currentSnapshot.metadata.priceRevisionAudit;
    }
    return replacementSnapshot;
  }
  replacementSnapshot.metadata.priceRevisionAudit = [
    ...(currentSnapshot.metadata.priceRevisionAudit ?? []),
    ...revisions.map(({
      symbol,
      date,
      previousPrice,
      replacementPrice,
      changeRatio,
    }) => ({
      symbol,
      date,
      oldPrice: previousPrice,
      newPrice: replacementPrice,
      percentageChange: ((replacementPrice - previousPrice) / previousPrice) * 100,
      approvalDate,
    })),
  ];
  return replacementSnapshot;
}

export function assertNoMaterialPriceRevisions(currentSnapshot, replacementSnapshot) {
  const revisions = findMaterialPriceRevisions(currentSnapshot, replacementSnapshot);
  if (revisions.length === 0) return;
  const summary = revisions
    .slice(0, MAX_REVISION_SUMMARY_ITEMS)
    .map(({ symbol, date, changeRatio }) =>
      `${symbol} ${date} ${(changeRatio * 100).toFixed(1)}%`)
    .join(", ");
  const omitted = revisions.length - MAX_REVISION_SUMMARY_ITEMS;
  fail(
    `${revisions.length} overlapping adjusted prices changed by at least `
    + `${MATERIAL_REVISION_RATIO * 100}%: ${summary}`
    + `${omitted > 0 ? `, and ${omitted} more` : ""}. `
    + "Review the revisions, then rerun with --allow-price-revisions to accept them",
  );
}

async function replaceSnapshot(destinationPath, snapshot, fileSystem) {
  const temporaryPath = `${destinationPath}.tmp-${process.pid}-${randomUUID()}`;
  let primaryError;
  try {
    await fileSystem.writeFile(temporaryPath, `${JSON.stringify(snapshot)}\n`, "utf8");
    validateSnapshot(JSON.parse(await fileSystem.readFile(temporaryPath, "utf8")));
    await fileSystem.rename(temporaryPath, destinationPath);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await fileSystem.rm(temporaryPath, { force: true });
    } catch (cleanupError) {
      if (!primaryError) throw cleanupError;
      if (primaryError instanceof Error) {
        primaryError.message += `; temporary-file cleanup also failed: ${
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        }`;
      }
    }
  }
}

async function fetchSymbol(symbol, { ticker }, fetchImpl) {
  const period1 = Math.floor(Date.parse(`${START_DATE}T00:00:00Z`) / 1000);
  const period2 = Math.floor(Date.now() / 1000) + 86_400;
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`);
  url.searchParams.set("period1", String(period1));
  url.searchParams.set("period2", String(period2));
  url.searchParams.set("interval", "1d");
  url.searchParams.set("events", "history");
  const response = await fetchImpl(url, { headers: { "user-agent": "uk-quant-dashboard/1.0" } });
  if (!response.ok) fail(`${symbol} request returned HTTP ${response.status}`);
  const body = await response.json();
  const result = body?.chart?.result?.[0];
  const expectedTimezone = SYMBOLS[symbol].timezone ?? "Europe/London";
  if (body?.chart?.error || !result || result.meta?.symbol !== ticker
    || result.meta?.exchangeTimezoneName !== expectedTimezone) {
    fail(`${symbol} response metadata is missing or unexpected`);
  }
  const timestamps = result.timestamp;
  const adjusted = result.indicators?.adjclose?.[0]?.adjclose;
  if (!Array.isArray(timestamps) || !Array.isArray(adjusted) || timestamps.length !== adjusted.length) {
    fail(`${symbol} adjusted-close data is missing or malformed`);
  }
  const pricesByDate = new Map();
  timestamps.forEach((timestamp, index) => {
    const price = adjusted[index];
    if (typeof price === "number" && Number.isFinite(price) && price > 0) {
      pricesByDate.set(new Date(timestamp * 1000).toISOString().slice(0, 10), price);
    }
  });
  return pricesByDate;
}

async function buildSnapshot(fetchImpl) {
  const entries = await Promise.all(
    Object.entries(SYMBOLS).map(async ([symbol, configuration]) =>
      [symbol, await fetchSymbol(symbol, configuration, fetchImpl)]),
  );
  const histories = Object.fromEntries(entries);
  const referenceSessionCount = histories.FTSE.size;
  for (const [symbol, prices] of entries) {
    const coverage = prices.size / referenceSessionCount;
    if (coverage < MIN_COVERAGE_RATIO) {
      fail(`${symbol} coverage ${(coverage * 100).toFixed(1)}% is below ${MIN_COVERAGE_RATIO * 100}%`);
    }
  }
  const dates = [...histories.FTSE.keys()]
    .filter((date) => entries.every(([, prices]) => prices.has(date)))
    .sort();
  const importedAt = new Date().toISOString().slice(0, 10);
  return validateSnapshot({
    metadata: {
      source: SOURCE,
      importedAt,
      priceField: PRICE_FIELD,
      currency: Object.fromEntries(Object.entries(SYMBOLS).map(([symbol, item]) => [symbol, item.currency])),
      tickers: Object.fromEntries(Object.entries(SYMBOLS).map(([symbol, item]) => [symbol, item.ticker])),
      names: Object.fromEntries(Object.entries(SYMBOLS).map(([symbol, item]) => [symbol, item.name])),
      timezones: Object.fromEntries(Object.entries(SYMBOLS).map(([symbol, item]) => [symbol, item.timezone ?? "Europe/London"])),
      assetClasses: Object.fromEntries(Object.keys(SYMBOLS).map((symbol) => [symbol, assetClassFor(symbol)])),
      executionCalendars: Object.fromEntries(Object.keys(SYMBOLS).map((symbol) => [symbol, executionCalendarFor(symbol)])),
      startDate: dates[0],
      endDate: dates.at(-1),
      sessions: dates.length,
    },
    dates,
    series: Object.fromEntries(entries.map(([symbol, prices]) => [symbol, dates.map((date) => prices.get(date))])),
  });
}

export async function refreshMarketHistory({
  destinationPath = snapshotPath,
  fetchImpl = fetch,
  allowPriceRevisions = false,
  fileSystem = defaultFileSystem,
} = {}) {
  const snapshot = await buildSnapshot(fetchImpl);
  const currentSnapshot = JSON.parse(await fileSystem.readFile(destinationPath, "utf8"));
  const legacyUniverse = !currentSnapshot.metadata?.tickers?.["BTC-GBP"];
  const legacyAssetMetadata = !currentSnapshot.metadata?.assetClasses
    || !currentSnapshot.metadata?.executionCalendars;
  validateSnapshot(currentSnapshot, {
    allowLegacyUniverse: legacyUniverse,
    allowLegacyAssetMetadata: legacyAssetMetadata,
  });
  // The first seven-symbol refresh is a deliberate universe expansion, not an
  // approval of unrelated historical revisions in the five-symbol snapshot.
  if (legacyUniverse) {
    await replaceSnapshot(destinationPath, snapshot, fileSystem);
    return snapshot;
  }
  const revisionBaseline = legacyAssetMetadata
    ? {
      ...currentSnapshot,
      metadata: {
        ...currentSnapshot.metadata,
        timezones: snapshot.metadata.timezones,
        assetClasses: snapshot.metadata.assetClasses,
        executionCalendars: snapshot.metadata.executionCalendars,
      },
    }
    : currentSnapshot;
  const revisions = findMaterialPriceRevisions(revisionBaseline, snapshot);
  if (revisions.length > 0 && !allowPriceRevisions) {
    assertNoMaterialPriceRevisions(currentSnapshot, snapshot);
  }
  if (revisions.length > 0) {
    process.stdout.write(
      `Accepting ${revisions.length} reviewed material price revisions via --allow-price-revisions\n`,
    );
  }
  attachPriceRevisionAudit(
    currentSnapshot,
    snapshot,
    revisions,
    snapshot.metadata.importedAt,
  );
  await replaceSnapshot(destinationPath, snapshot, fileSystem);
  return snapshot;
}

async function main() {
  if (process.argv.includes("--check")) {
    validateSnapshot(JSON.parse(await readFile(snapshotPath, "utf8")));
    process.stdout.write(`Validated ${snapshotPath}\n`);
    return;
  }
  const snapshot = await refreshMarketHistory({
    allowPriceRevisions: process.argv.includes("--allow-price-revisions"),
  });
  process.stdout.write(
    `Imported ${snapshot.metadata.sessions} common sessions through ${snapshot.metadata.endDate}\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}