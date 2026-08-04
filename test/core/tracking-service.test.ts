import { describe, expect, it } from 'vitest';

import { TrackingService } from '../../src/core/index.js';
import { openDatabase, Repository } from '../../src/db/index.js';
import type { LigaInsiderArticle, PlayerSearchResult } from '../../src/ligainsider/index.js';

const profile: PlayerSearchResult = {
  name: 'Noah Atubolu',
  profileUrl: 'https://www.ligainsider.de/noah-atubolu_22000/',
  clubImageUrl: 'https://cdn.ligainsider.de/images/teams/small/sc-freiburg.png',
};

function article(index: number, player = profile): LigaInsiderArticle {
  return {
    title: `Article ${index}`,
    url: `${player.profileUrl}article-${index}/`,
    publishedAt: `2026-08-0${index}T10:00:00Z`,
    discoveredAt: '2026-08-07T10:00:00.000Z',
    usedFallbackDate: false,
  };
}

function setup() {
  const database = openDatabase(':memory:');
  const repository = new Repository(database);
  let now = new Date('2026-08-07T12:00:00.000Z');
  const service = new TrackingService(repository, {
    now: () => now,
    tokenFactory: () => 'fixed-private-token',
    publicBaseUrl: 'https://feeds.example.test/',
  });
  return {
    repository,
    service,
    setNow: (value: string) => {
      now = new Date(value);
    },
  };
}

