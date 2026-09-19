import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LIVE_TRADING_AVAILABLE_MESSAGE,
  liveReadinessAlert,
} from './live-readiness-alert.ts';

function processReadinessResponses(responses) {
  let previous;
  let tradingMode = 'PAPER';
  const alerts = [];

  for (const liveTradingAvailable of responses) {
    const alert = liveReadinessAlert(previous, liveTradingAvailable);
    if (alert) alerts.push(alert);
    previous = liveTradingAvailable;
  }

  return { alerts, tradingMode };
}

test('an initially eligible load does not show a transition alert', () => {
  const result = processReadinessResponses([true]);

  assert.deepEqual(result.alerts, []);
  assert.equal(result.tradingMode, 'PAPER');
});

test('a false-to-true poll alerts once and keeps paper mode selected', () => {
  const result = processReadinessResponses([false, true, true]);

  assert.deepEqual(result.alerts, [LIVE_TRADING_AVAILABLE_MESSAGE]);
  assert.equal(result.tradingMode, 'PAPER');
});