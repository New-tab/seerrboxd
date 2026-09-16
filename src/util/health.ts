import { ActivityEvent } from './activity-log';

/**
 * Liveness summary derived from the activity log, exposed on GET /status as `health`
 * so an external monitor (Gatus: `[BODY].health.healthy == true`) can tell the difference
 * between "the HTTP server is up" and "the sync loop is actually doing its job".
 *
 * Why: from 2026-05-15 to 2026-09-14 seerrboxd ran with an empty state file and threw on
 * every cycle before doing any work, while its status page stayed green for four months.
 *
 * healthy == true requires all of:
 *   - at least one sync_completed event,
 *   - the newest sync_completed is younger than `staleAfterCycles` × the check interval,
 *   - that last completed cycle had no source-level error (a "Failed to fetch source" event;
 *     per-item errors carry itemName and are deliberately ignored — one bad TMDb id must not
 *     page anyone).
 */
export interface SyncHealth {
  healthy: boolean;
  reason: string | null;
  lastSyncStartedAt: string | null;
  lastSyncCompletedAt: string | null;
  secondsSinceLastSyncCompleted: number | null;
  lastCycleSourceErrors: number;
  staleAfterSeconds: number;
}

export const STALE_AFTER_CYCLES = 3;

export function computeHealth(
  eventsNewestFirst: ActivityEvent[],
  checkIntervalMinutes: number,
  now: number = Date.now()
): SyncHealth {
  const staleAfterSeconds = STALE_AFTER_CYCLES * checkIntervalMinutes * 60;
  const completedIdx = eventsNewestFirst.findIndex(e => e.action === 'sync_completed');
  const lastStarted = eventsNewestFirst.find(e => e.action === 'sync_started') ?? null;

  if (completedIdx === -1) {
    return {
      healthy: false,
      reason: 'no completed sync in the activity log',
      lastSyncStartedAt: lastStarted?.timestamp ?? null,
      lastSyncCompletedAt: null,
      secondsSinceLastSyncCompleted: null,
      lastCycleSourceErrors: 0,
      staleAfterSeconds,
    };
  }

  const completed = eventsNewestFirst[completedIdx];
  // Events between the newest sync_completed and the sync_started that opened that cycle
  // (the log is newest-first, so walk forward from the completion until the start).
  let sourceErrors = 0;
  let cycleStartedAt: string | null = null;
  for (let i = completedIdx + 1; i < eventsNewestFirst.length; i++) {
    const e = eventsNewestFirst[i];
    if (e.action === 'sync_started') {
      cycleStartedAt = e.timestamp;
      break;
    }
    if (e.action === 'error' && !e.itemName) {
      sourceErrors++;
    }
  }

  const ageSeconds = Math.max(0, Math.round((now - Date.parse(completed.timestamp)) / 1000));
  let reason: string | null = null;
  if (Number.isNaN(ageSeconds) || ageSeconds > staleAfterSeconds) {
    reason = `last completed sync is ${ageSeconds}s old (limit ${staleAfterSeconds}s)`;
  } else if (sourceErrors > 0) {
    reason = `${sourceErrors} source failed in the last cycle`;
  }

  return {
    healthy: reason === null,
    reason,
    lastSyncStartedAt: cycleStartedAt ?? lastStarted?.timestamp ?? null,
    lastSyncCompletedAt: completed.timestamp,
    secondsSinceLastSyncCompleted: ageSeconds,
    lastCycleSourceErrors: sourceErrors,
    staleAfterSeconds,
  };
}
