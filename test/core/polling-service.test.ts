import { describe, expect, it, vi } from 'vitest';

import { KeyedMutex, PollingService, TrackingService } from '../../src/core/index.js';
import { openDatabase, Repository } from '../../src/db/index.js';
import type { LigaInsiderClient, PlayerNewsResult } from '../../src/ligainsider/index.js';

const profile = {
  name: 'Noah Atubolu',
  profileUrl: 'https://www.ligainsider.de/noah-atubolu_22000/',
  clubImageUrl: null,
};

function setup(client: LigaInsiderClient) {
  const repository = new Repository(openDatabase(':memory:'));
  const tracking = new TrackingService(repository, {
    now: () => new Date('2026-08-04T12:00:00.000Z'),
    tokenFactory: () => 'A'.repeat(43),
  });
  tracking.addPlayer({
    guildId: 'guild',
    userId: 'user',
    profile,
    baselineArticles: [],
  });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    repository,
    tracking,
    logger,
    polling: new PollingService(repository, tracking, client, {
      intervalMs: 60_000,
      maxCatchUpPages: 10,
      logger,
    }),
  };
}

describe('PollingService', () => {
  it('polls each active player and persists newly discovered articles', async () => {
    const result: PlayerNewsResult = {
      player: profile,
      articles: [
        {
          title: 'Training update',
          url: `${profile.profileUrl}training-update/`,
          publishedAt: '2026-08-04T11:00:00.000Z',
          discoveredAt: '2026-08-04T12:00:00.000Z',
          usedFallbackDate: false,
        },
      ],
      pagesFetched: 1,
      truncated: false,
    };
    const fetchNewsPages = vi.fn(async () => result);
    const { polling, repository, logger } = setup({
      fetchNewsPages,
    } as unknown as LigaInsiderClient);

    await expect(polling.runOnce()).resolves.toMatchObject({
      playersProcessed: 1,
      failedPlayers: 0,
      newFeedItems: 1,
      outboxMessages: 1,
      skipped: false,
    });
    expect(fetchNewsPages).toHaveBeenCalledWith(
      profile.profileUrl,
      expect.objectContaining({
        maxPages: 10,
        stopWhen: expect.any(Function),
      }),
    );
    expect(repository.listFeedItems(1)).toHaveLength(1);
    expect(logger.info).toHaveBeenCalled();
  });

  it('skips overlap, waits during stop, and reports individual source failures', async () => {
    let resolveFetch: ((value: PlayerNewsResult) => void) | undefined;
    const fetchNewsPages = vi.fn(
      () =>
        new Promise<PlayerNewsResult>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const { polling, logger } = setup({ fetchNewsPages } as unknown as LigaInsiderClient);

    const running = polling.runOnce();
    await expect(polling.runOnce()).resolves.toMatchObject({ skipped: true });
    const stopping = polling.stop();
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    resolveFetch?.({
      player: profile,
      articles: [],
      pagesFetched: 1,
      truncated: false,
    });
    await running;
    await stopping;
    expect(stopped).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith({}, 'Skipped an overlapping player news poll.');

    fetchNewsPages.mockRejectedValueOnce(new Error('source unavailable'));
    await expect(polling.runOnce()).resolves.toMatchObject({ failedPlayers: 1, skipped: false });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'source unavailable' }),
      'Failed to poll a LigaInsider player profile.',
    );
  });
});

describe('KeyedMutex', () => {
  it('serializes the same key while allowing another key to run', async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const first = mutex.runExclusive('user-1', async () => {
      events.push('first-start');
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      events.push('first-end');
    });
    const second = mutex.runExclusive('user-1', async () => {
      events.push('second');
    });
    await mutex.runExclusive('user-2', async () => {
      events.push('other');
    });

    expect(events).toEqual(['first-start', 'other']);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(events).toEqual(['first-start', 'other', 'first-end', 'second']);
  });
});
