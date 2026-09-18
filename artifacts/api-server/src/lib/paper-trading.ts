import type { MarketAsset } from "./market";

export type PaperPosition = {
  symbol: string;
  averagePrice: number;
};

export function nextTradingSession(sessionDate: string): Date {
  const next = new Date(`${sessionDate}T00:00:00.000Z`);
  do {
    next.setUTCDate(next.getUTCDate() + 1);
  } while (next.getUTCDay() === 0 || next.getUTCDay() === 6);
  return next;
}

export function nextExecutionSession(sessionDate: string, calendar: MarketAsset["executionCalendar"]): Date {
  if (calendar === "CRYPTO_24_7") {
    const next = new Date(`${sessionDate}T00:00:00.000Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    return next;
  }
  return nextTradingSession(sessionDate);
}

export function isExecutionDue(executeAfter: Date | null, marketSessionDate: string): boolean {
  if (!executeAfter) return false;
  return executeAfter.getTime() <= new Date(`${marketSessionDate}T00:00:00.000Z`).getTime();
}

export function pendingSignalAssets(assets: MarketAsset[]): MarketAsset[] {
  return assets.filter((asset) => asset.assetClass !== "BENCHMARK" && asset.action !== "HOLD");
}

export function stopLossAssets(
  assets: MarketAsset[],
  positions: PaperPosition[],
  stopLossPercent: number,
): MarketAsset[] {
  const positionsBySymbol = new Map(positions.map((position) => [position.symbol, position]));
  return assets.filter((asset) => {
    const position = positionsBySymbol.get(asset.symbol);
    return asset.assetClass !== "BENCHMARK"
      && Boolean(position && asset.price <= position.averagePrice * (1 - stopLossPercent / 100));
  });
}