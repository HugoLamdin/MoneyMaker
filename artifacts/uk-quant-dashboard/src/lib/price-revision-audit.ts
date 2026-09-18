export type RevisionAuditDate = string | Date;

export function hasPriceRevisionAudit(revisions: readonly unknown[]): boolean {
  return revisions.length > 0;
}

export function parseRevisionAuditDate(value: RevisionAuditDate): Date {
  if (value instanceof Date) return value;
  return new Date(value.includes('T') ? value : `${value}T00:00:00Z`);
}