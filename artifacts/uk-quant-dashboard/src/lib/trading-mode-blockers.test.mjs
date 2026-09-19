import assert from 'node:assert/strict';
import test from 'node:test';
import { runTradingModeBlockerAction } from './trading-mode-blockers.ts';

for (const scenario of [
  { action: 'BROKER_SETUP', expected: 'broker' },
  { action: 'RISK_SETTINGS', expected: 'risk' },
  { action: 'BACKTEST_DETAILS', expected: 'backtest' },
]) {
  test(`${scenario.action} opens the server-selected dashboard destination`, () => {
    const opened = [];
    runTradingModeBlockerAction(scenario.action, {
      openBrokerSetup: () => opened.push('broker'),
      openRiskSettings: () => opened.push('risk'),
      showBacktestDetails: () => opened.push('backtest'),
    });

    assert.deepEqual(opened, [scenario.expected]);
  });
}