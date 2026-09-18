import type { TradingModeBlocker } from '@workspace/api-client-react';

type BlockerActionCallbacks = {
  openBrokerSetup: () => void;
  openRiskSettings: () => void;
  showBacktestDetails: () => void;
};

export function runTradingModeBlockerAction(
  action: TradingModeBlocker['action'],
  callbacks: BlockerActionCallbacks,
): void {
  if (action === 'BROKER_SETUP') {
    callbacks.openBrokerSetup();
    return;
  }
  if (action === 'RISK_SETTINGS') {
    callbacks.openRiskSettings();
    return;
  }
  callbacks.showBacktestDetails();
}