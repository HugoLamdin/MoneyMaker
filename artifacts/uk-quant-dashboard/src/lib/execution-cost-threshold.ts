type ExecutionCostThresholdDisplay = {
  status: 'FOUND' | 'ABOVE_SEARCH_BOUND' | 'NO_PASSING_LEVEL';
  maximumPassingMultiplier?: number | null;
  headroomFromBaseMultiplier?: number | null;
};

export function executionCostThresholdValue(threshold: ExecutionCostThresholdDisplay): string {
  if (threshold.status === 'NO_PASSING_LEVEL') return 'No passing cost level';
  const prefix = threshold.status === 'ABOVE_SEARCH_BOUND' ? 'At least ' : '';
  return `${prefix}${threshold.maximumPassingMultiplier?.toFixed(3)}× base`;
}

export function executionCostThresholdHeadroom(threshold: ExecutionCostThresholdDisplay): string {
  if (threshold.headroomFromBaseMultiplier == null) return 'Base has no cost headroom';
  const prefix = threshold.headroomFromBaseMultiplier >= 0 ? '+' : '';
  return `${prefix}${threshold.headroomFromBaseMultiplier.toFixed(3)}× from base`;
}