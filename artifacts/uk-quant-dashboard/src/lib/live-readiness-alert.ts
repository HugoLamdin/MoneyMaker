export const LIVE_TRADING_AVAILABLE_MESSAGE =
  'Live trading is now available. Paper mode remains active.';

export function liveReadinessAlert(
  previous: boolean | undefined,
  current: boolean,
): string | undefined {
  return previous === false && current
    ? LIVE_TRADING_AVAILABLE_MESSAGE
    : undefined;
}