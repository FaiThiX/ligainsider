import { describe, expect, it } from 'vitest';

import { RepositoryRssStore } from '../../src/adapters/repository-rss-store.js';
import { TrackingService } from '../../src/core/index.js';
import { openDatabase, Repository } from '../../src/db/index.js';
import { createHttpServer } from '../../src/http/index.js';
import type { LigaInsiderArticle } from '../../src/ligainsider/index.js';

const profile = {
  name: 'Noah Atubolu',
  profileUrl: 'https://www.ligainsider.de/noah-atubolu_22000/',
  clubImageUrl: null,
};

function article(index: number): LigaInsiderArticle {
  return {
    title: `Article ${index}`,
    url: `${profile.profileUrl}article-${index}/`,
    publishedAt: new Date(Date.UTC(2026, 7, 1, 0, index)).toISOString(),
    discoveredAt: '2026-08-04T12:00:00.000Z',
    usedFallbackDate: false,
  };
}

describe('repository-backed RSS lifecycle', () => {
  it('keeps unbounded history, rotates tokens, and returns 404 after cleanup', async () => {
    const repository = new Repository(openDatabase(':memory:'));
    let now = new Date('2026-08-04T12:00:00.000Z');
    const tokens = ['A'.repeat(43), 'B'.repeat(43)];
    const tracking = new TrackingService(repository, {
      now: () => now,
      tokenFactory: () => tokens.shift() as string,
    });
    const added = tracking.addPlayer({
      guildId: 'guild',
      userId: 'user',
      profile,
      baselineArticles: [1, 2, 3, 4, 5, 6].map(article),
    });
    tracking.recordPollDiscoveries([
      { profile, articles: Array.from({ length: 30 }, (_, index) => article(index + 100)) },
    ]);
    const server = createHttpServer({
      loggerLevel: 'silent',
      publicBaseUrl: 'https://feeds.example.test',
      readiness: () => true,
      rssStore: new RepositoryRssStore(repository),
    });

    const original = await server.inject({
      method: 'GET',
      url: `/feeds/${'A'.repeat(43)}.xml`,
    });
    expect(original.statusCode).toBe(200);
    expect(original.body.match(/<item>/g)).toHaveLength(35);
    expect(original.body).toContain('<guid isPermaLink="true">');

    tracking.rotateRssToken('guild', 'user');
    expect(
      (await server.inject({ method: 'GET', url: `/feeds/${'A'.repeat(43)}.xml` })).statusCode,
    ).toBe(404);
    expect(
      (await server.inject({ method: 'GET', url: `/feeds/${'B'.repeat(43)}.xml` })).statusCode,
    ).toBe(200);

    tracking.removePlayer('guild', 'user', added.player.id);
    now = new Date('2026-08-07T12:00:00.000Z');
    expect(
      repository.claimFeedDeletion(added.feed.id, '2026-08-07T12:00:00.000Z', now.toISOString()),
    ).toBe(true);
    expect(repository.deleteClaimedFeed(added.feed.id, '2026-08-07T12:00:00.000Z')).toBe(true);
    expect(
      (await server.inject({ method: 'GET', url: `/feeds/${'B'.repeat(43)}.xml` })).statusCode,
    ).toBe(404);

    await server.close();
  });
});
