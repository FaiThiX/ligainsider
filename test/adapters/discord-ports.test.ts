import { describe, expect, it, vi } from 'vitest';

import { RepositoryDiscordPorts } from '../../src/adapters/discord-ports.js';
import { TrackingService } from '../../src/core/index.js';
import { openDatabase, Repository } from '../../src/db/index.js';
import type {
  LigaInsiderArticle,
  LigaInsiderClient,
  PlayerProfilePage,
} from '../../src/ligainsider/index.js';

const profile = {
  name: 'Noah Atubolu',
  profileUrl: 'https://www.ligainsider.de/noah-atubolu_22000/',
  clubImageUrl: 'https://cdn.ligainsider.de/images/teams/small/sc-freiburg.png',
};

function sourceArticle(index: number): LigaInsiderArticle {
  return {
    title: `Source article ${index}`,
    url: `${profile.profileUrl}source-article-${index}/`,
    publishedAt: `2026-08-0${index}T10:00:00.000Z`,
    discoveredAt: '2026-08-07T12:00:00.000Z',
    usedFallbackDate: false,
  };
}

function setup() {
  const repository = new Repository(openDatabase(':memory:'));
  let now = new Date('2026-08-07T12:00:00.000Z');
  const tokens = ['A'.repeat(43), 'B'.repeat(43), 'C'.repeat(43)];
  const trackingService = new TrackingService(repository, {
    now: () => now,
    publicBaseUrl: 'https://feeds.example.test',
    tokenFactory: () => tokens.shift() ?? 'Z'.repeat(43),
  });
  const page: PlayerProfilePage = {
    player: profile,
    articles: [1, 2, 3, 4, 5, 6].map(sourceArticle),
    nextPageUrl: null,
  };
  const client = {
    resolvePlayer: vi.fn(async () => [profile]),
    fetchPlayerProfilePage: vi.fn(async () => page),
  } as unknown as LigaInsiderClient;
  const ports = new RepositoryDiscordPorts({
    repository,
    trackingService,
    ligaInsiderClient: client,
    publicBaseUrl: 'https://feeds.example.test/',
    now: () => now,
  });
  return {
    client,
    ports,
    repository,
    setNow(value: string) {
      now = new Date(value);
    },
  };
}

