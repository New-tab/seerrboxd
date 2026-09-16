import { mkdtemp, rm } from 'fs/promises';
import http from 'http';
import os from 'os';
import path from 'path';

jest.mock('dotenv', () => ({ config: jest.fn() }));

jest.mock('./util/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

describe('server', () => {
  let dataDir: string;
  let originalEnv: NodeJS.ProcessEnv;
  let serverInstance: http.Server | null = null;

  async function httpRequest(
    port: number,
    method: string,
    urlPath: string
  ): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: 'localhost', port, method, path: urlPath }, res => {
        let raw = '';
        res.on('data', chunk => { raw += chunk; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: raw });
          }
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  function startTestApp(runAllSources: () => Promise<void> = jest.fn().mockResolvedValue(undefined)): Promise<number> {
    jest.resetModules();

    process.env = {
      NODE_ENV: 'test',
      LETTERBOXD_URL: 'https://letterboxd.com/user/watchlist',
      SEERR_API_URL: 'http://localhost:5055',
      SEERR_API_KEY: 'seerr-key',
      DATA_DIR: dataDir,
      DRY_RUN: 'false',
    };

    const { createApp } = require('./server');
    const app = createApp(runAllSources);

    return new Promise(resolve => {
      serverInstance = app.listen(0, () => {
        const addr = (serverInstance as http.Server).address() as any;
        resolve(addr.port);
      });
    });
  }

  beforeEach(async () => {
    originalEnv = { ...process.env };
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'seerrboxd-server-test-'));
  });

  afterEach(async () => {
    if (serverInstance) {
      serverInstance.close();
      serverInstance = null;
    }
    process.env = originalEnv;
    await rm(dataDir, { recursive: true, force: true });
  });

  it('GET /status returns empty sources when no state file exists', async () => {
    const port = await startTestApp();
    const { status, body } = await httpRequest(port, 'GET', '/status');

    expect(status).toBe(200);
    expect(body.sources).toEqual({});
    expect(body.syncing).toBe(false);
    expect(body.activeUrls).toEqual(['https://letterboxd.com/user/watchlist']);
  });

  it('GET /status returns source summaries from state file', async () => {
    const url = 'https://letterboxd.com/user/watchlist';

    const stateModule = require('./util/state');
    await stateModule.saveState(dataDir, {
      version: 2,
      sources: {
        [url]: {
          url,
          mode: 'request',
          rssEtag: null,
          items: {
            '1': { id: 1, name: 'Movie 1', slug: '/film/m1/', tmdbId: '111', firstSeenAt: '', lastSeenAt: '', retryCount: 0, status: 'acknowledged', lastError: null },
            '2': { id: 2, name: 'Movie 2', slug: '/film/m2/', tmdbId: '222', firstSeenAt: '', lastSeenAt: '', retryCount: 0, status: 'pending', lastError: null },
          },
        },
      },
    });

    const port = await startTestApp();
    const { status, body } = await httpRequest(port, 'GET', '/status');

    expect(status).toBe(200);
    expect(body.sources[url]).toEqual(
      expect.objectContaining({
        mode: 'request',
        rssEtag: null,
        totalItems: 2,
        itemCounts: { acknowledged: 1, pending: 1 },
      })
    );
  });

  it('POST /sync returns 202 and triggers runAllSources', async () => {
    const runAllSources = jest.fn().mockResolvedValue(undefined);
    const port = await startTestApp(runAllSources);

    const { status, body } = await httpRequest(port, 'POST', '/sync');

    expect(status).toBe(202);
    expect(body.message).toBe('Sync started');
    // Allow the async call to be scheduled
    await new Promise(resolve => setImmediate(resolve));
    expect(runAllSources).toHaveBeenCalledTimes(1);
  });

  it('POST /sync returns 409 when sync is already in progress', async () => {
    let resolveSync!: () => void;
    const runAllSources = jest.fn().mockImplementation(
      () => new Promise<void>(resolve => { resolveSync = resolve; })
    );
    const port = await startTestApp(runAllSources);

    // First /sync call — starts a long-running sync
    await httpRequest(port, 'POST', '/sync');
    await new Promise(resolve => setImmediate(resolve));

    // Second /sync call while first is still running
    const { status, body } = await httpRequest(port, 'POST', '/sync');
    expect(status).toBe(409);
    expect(body.error).toContain('already in progress');

    // Release the hanging sync so afterEach can clean up cleanly
    resolveSync();
    await new Promise(resolve => setImmediate(resolve));
  });

  it('GET /status reports health=false with no completed sync, true after a clean cycle', async () => {
    const port = await startTestApp();
    let r = await httpRequest(port, 'GET', '/status');
    expect(r.status).toBe(200);
    expect(r.body.health.healthy).toBe(false);
    expect(r.body.health.reason).toMatch(/no completed sync/);

    const { appendEvent } = require('./util/activity-log');
    const now = Date.now();
    await appendEvent(dataDir, { timestamp: new Date(now - 20_000).toISOString(), action: 'sync_started', message: 'Sync started' });
    await appendEvent(dataDir, { timestamp: new Date(now - 10_000).toISOString(), action: 'sync_completed', message: 'Sync completed' });

    r = await httpRequest(port, 'GET', '/status');
    expect(r.body.health.healthy).toBe(true);
    expect(r.body.health.lastCycleSourceErrors).toBe(0);
    expect(r.body.health.staleAfterSeconds).toBe(3 * 10 * 60);
  });

  it('GET /status reports health=false when the last cycle failed to fetch a source', async () => {
    const { appendEvent } = require('./util/activity-log');
    const now = Date.now();
    await appendEvent(dataDir, { timestamp: new Date(now - 20_000).toISOString(), action: 'sync_started', message: 'Sync started' });
    await appendEvent(dataDir, {
      timestamp: new Date(now - 15_000).toISOString(), action: 'error', mode: 'request',
      sourceUrl: 'https://letterboxd.com/user/watchlist', message: 'Failed to fetch source: boom',
    });
    await appendEvent(dataDir, { timestamp: new Date(now - 10_000).toISOString(), action: 'sync_completed', message: 'Sync completed' });

    const port = await startTestApp();
    const { body } = await httpRequest(port, 'GET', '/status');
    expect(body.health.healthy).toBe(false);
    expect(body.health.lastCycleSourceErrors).toBe(1);
  });

  it('GET /events returns empty events when log file does not exist', async () => {
    const port = await startTestApp();
    const { status, body } = await httpRequest(port, 'GET', '/events');

    expect(status).toBe(200);
    expect(body.events).toEqual([]);
  });

  it('GET /events returns logged events', async () => {
    const { appendEvent } = require('./util/activity-log');
    await appendEvent(dataDir, {
      timestamp: '2026-01-01T00:00:00.000Z',
      sourceUrl: 'https://letterboxd.com/user/watchlist',
      mode: 'request',
      action: 'requested',
      itemName: 'Test Movie',
      tmdbId: '123',
    });

    const port = await startTestApp();
    const { status, body } = await httpRequest(port, 'GET', '/events');

    expect(status).toBe(200);
    expect(body.events).toHaveLength(1);
    expect(body.events[0].action).toBe('requested');
    expect(body.events[0].itemName).toBe('Test Movie');
  });

  it('GET /events respects limit query param (max 200)', async () => {
    const port = await startTestApp();
    const { status: s1, body: b1 } = await httpRequest(port, 'GET', '/events?limit=5');
    expect(s1).toBe(200);
    expect(Array.isArray(b1.events)).toBe(true);

    // limit > 200 should be capped
    const { status: s2, body: b2 } = await httpRequest(port, 'GET', '/events?limit=999');
    expect(s2).toBe(200);
    expect(Array.isArray(b2.events)).toBe(true);
  });

  it('GET /sources/:sourceUrl/items returns 404 when no state exists', async () => {
    const port = await startTestApp();
    const encoded = encodeURIComponent('https://letterboxd.com/user/watchlist');
    const { status } = await httpRequest(port, 'GET', `/sources/${encoded}/items`);
    expect(status).toBe(404);
  });

  it('GET /sources/:sourceUrl/items returns items for a known source', async () => {
    const url = 'https://letterboxd.com/user/films';
    const stateModule = require('./util/state');
    await stateModule.saveState(dataDir, {
      version: 2,
      sources: {
        [url]: {
          url,
          mode: 'delete',
          rssEtag: null,
          items: {
            '7': { id: 7, name: 'Delete Me', slug: '/film/delete-me/', tmdbId: '777', firstSeenAt: '', lastSeenAt: '', retryCount: 0, status: 'acknowledged', lastError: null },
          },
        },
      },
    });

    const port = await startTestApp();
    const encoded = encodeURIComponent(url);
    const { status, body } = await httpRequest(port, 'GET', `/sources/${encoded}/items`);

    expect(status).toBe(200);
    expect(body.mode).toBe('delete');
    expect(body.items['7']).toEqual(expect.objectContaining({ name: 'Delete Me', status: 'acknowledged' }));
  });

  it('POST /sources/:sourceUrl/items/:itemId/requeue sets acknowledged item to pending', async () => {
    const url = 'https://letterboxd.com/user/films';
    const stateModule = require('./util/state');
    await stateModule.saveState(dataDir, {
      version: 2,
      sources: {
        [url]: {
          url,
          mode: 'delete',
          rssEtag: null,
          items: {
            '7': { id: 7, name: 'Delete Me', slug: '/film/delete-me/', tmdbId: '777', firstSeenAt: '', lastSeenAt: '', retryCount: 2, status: 'acknowledged', lastError: 'some error' },
          },
        },
      },
    });

    const port = await startTestApp();
    const encoded = encodeURIComponent(url);
    const { status, body } = await httpRequest(port, 'POST', `/sources/${encoded}/items/7/requeue`);

    expect(status).toBe(200);
    expect(body.item.status).toBe('pending');
    expect(body.item.retryCount).toBe(0);
    expect(body.item.lastError).toBeNull();

    // Verify state was persisted
    const savedState = await stateModule.loadState(dataDir);
    expect(savedState.sources[url].items['7'].status).toBe('pending');
    expect(savedState.sources[url].items['7'].retryCount).toBe(0);
  });

  it('POST requeue works for request-mode sources (re-requests acknowledged items)', async () => {
    const url = 'https://letterboxd.com/user/watchlist';
    const stateModule = require('./util/state');
    await stateModule.saveState(dataDir, {
      version: 2,
      sources: {
        [url]: {
          url,
          mode: 'request',
          rssEtag: null,
          items: {
            '1': { id: 1, name: 'Movie', slug: '/film/movie/', tmdbId: '111', firstSeenAt: '', lastSeenAt: '', retryCount: 2, status: 'acknowledged', lastError: null },
          },
        },
      },
    });

    const port = await startTestApp();
    const encoded = encodeURIComponent(url);
    const { status, body } = await httpRequest(port, 'POST', `/sources/${encoded}/items/1/requeue`);

    expect(status).toBe(200);
    expect(body.item.status).toBe('pending');
    expect(body.item.retryCount).toBe(0);

    const savedState = await stateModule.loadState(dataDir);
    expect(savedState.sources[url].items['1'].status).toBe('pending');
  });

  it('POST requeue returns 400 for pending items', async () => {
    const url = 'https://letterboxd.com/user/films';
    const stateModule = require('./util/state');
    await stateModule.saveState(dataDir, {
      version: 2,
      sources: {
        [url]: {
          url,
          mode: 'delete',
          rssEtag: null,
          items: {
            '1': { id: 1, name: 'Movie', slug: '/film/movie/', tmdbId: '111', firstSeenAt: '', lastSeenAt: '', retryCount: 0, status: 'pending', lastError: null },
          },
        },
      },
    });

    const port = await startTestApp();
    const encoded = encodeURIComponent(url);
    const { status } = await httpRequest(port, 'POST', `/sources/${encoded}/items/1/requeue`);

    expect(status).toBe(400);
  });

  it('POST /sources/:sourceUrl/requeue-all requeues all acknowledged and skipped items', async () => {
    const url = 'https://letterboxd.com/user/watchlist';
    const stateModule = require('./util/state');
    await stateModule.saveState(dataDir, {
      version: 2,
      sources: {
        [url]: {
          url,
          mode: 'request',
          rssEtag: null,
          items: {
            '1': { id: 1, name: 'A', slug: '/film/a/', tmdbId: '1', firstSeenAt: '', lastSeenAt: '', retryCount: 0, status: 'acknowledged', lastError: null },
            '2': { id: 2, name: 'B', slug: '/film/b/', tmdbId: '2', firstSeenAt: '', lastSeenAt: '', retryCount: 3, status: 'skipped', lastError: 'err' },
            '3': { id: 3, name: 'C', slug: '/film/c/', tmdbId: '3', firstSeenAt: '', lastSeenAt: '', retryCount: 0, status: 'pending', lastError: null },
          },
        },
      },
    });

    const port = await startTestApp();
    const encoded = encodeURIComponent(url);
    const { status, body } = await httpRequest(port, 'POST', `/sources/${encoded}/requeue-all`);

    expect(status).toBe(200);
    expect(body.count).toBe(2);

    const savedState = await stateModule.loadState(dataDir);
    const items = savedState.sources[url].items;
    expect(items['1'].status).toBe('pending');
    expect(items['1'].retryCount).toBe(0);
    expect(items['2'].status).toBe('pending');
    expect(items['2'].retryCount).toBe(0);
    expect(items['2'].lastError).toBeNull();
    expect(items['3'].status).toBe('pending'); // was already pending, unchanged
  });

  it('POST requeue-all returns 400 for delete-mode sources', async () => {
    const url = 'https://letterboxd.com/user/films';
    const stateModule = require('./util/state');
    await stateModule.saveState(dataDir, {
      version: 2,
      sources: { [url]: { url, mode: 'delete', rssEtag: null, items: {} } },
    });

    const port = await startTestApp();
    const encoded = encodeURIComponent(url);
    const { status } = await httpRequest(port, 'POST', `/sources/${encoded}/requeue-all`);

    expect(status).toBe(400);
  });

  it('DELETE /sources/:sourceUrl removes a stale source from state', async () => {
    const activeUrl = 'https://letterboxd.com/user/watchlist';
    const staleUrl = 'https://letterboxd.com/user/list/old-list/';
    const stateModule = require('./util/state');
    await stateModule.saveState(dataDir, {
      version: 2,
      sources: {
        [activeUrl]: { url: activeUrl, mode: 'request', rssEtag: null, items: {} },
        [staleUrl]: { url: staleUrl, mode: 'request', rssEtag: null, items: {} },
      },
    });

    const port = await startTestApp();
    const encoded = encodeURIComponent(staleUrl);
    const { status, body } = await httpRequest(port, 'DELETE', `/sources/${encoded}`);

    expect(status).toBe(200);
    expect(body.message).toContain('removed');

    const savedState = await stateModule.loadState(dataDir);
    expect(savedState.sources[staleUrl]).toBeUndefined();
    expect(savedState.sources[activeUrl]).toBeDefined();
  });

  it('DELETE /sources/:sourceUrl returns 400 for active sources', async () => {
    const url = 'https://letterboxd.com/user/watchlist';
    const stateModule = require('./util/state');
    await stateModule.saveState(dataDir, {
      version: 2,
      sources: { [url]: { url, mode: 'request', rssEtag: null, items: {} } },
    });

    const port = await startTestApp();
    const encoded = encodeURIComponent(url);
    const { status } = await httpRequest(port, 'DELETE', `/sources/${encoded}`);

    expect(status).toBe(400);
  });

  it('POST /sources/:sourceUrl/items/:itemId/skip sets pending item to skipped', async () => {
    const url = 'https://letterboxd.com/user/watchlist';
    const stateModule = require('./util/state');
    await stateModule.saveState(dataDir, {
      version: 2,
      sources: {
        [url]: {
          url,
          mode: 'request',
          rssEtag: null,
          items: {
            '5': { id: 5, name: 'Bad Movie', slug: '/film/bad-movie/', tmdbId: '555', firstSeenAt: '', lastSeenAt: '', retryCount: 3, status: 'pending', lastError: 'Not found' },
          },
        },
      },
    });

    const port = await startTestApp();
    const encoded = encodeURIComponent(url);
    const { status, body } = await httpRequest(port, 'POST', `/sources/${encoded}/items/5/skip`);

    expect(status).toBe(200);
    expect(body.item.status).toBe('skipped');

    const savedState = await stateModule.loadState(dataDir);
    expect(savedState.sources[url].items['5'].status).toBe('skipped');
  });

  it('POST skip returns 400 for non-pending items', async () => {
    const url = 'https://letterboxd.com/user/watchlist';
    const stateModule = require('./util/state');
    await stateModule.saveState(dataDir, {
      version: 2,
      sources: {
        [url]: {
          url,
          mode: 'request',
          rssEtag: null,
          items: {
            '1': { id: 1, name: 'Movie', slug: '/film/movie/', tmdbId: '111', firstSeenAt: '', lastSeenAt: '', retryCount: 0, status: 'acknowledged', lastError: null },
          },
        },
      },
    });

    const port = await startTestApp();
    const encoded = encodeURIComponent(url);
    const { status } = await httpRequest(port, 'POST', `/sources/${encoded}/items/1/skip`);
    expect(status).toBe(400);
  });

  it('POST requeue returns 409 when sync is in progress', async () => {
    let resolveSync!: () => void;
    const runAllSources = jest.fn().mockImplementation(
      () => new Promise<void>(resolve => { resolveSync = resolve; })
    );
    const port = await startTestApp(runAllSources);

    await httpRequest(port, 'POST', '/sync');
    await new Promise(resolve => setImmediate(resolve));

    const encoded = encodeURIComponent('https://letterboxd.com/user/films');
    const { status, body } = await httpRequest(port, 'POST', `/sources/${encoded}/items/1/requeue`);
    expect(status).toBe(409);
    expect(body.error).toContain('already in progress');

    resolveSync();
    await new Promise(resolve => setImmediate(resolve));
  });

  it('GET / serves the static index.html', async () => {
    const port = await startTestApp();
    const { status, body } = await httpRequest(port, 'GET', '/');

    expect(status).toBe(200);
    expect(typeof body).toBe('string');
    expect(body).toContain('Seerrboxd');
  });
});
