import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hasPriceRevisionAudit,
  parseRevisionAuditDate,
} from './price-revision-audit.ts';

test('renders date-only and serialized ISO audit dates as the same day', () => {
  assert.equal(parseRevisionAuditDate('2026-09-18').toISOString(), '2026-09-18T00:00:00.000Z');
  assert.equal(parseRevisionAuditDate('2026-09-18T00:00:00.000Z').toISOString(), '2026-09-18T00:00:00.000Z');
});

test('shows the audit only when approved revisions exist', () => {
  assert.equal(hasPriceRevisionAudit([]), false);
  assert.equal(hasPriceRevisionAudit([{ symbol: 'SHEL' }]), true);
});