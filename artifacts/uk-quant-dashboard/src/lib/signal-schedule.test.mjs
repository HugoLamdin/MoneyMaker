import assert from 'node:assert/strict';
import test from 'node:test';
import { formatScheduledSession, nearestPendingExecutionDelay } from './signal-schedule.ts';

test('formats the execution marker as a session date without a misleading UK clock time', () => {
  process.env.TZ = 'Europe/London';

  const label = formatScheduledSession('2026-09-21T00:00:00.000Z');

  assert.equal(label, '21 Sept 2026');
  assert.doesNotMatch(label, /00:00|01:00/);
});

test('schedules one refresh for the nearest pending execution', () => {
  const now = Date.parse('2026-09-18T12:00:00.000Z');
  const delay = nearestPendingExecutionDelay([
    { status: 'COMPLETED', scheduledExecutionAt: '2026-09-19T00:00:00.000Z' },
    { status: 'PENDING', scheduledExecutionAt: '2026-09-21T00:00:00.000Z' },
    { status: 'PENDING', scheduledExecutionAt: '2026-09-20T00:00:00.000Z' },
  ], now);

  assert.equal(delay, 36 * 60 * 60 * 1000);
});

test('stops scheduled refreshing when no executable order is pending', () => {
  assert.equal(nearestPendingExecutionDelay([
    { status: 'COMPLETED', scheduledExecutionAt: '2026-09-20T00:00:00.000Z' },
    { status: 'PENDING', scheduledExecutionAt: null },
  ]), null);
});

test('refreshes immediately when a pending execution time has passed', () => {
  const now = Date.parse('2026-09-21T00:00:01.000Z');
  assert.equal(nearestPendingExecutionDelay([
    { status: 'PENDING', scheduledExecutionAt: '2026-09-21T00:00:00.000Z' },
  ], now), 0);
});
