const scheduledSessionDate = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

export function formatScheduledSession(value: string): string {
  return scheduledSessionDate.format(new Date(value));
}

export function nearestPendingExecutionDelay(
  signals: Array<{ status: string; scheduledExecutionAt?: string | null }>,
  now = Date.now(),
): number | null {
  const nextExecution = signals.reduce<number | null>((nearest, signal) => {
    if (signal.status !== 'PENDING' || !signal.scheduledExecutionAt) return nearest;
    const scheduledAt = Date.parse(signal.scheduledExecutionAt);
    if (!Number.isFinite(scheduledAt)) return nearest;
    return nearest === null || scheduledAt < nearest ? scheduledAt : nearest;
  }, null);

  return nextExecution === null ? null : Math.max(0, nextExecution - now);
}
