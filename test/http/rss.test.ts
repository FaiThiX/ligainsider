import { describe, expect, it } from 'vitest';

import { createHttpServer } from '../../src/http/server.js';
import type { RssFeed, RssFeedItem, RssFeedSnapshot, RssStore } from '../../src/http/rss.js';

const token = 'A'.repeat(43);
const feed: RssFeed = {
  id: 7,
  token,
  updatedAt: '2026-08-04T12:00:00.000Z',
};
const items: RssFeedItem[] = [
  {
    id: 2,
    title: 'News with <unsafe> & text',
    sourceUrl: 'https://www.ligainsider.de/player_1/article-2/',
    publishedAt: '2026-08-04T11:00:00.000Z',
    addedAt: '2026-08-04T11:01:00.000Z',
    playerNames: ['Player One'],
  },
  {
    id: 1,
    title: 'Older news',
    sourceUrl: 'https://www.ligainsider.de/player_1/article-1/',
    publishedAt: '2026-08-03T11:00:00.000Z',
    addedAt: '2026-08-03T11:01:00.000Z',
    playerNames: ['Player One', 'Player Two'],
  },
];

class FakeRssStore implements RssStore {
  public findFeedByToken(candidate: string): RssFeed | null {
    return candidate === token ? feed : null;
  }

  public getFeedSnapshot(): RssFeedSnapshot {
    return {
      itemCount: items.length,
      lastChangedAt: feed.updatedAt,
      revision: '2:2026-08-04T12:00:00.000Z',
    };
  }

  public iterateFeedItems(): Iterable<RssFeedItem> {
    return items;
  }
}

describe('RSS HTTP endpoint', () => {
  it('streams escaped RSS items in store order', async () => {
    const server = createHttpServer({
      loggerLevel: 'silent',
      publicBaseUrl: 'https://feeds.example.com',
      readiness: () => true,
      rssStore: new FakeRssStore(),
    });

    const response = await server.inject({ method: 'GET', url: `/feeds/${token}.xml` });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/rss+xml');
    expect(response.headers['cache-control']).toBe('private, no-cache');
    expect(response.headers.etag).toBeDefined();
    expect(response.headers['last-modified']).toBeDefined();
    expect(response.body).toContain('News with &lt;unsafe&gt; &amp; text');
    expect(response.body.indexOf('article-2')).toBeLessThan(response.body.indexOf('article-1'));
    expect(response.body).toContain('<atom:link');
    await server.close();
  });

  it('returns 304 when the ETag matches', async () => {
    const server = createHttpServer({
      loggerLevel: 'silent',
      publicBaseUrl: 'https://feeds.example.com',
      readiness: () => true,
      rssStore: new FakeRssStore(),
    });
    const first = await server.inject({ method: 'GET', url: `/feeds/${token}.xml` });
    const second = await server.inject({
      method: 'GET',
      url: `/feeds/${token}.xml`,
      headers: { 'if-none-match': first.headers.etag as string },
    });

    expect(second.statusCode).toBe(304);
    await server.close();
  });

  it('does not reveal whether malformed or unknown tokens differ', async () => {
    const server = createHttpServer({
      loggerLevel: 'silent',
      publicBaseUrl: 'https://feeds.example.com',
      readiness: () => false,
      rssStore: new FakeRssStore(),
    });

    const malformed = await server.inject({ method: 'GET', url: '/feeds/not-a-token.xml' });
    const unknown = await server.inject({
      method: 'GET',
      url: `/feeds/${'B'.repeat(43)}.xml`,
    });
    const readiness = await server.inject({ method: 'GET', url: '/readyz' });

    expect(malformed.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(readiness.statusCode).toBe(503);
    await server.close();
  });
});