describe('TrackingService', () => {
  it('seeds five feed items and keeps the first page as the known baseline', () => {
    const { repository, service } = setup();
    const result = service.addPlayer({
      guildId: 'guild-1',
      userId: 'user-1',
      profile,
      baselineArticles: [1, 2, 3, 4, 5, 6].map((index) => article(index)),
    });

    expect(result.feedCreated).toBe(true);
    expect(result.subscriptionAdded).toBe(true);
    expect(repository.listKnownArticleUrls(result.player.id)).toHaveLength(6);
    expect(repository.listFeedItems(result.feed.id)).toHaveLength(5);
    expect(repository.listDueOutbox('2026-08-07T12:00:00.000Z')).toEqual([
      expect.objectContaining({
        kind: 'bootstrap',
        payload: expect.objectContaining({
          kind: 'bootstrap',
          rssUrl: 'https://feeds.example.test/feeds/fixed-private-token.xml',
          articles: expect.arrayContaining([expect.objectContaining({ title: 'Article 6' })]),
        }),
      }),
    ]);
  });

  it('retains the channel and RSS token when tracking resumes during grace', () => {
    const { repository, service, setNow } = setup();
    const initial = service.addPlayer({
      guildId: 'guild-1',
      userId: 'user-1',
      profile,
      baselineArticles: [article(1)],
    });
    service.setChannel(initial.feed.id, 'channel-1');

    const removed = service.removePlayer('guild-1', 'user-1', initial.player.id);
    expect(removed.deleteAfter).toBe('2026-08-10T12:00:00.000Z');
    expect(repository.listFeedsDueForDeletion('2026-08-10T11:59:59.999Z')).toHaveLength(0);
    expect(repository.listFeedsDueForDeletion('2026-08-10T12:00:00.000Z')).toHaveLength(1);

    setNow('2026-08-09T12:00:00.000Z');
    const resumed = service.addPlayer({
      guildId: 'guild-1',
      userId: 'user-1',
      profile,
      baselineArticles: [article(1)],
    });

    expect(resumed.feedCreated).toBe(false);
    expect(resumed.feedReactivated).toBe(true);
    expect(resumed.feed.id).toBe(initial.feed.id);
    expect(resumed.feed.channelId).toBe('channel-1');
    expect(resumed.feed.rssToken).toBe('fixed-private-token');
    expect(resumed.feed.deleteAfter).toBeNull();
    expect(
      repository
        .listDueOutbox('2026-08-09T12:00:00.000Z')
        .filter((message) => message.kind === 'bootstrap'),
    ).toHaveLength(2);
  });

  it('fans a shared article out once with all matching players', () => {
    const { repository, service } = setup();
    const secondProfile: PlayerSearchResult = {
      name: 'Anthony Caci',
      profileUrl: 'https://www.ligainsider.de/anthony-caci_26102/',
      clubImageUrl: null,
    };
    const first = service.addPlayer({
      guildId: 'guild-1',
      userId: 'user-1',
      profile,
      baselineArticles: [],
    });
    service.addPlayer({
      guildId: 'guild-1',
      userId: 'user-1',
      profile: secondProfile,
      baselineArticles: [],
    });
    const shared: LigaInsiderArticle = {
      title: 'Shared team update',
      url: `${profile.profileUrl}shared-update-99/`,
      publishedAt: '2026-08-08T10:00:00Z',
      discoveredAt: '2026-08-08T10:01:00Z',
      usedFallbackDate: false,
    };

    const result = service.recordPollDiscoveries([
      { profile, articles: [shared] },
      { profile: secondProfile, articles: [shared] },
    ]);

    expect(result).toMatchObject({
      newPlayerArticleLinks: 2,
      newFeedItems: 1,
      outboxMessages: 1,
    });
    const item = repository.listFeedItems(first.feed.id)[0];
    expect(item?.players.map((player) => player.name)).toEqual(['Anthony Caci', 'Noah Atubolu']);
    const outbox = repository.findOutboxByEventKey<{
      kind: string;
      players: Array<{ name: string }>;
    }>(`article:${first.feed.id}:${item?.article.id}`);
    expect(outbox?.payload.players.map((player) => player.name)).toEqual([
      'Anthony Caci',
      'Noah Atubolu',
    ]);
  });

  it('updates article display data without creating another event', () => {
    const { repository, service, setNow } = setup();
    const added = service.addPlayer({
      guildId: 'guild-1',
      userId: 'user-1',
      profile,
      baselineArticles: [article(1)],
    });
    const before = repository.getFeedMetadata(added.feed.id);

    setNow('2026-08-07T12:30:00.000Z');
    service.recordPollDiscoveries([{ profile, articles: [article(1)] }]);
    expect(repository.getFeedMetadata(added.feed.id)?.latestArticleUpdatedAt).toBe(
      before?.latestArticleUpdatedAt,
    );

    setNow('2026-08-07T13:00:00.000Z');
    const result = service.recordPollDiscoveries([
      {
        profile,
        articles: [{ ...article(1), title: 'Corrected title' }],
      },
    ]);

    expect(result.newFeedItems).toBe(0);
    expect(repository.listFeedItems(added.feed.id)[0]?.article.title).toBe('Corrected title');
    expect(repository.getFeedMetadata(added.feed.id)?.itemCount).toBe(before?.itemCount);
    expect(repository.getFeedMetadata(added.feed.id)?.latestArticleUpdatedAt).toBe(
      '2026-08-07T13:00:00.000Z',
    );
  });

  it('does not consume new articles when an already tracked player is added again', () => {
    const { repository, service } = setup();
    const added = service.addPlayer({
      guildId: 'guild-1',
      userId: 'user-1',
      profile,
      baselineArticles: [],
    });
    const newlyVisible = article(1);

    const duplicate = service.addPlayer({
      guildId: 'guild-1',
      userId: 'user-1',
      profile,
      baselineArticles: [newlyVisible],
    });
    expect(duplicate.subscriptionAdded).toBe(false);
    expect(repository.listKnownArticleUrls(added.player.id)).toEqual([]);

    expect(service.recordPollDiscoveries([{ profile, articles: [newlyVisible] }])).toMatchObject({
      newPlayerArticleLinks: 1,
      newFeedItems: 1,
      outboxMessages: 1,
    });
  });

  it('releases deletion claims left behind by a stopped worker', () => {
    const { repository, service, setNow } = setup();
    const added = service.addPlayer({
      guildId: 'guild-1',
      userId: 'user-1',
      profile,
      baselineArticles: [],
    });
    service.removePlayer('guild-1', 'user-1', added.player.id);
    setNow('2026-08-10T12:00:00.000Z');

    expect(
      repository.claimFeedDeletion(
        added.feed.id,
        '2026-08-10T12:00:00.000Z',
        '2026-08-10T12:00:00.000Z',
      ),
    ).toBe(true);
    expect(repository.listFeedsDueForDeletion('2026-08-10T12:00:00.000Z')).toHaveLength(0);
    expect(repository.releaseAllFeedDeletionClaims('2026-08-10T12:01:00.000Z')).toBe(1);
    expect(repository.listFeedsDueForDeletion('2026-08-10T12:01:00.000Z')).toHaveLength(1);
  });
});
