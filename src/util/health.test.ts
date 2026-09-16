import { computeHealth, STALE_AFTER_CYCLES } from './health';
import { ActivityEvent } from './activity-log';

const T0 = Date.parse('2026-09-15T04:00:00.000Z');
const at = (offsetSec: number) => new Date(T0 + offsetSec * 1000).toISOString();
const started = (offsetSec: number): ActivityEvent => ({ timestamp: at(offsetSec), action: 'sync_started', message: 'Sync started' });
const completed = (offsetSec: number): ActivityEvent => ({ timestamp: at(offsetSec), action: 'sync_completed', message: 'Sync completed' });
const sourceError = (offsetSec: number): ActivityEvent => ({
  timestamp: at(offsetSec), action: 'error', sourceUrl: 'https://letterboxd.com/user/watchlist', mode: 'request',
  message: 'Failed to fetch source: Could not find Letterboxd film ID',
});
const itemError = (offsetSec: number): ActivityEvent => ({
  timestamp: at(offsetSec), action: 'error', sourceUrl: 'https://letterboxd.com/user/watchlist', mode: 'request',
  itemName: 'Island', tmdbId: '779114', message: 'TMDb 404',
});
const newestFirst = (events: ActivityEvent[]) => [...events].reverse();

describe('computeHealth', () => {
  it('is unhealthy when no sync has ever completed', () => {
    const h = computeHealth(newestFirst([started(0)]), 10, T0 + 60_000);
    expect(h.healthy).toBe(false);
    expect(h.reason).toMatch(/no completed sync/);
    expect(h.lastSyncStartedAt).toBe(at(0));
    expect(h.lastSyncCompletedAt).toBeNull();
  });

  it('is healthy after a clean recent cycle', () => {
    const h = computeHealth(newestFirst([started(0), completed(30)]), 10, T0 + 5 * 60_000);
    expect(h.healthy).toBe(true);
    expect(h.reason).toBeNull();
    expect(h.secondsSinceLastSyncCompleted).toBe(270);
    expect(h.lastCycleSourceErrors).toBe(0);
    expect(h.staleAfterSeconds).toBe(STALE_AFTER_CYCLES * 10 * 60);
  });

  it('goes stale when the last completion is older than three intervals', () => {
    const h = computeHealth(newestFirst([started(0), completed(30)]), 10, T0 + 31 * 60_000);
    expect(h.healthy).toBe(false);
    expect(h.reason).toMatch(/old/);
  });

  it('is unhealthy when the last cycle had a source-level failure', () => {
    const h = computeHealth(newestFirst([started(0), sourceError(5), completed(10)]), 10, T0 + 60_000);
    expect(h.healthy).toBe(false);
    expect(h.lastCycleSourceErrors).toBe(1);
    expect(h.reason).toMatch(/1 source failed/);
  });

  it('ignores per-item errors', () => {
    const h = computeHealth(newestFirst([started(0), itemError(5), completed(10)]), 10, T0 + 60_000);
    expect(h.healthy).toBe(true);
    expect(h.lastCycleSourceErrors).toBe(0);
  });

  it('only looks at the most recent completed cycle', () => {
    const events = [started(0), sourceError(5), completed(10), started(600), completed(620)];
    const h = computeHealth(newestFirst(events), 10, T0 + 700_000);
    expect(h.healthy).toBe(true);
    expect(h.lastSyncStartedAt).toBe(at(600));
    expect(h.lastSyncCompletedAt).toBe(at(620));
  });
});
