import assert from 'node:assert/strict';
import test from 'node:test';
import {
  executionCostThresholdHeadroom,
  executionCostThresholdValue,
} from './execution-cost-threshold.ts';

test('renders a numeric execution-cost threshold', () => {
  const threshold = {
    status: 'FOUND',
    maximumPassingMultiplier: 2.3456,
    headroomFromBaseMultiplier: 1.3456,
  };
  assert.equal(executionCostThresholdValue(threshold), '2.346× base');
  assert.equal(executionCostThresholdHeadroom(threshold), '+1.346× from base');
});

test('renders a lower-bound execution-cost threshold', () => {
  const threshold = {
    status: 'ABOVE_SEARCH_BOUND',
    maximumPassingMultiplier: 10,
    headroomFromBaseMultiplier: 9,
  };
  assert.equal(executionCostThresholdValue(threshold), 'At least 10.000× base');
  assert.equal(executionCostThresholdHeadroom(threshold), '+9.000× from base');
});

test('renders the no-passing execution-cost message', () => {
  const threshold = {
    status: 'NO_PASSING_LEVEL',
    maximumPassingMultiplier: null,
    headroomFromBaseMultiplier: null,
  };
  assert.equal(executionCostThresholdValue(threshold), 'No passing cost level');
  assert.equal(executionCostThresholdHeadroom(threshold), 'Base has no cost headroom');
});