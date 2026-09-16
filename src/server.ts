import express from 'express';
import path from 'path';
import { loadState, saveState } from './util/state';
import { loadEvents, ACTIVITY_LOG_MAX_LINES } from './util/activity-log';
import { computeHealth } from './util/health';
import env from './util/env';
import logger from './util/logger';

export function createApp(runAllSources: () => Promise<void>): express.Express {
  const app = express();
  let isSyncing = false;

  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/status', async (_req, res) => {
    try {
      const health = computeHealth(await loadEvents(env.DATA_DIR, ACTIVITY_LOG_MAX_LINES), env.CHECK_INTERVAL_MINUTES);
      const state = await loadState(env.DATA_DIR);
      if (!state) {
        res.json({ sources: {}, syncing: isSyncing, activeUrls: env.letterboxdUrls, health });
        return;
      }

      const sources = Object.fromEntries(
        Object.entries(state.sources).map(([url, source]) => {
          const itemCounts: Record<string, number> = {};
          for (const item of Object.values(source.items)) {
            itemCounts[item.status] = (itemCounts[item.status] ?? 0) + 1;
          }
          return [url, {
            mode: source.mode,
            rssEtag: source.rssEtag ?? null,
            itemCounts,
            totalItems: Object.keys(source.items).length,
          }];
        })
      );

      res.json({ sources, syncing: isSyncing, activeUrls: env.letterboxdUrls, health });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  app.post('/sync', (_req, res) => {
    if (isSyncing) {
      res.status(409).json({ error: 'Sync already in progress' });
      return;
    }

    isSyncing = true;
    res.status(202).json({ message: 'Sync started' });

    runAllSources().catch(error => {
      logger.error(`Manual sync failed: ${error}`);
    }).finally(() => {
      isSyncing = false;
    });
  });

  app.get('/events', async (req, res) => {
    try {
      const rawLimit = Number(req.query.limit);
      const limit = rawLimit > 0 ? Math.min(rawLimit, 200) : 50;
      const events = await loadEvents(env.DATA_DIR, limit);
      res.json({ events });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  app.get('/sources/:sourceUrl/items', async (req, res) => {
    try {
      const sourceUrl = req.params.sourceUrl;
      const state = await loadState(env.DATA_DIR);
      if (!state) {
        res.status(404).json({ error: 'No state found' });
        return;
      }

      const source = state.sources[sourceUrl];
      if (!source) {
        res.status(404).json({ error: 'Source not found' });
        return;
      }

      res.json({ mode: source.mode, items: source.items });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  app.post('/sources/:sourceUrl/items/:itemId/requeue', async (req, res) => {
    if (isSyncing) {
      res.status(409).json({ error: 'Sync already in progress' });
      return;
    }

    try {
      const sourceUrl = req.params.sourceUrl;
      const { itemId } = req.params;
      const state = await loadState(env.DATA_DIR);

      if (!state) {
        res.status(404).json({ error: 'No state found' });
        return;
      }

      const source = state.sources[sourceUrl];
      if (!source) {
        res.status(404).json({ error: 'Source not found' });
        return;
      }

      const item = source.items[itemId];
      if (!item) {
        res.status(404).json({ error: 'Item not found' });
        return;
      }

      if (item.status !== 'acknowledged' && item.status !== 'skipped') {
        res.status(400).json({ error: `Item must be acknowledged or skipped to requeue, got: ${item.status}` });
        return;
      }

      const updatedItem = { ...item, status: 'pending' as const, retryCount: 0, lastError: null };
      const updatedState = {
        ...state,
        sources: {
          ...state.sources,
          [sourceUrl]: {
            ...source,
            items: { ...source.items, [itemId]: updatedItem },
          },
        },
      };

      await saveState(env.DATA_DIR, updatedState);
      res.json({ message: 'Item requeued', item: updatedItem });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  app.post('/sources/:sourceUrl/items/:itemId/skip', async (req, res) => {
    if (isSyncing) {
      res.status(409).json({ error: 'Sync already in progress' });
      return;
    }

    try {
      const sourceUrl = req.params.sourceUrl;
      const { itemId } = req.params;
      const state = await loadState(env.DATA_DIR);

      if (!state) {
        res.status(404).json({ error: 'No state found' });
        return;
      }

      const source = state.sources[sourceUrl];
      if (!source) {
        res.status(404).json({ error: 'Source not found' });
        return;
      }

      const item = source.items[itemId];
      if (!item) {
        res.status(404).json({ error: 'Item not found' });
        return;
      }

      if (item.status !== 'pending') {
        res.status(400).json({ error: `Item must be pending to skip, got: ${item.status}` });
        return;
      }

      const updatedItem = { ...item, status: 'skipped' as const };
      await saveState(env.DATA_DIR, {
        ...state,
        sources: {
          ...state.sources,
          [sourceUrl]: { ...source, items: { ...source.items, [itemId]: updatedItem } },
        },
      });

      res.json({ message: 'Item skipped', item: updatedItem });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  app.post('/sources/:sourceUrl/requeue-all', async (req, res) => {
    if (isSyncing) {
      res.status(409).json({ error: 'Sync already in progress' });
      return;
    }

    try {
      const sourceUrl = req.params.sourceUrl;
      const state = await loadState(env.DATA_DIR);

      if (!state) {
        res.status(404).json({ error: 'No state found' });
        return;
      }

      const source = state.sources[sourceUrl];
      if (!source) {
        res.status(404).json({ error: 'Source not found' });
        return;
      }

      if (source.mode !== 'request') {
        res.status(400).json({ error: 'Requeue All is only supported for request-mode sources' });
        return;
      }

      let count = 0;
      const updatedItems = Object.fromEntries(
        Object.entries(source.items).map(([id, item]) => {
          if (item.status === 'acknowledged' || item.status === 'skipped') {
            count++;
            return [id, { ...item, status: 'pending' as const, retryCount: 0, lastError: null }];
          }
          return [id, item];
        })
      );

      await saveState(env.DATA_DIR, {
        ...state,
        sources: { ...state.sources, [sourceUrl]: { ...source, items: updatedItems } },
      });

      res.json({ message: `${count} item${count === 1 ? '' : 's'} requeued`, count });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  app.delete('/sources/:sourceUrl', async (req, res) => {
    if (isSyncing) {
      res.status(409).json({ error: 'Sync already in progress' });
      return;
    }

    try {
      const sourceUrl = req.params.sourceUrl;

      if (env.letterboxdUrls.includes(sourceUrl)) {
        res.status(400).json({ error: 'Cannot remove an active source — remove it from LETTERBOXD_URLS first' });
        return;
      }

      const state = await loadState(env.DATA_DIR);
      if (!state || !state.sources[sourceUrl]) {
        res.status(404).json({ error: 'Source not found in state' });
        return;
      }

      const { [sourceUrl]: _removed, ...remainingSources } = state.sources;
      await saveState(env.DATA_DIR, { ...state, sources: remainingSources });
      res.json({ message: 'Source removed from state' });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  return app;
}

export function startServer(port: number, runAllSources: () => Promise<void>): void {
  const app = createApp(runAllSources);
  app.listen(port, () => {
    logger.info(`Status server listening on port ${port}`);
  });
}