describe('RepositoryDiscordPorts', () => {
  it('resolves names but rejects URLs outside the source allowlist', async () => {
    const { client, ports } = setup();

    await expect(ports.resolvePlayerQuery('Noah Atubolu')).resolves.toMatchObject({
      kind: 'resolved',
      player: { name: 'Noah Atubolu', key: profile.profileUrl },
    });
    await expect(ports.resolvePlayerQuery('https://example.com/player_1/')).resolves.toEqual({
      kind: 'not-found',
    });
    expect(client.resolvePlayer).toHaveBeenCalledTimes(1);

    vi.mocked(client.resolvePlayer)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        profile,
        {
          name: 'Anthony Caci',
          profileUrl: 'https://www.ligainsider.de/anthony-caci_26102/',
          clubImageUrl: null,
        },
      ]);
    await expect(ports.resolvePlayerQuery('Unknown')).resolves.toEqual({ kind: 'not-found' });
    await expect(ports.resolvePlayerQuery('Player')).resolves.toMatchObject({
      kind: 'multiple',
      players: [{ name: 'Noah Atubolu' }, { name: 'Anthony Caci' }],
    });
    await expect(ports.resolvePlayerQuery('  ')).resolves.toEqual({ kind: 'not-found' });
  });

  it('maps first add, listing, duplicate add, rotation, and grace reactivation', async () => {
    const { ports, repository, setNow } = setup();
    const candidate = { key: profile.profileUrl, ...profile };

    const added = await ports.addPlayer({
      guildId: 'guild-1',
      userId: 'user-1',
      player: candidate,
    });
    expect(added).toMatchObject({
      kind: 'added',
      firstPlayer: true,
      reactivated: false,
      feed: {
        rssUrl: `https://feeds.example.test/feeds/${'A'.repeat(43)}.xml`,
      },
    });
    expect(await ports.listPlayers({ guildId: 'guild-1', userId: 'user-1' })).toEqual([
      expect.objectContaining({ name: 'Noah Atubolu', trackedSince: expect.any(String) }),
    ]);

    await expect(
      ports.addPlayer({ guildId: 'guild-1', userId: 'user-1', player: candidate }),
    ).resolves.toMatchObject({ kind: 'already-tracked' });
    const rotated = await ports.rotateRssFeed({ guildId: 'guild-1', userId: 'user-1' });
    expect(rotated?.feed.rssUrl).toContain('B'.repeat(43));
    expect(await ports.getRssFeed({ guildId: 'guild-1', userId: 'user-1' })).toEqual(rotated);

    const feed = repository.findFeedByUser('guild-1', 'user-1');
    expect(feed).not.toBeNull();
    expect(
      await ports.attachChannel({
        feedId: feed?.id as number,
        channelId: 'private-channel',
        previousChannelId: null,
      }),
    ).toBe(true);
    const playerId = String(
      (await ports.listPlayers({ guildId: 'guild-1', userId: 'user-1' }))[0]?.id,
    );
    const removed = await ports.removePlayer({
      guildId: 'guild-1',
      userId: 'user-1',
      playerId,
    });
    expect(removed).toMatchObject({
      kind: 'removed',
      remainingCount: 0,
      deleteAfter: '2026-08-10T12:00:00.000Z',
    });

    setNow('2026-08-09T12:00:00.000Z');
    const reactivated = await ports.addPlayer({
      guildId: 'guild-1',
      userId: 'user-1',
      player: candidate,
    });
    expect(reactivated).toMatchObject({
      kind: 'added',
      reactivated: true,
      feed: { id: feed?.id, channelId: 'private-channel' },
    });
    expect((reactivated.kind === 'added' && reactivated.feed.rssUrl) || '').toContain(
      'B'.repeat(43),
    );
    expect(await ports.listFeedsForChannelReconciliation(10)).toEqual([
      expect.objectContaining({ id: feed?.id, channelId: 'private-channel' }),
    ]);
    await ports.markChannelMissing({ guildId: 'guild-1', channelId: 'private-channel' });
    expect((await ports.getFeed(feed?.id as number))?.channelId).toBeNull();
    await ports.markMemberDeparted({
      guildId: 'guild-1',
      userId: 'user-1',
      leftAt: '2026-08-09T12:00:00.000Z',
    });
    expect((await ports.getFeed(feed?.id as number))?.status).toBe('grace');
  });

  it('claims expiration atomically and revokes all feed data after cleanup', async () => {
    const { ports, repository, setNow } = setup();
    const added = await ports.addPlayer({
      guildId: 'guild-1',
      userId: 'user-1',
      player: { key: profile.profileUrl, ...profile },
    });
    const playerId = String(added.player.id);
    await ports.removePlayer({ guildId: 'guild-1', userId: 'user-1', playerId });
    setNow('2026-08-10T12:00:00.000Z');

    const due = await ports.listFeedsDueForDeletion({
      now: '2026-08-10T12:00:00.000Z',
      limit: 10,
    });
    expect(due).toHaveLength(1);
    const deletion = due[0];
    expect(deletion).toBeDefined();
    expect(
      await ports.beginFeedDeletion({
        feedId: deletion?.feed.id as number,
        expectedDeleteAfter: deletion?.expectedDeleteAfter as string,
      }),
    ).toBe(true);
    await ports.releaseFeedDeletion({
      feedId: deletion?.feed.id as number,
      expectedDeleteAfter: deletion?.expectedDeleteAfter as string,
      error: 'Discord unavailable',
    });
    expect(
      await ports.listFeedsDueForDeletion({ now: '2026-08-10T12:00:00.000Z', limit: 10 }),
    ).toHaveLength(1);
    expect(
      await ports.beginFeedDeletion({
        feedId: deletion?.feed.id as number,
        expectedDeleteAfter: deletion?.expectedDeleteAfter as string,
      }),
    ).toBe(true);
    await ports.completeFeedDeletion({
      feedId: deletion?.feed.id as number,
      expectedDeleteAfter: deletion?.expectedDeleteAfter as string,
    });

    expect(repository.findFeedByUser('guild-1', 'user-1')).toBeNull();
    expect(repository.findFeedByToken('A'.repeat(43))).toBeNull();
    expect(await ports.getFeed(deletion?.feed.id as number)).toBeNull();
  });

  it('serializes a new add behind an already claimed cleanup', async () => {
    const { ports, repository, setNow } = setup();
    const candidate = { key: profile.profileUrl, ...profile };
    const original = await ports.addPlayer({
      guildId: 'guild-1',
      userId: 'user-1',
      player: candidate,
    });
    await ports.removePlayer({
      guildId: 'guild-1',
      userId: 'user-1',
      playerId: String(original.player.id),
    });
    setNow('2026-08-10T12:00:00.000Z');
    const deletion = (
      await ports.listFeedsDueForDeletion({ now: '2026-08-10T12:00:00.000Z', limit: 1 })
    )[0];
    expect(
      await ports.beginFeedDeletion({
        feedId: deletion?.feed.id as number,
        expectedDeleteAfter: deletion?.expectedDeleteAfter as string,
      }),
    ).toBe(true);

    let addSettled = false;
    const pendingAdd = ports
      .addPlayer({ guildId: 'guild-1', userId: 'user-1', player: candidate })
      .finally(() => {
        addSettled = true;
      });
    await Promise.resolve();
    expect(addSettled).toBe(false);
    await ports.completeFeedDeletion({
      feedId: deletion?.feed.id as number,
      expectedDeleteAfter: deletion?.expectedDeleteAfter as string,
    });

    const replacement = await pendingAdd;
    expect(replacement.feed.id).not.toBe(original.feed.id);
    expect(replacement.feed.rssUrl).toContain('B'.repeat(43));
    expect(repository.findFeedByToken('A'.repeat(43))).toBeNull();
  });

  it('validates persisted outbox payloads and records delivery state', async () => {
    const { ports, repository } = setup();
    const added = await ports.addPlayer({
      guildId: 'guild-1',
      userId: 'user-1',
      player: { key: profile.profileUrl, ...profile },
    });
    const item = await ports.getNextDue('2026-08-07T12:00:00.000Z');
    expect(item).toMatchObject({ payload: { kind: 'bootstrap' } });
    await ports.markDelivered({
      outboxId: item?.id as number,
      discordMessageId: 'message-1',
      deliveredAt: '2026-08-07T12:00:01.000Z',
    });
    expect(await ports.getNextDue('2026-08-07T12:00:01.000Z')).toBeNull();

    repository.enqueueOutbox({
      feedId: added.feed.id as number,
      eventKey: 'invalid-payload',
      kind: 'article',
      payload: { unexpected: true },
      now: '2026-08-07T12:00:02.000Z',
    });
    expect(await ports.getNextDue('2026-08-07T12:00:02.000Z')).toBeNull();
    expect(repository.findOutboxByEventKey('invalid-payload')?.status).toBe('dead');

    repository.enqueueOutbox({
      feedId: added.feed.id as number,
      eventKey: 'retry-payload',
      kind: 'deletion-warning',
      payload: { kind: 'deletion-warning', deleteAfter: '2026-08-10T12:00:00.000Z' },
      now: '2026-08-07T12:00:03.000Z',
    });
    const retryItem = await ports.getNextDue('2026-08-07T12:00:03.000Z');
    await ports.reschedule({
      outboxId: retryItem?.id as number,
      attempts: 1,
      nextAttemptAt: '2026-08-07T12:01:00.000Z',
      error: 'temporary failure',
    });
    expect(await ports.getNextDue('2026-08-07T12:00:59.000Z')).toBeNull();
    const retried = await ports.getNextDue('2026-08-07T12:01:00.000Z');
    expect(retried?.attempts).toBe(1);
    await ports.markDead({
      outboxId: retried?.id as number,
      attempts: 2,
      error: 'missing permissions',
    });
    expect(repository.findOutboxByEventKey('retry-payload')?.status).toBe('dead');
  });
});
