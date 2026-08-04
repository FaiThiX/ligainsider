import type { Repository } from '../db/index.js';
import type { RssFeed, RssFeedItem, RssFeedSnapshot, RssStore } from '../http/index.js';

function latestTimestamp(values: Array<string | null | undefined>): string {
  const valid = values
    .filter((value): value is string => value !== null && value !== undefined)
    .map((value) => new Date(value))
    .filter((value) => !Number.isNaN(value.valueOf()))
    .sort((left, right) => right.valueOf() - left.valueOf());
  return (valid[0] ?? new Date(0)).toISOString();
}

export class RepositoryRssStore implements RssStore {
  public constructor(private readonly repository: Repository) {}

  public findFeedByToken(token: string): RssFeed | null {
    const feed = this.repository.findFeedByToken(token);
    if (!feed) {
      return null;
    }
    return {
      id: feed.id,
      token: feed.rssToken,
      updatedAt: feed.updatedAt,
    };
  }

  public getFeedSnapshot(feedId: number): RssFeedSnapshot {
    const metadata = this.repository.getFeedMetadata(feedId);
    if (!metadata) {
      return { itemCount: 0, lastChangedAt: new Date(0).toISOString(), revision: 'missing' };
    }

    const lastChangedAt = latestTimestamp([
      metadata.feedUpdatedAt,
      metadata.latestAddedAt,
      metadata.latestArticleUpdatedAt,
    ]);
    return {
      itemCount: metadata.itemCount,
      lastChangedAt,
      revision: `${metadata.itemCount}:${lastChangedAt}`,
    };
  }

  public *iterateFeedItems(feedId: number): IterableIterator<RssFeedItem> {
    for (const item of this.repository.iterateFeedItems(feedId)) {
      yield {
        id: item.id,
        title: item.article.title,
        sourceUrl: item.article.sourceUrl,
        publishedAt: item.article.publishedAt,
        addedAt: item.addedAt,
        playerNames: item.players.map((player) => player.name),
      };
    }
  }
}
