import { DateTime } from 'luxon';

import type { Article, Player, Repository, Subscription, UserFeed } from '../db/index.js';
import type { LigaInsiderArticle } from '../ligainsider/index.js';
import type {
  AddPlayerInput,
  AddPlayerResult,
  ArticleOutboxPayload,
  ArticleSummary,
  BootstrapOutboxPayload,
  ClearPlayersResult,
  DeletionWarningOutboxPayload,
  DiscoveryResult,
  PlayerSummary,
  RemovePlayerResult,
  ScrapedPlayerNews,
} from './types.js';

const BOOTSTRAP_ARTICLE_LIMIT = 5;

function toPlayerSummary(player: Player): PlayerSummary {
  return {
    id: player.id,
    name: player.name,
    profileUrl: player.sourceUrl,
    clubImageUrl: player.clubImageUrl,
  };
}

function toArticleSummary(article: Article): ArticleSummary {
  return {
    id: article.id,
    title: article.title,
    url: article.sourceUrl,
    publishedAt: article.publishedAt,
  };
}

function compareArticlesNewestFirst(left: LigaInsiderArticle, right: LigaInsiderArticle): number {
  return right.publishedAt.localeCompare(left.publishedAt);
}

export interface TrackingServiceOptions {
  now?: () => Date;
  tokenFactory?: () => string;
  publicBaseUrl?: string;
  graceHours?: number;
}

export class TrackingService {
  private readonly now: () => Date;
  private readonly tokenFactory: (() => string) | undefined;
  private readonly publicBaseUrl: string | undefined;
  private readonly graceHours: number;

  public constructor(
    private readonly repository: Repository,
    options: TrackingServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.tokenFactory = options.tokenFactory;
    this.publicBaseUrl = options.publicBaseUrl?.replace(/\/$/, '');
    this.graceHours = options.graceHours ?? 72;
  }

  public addPlayer(input: AddPlayerInput): AddPlayerResult {
    return this.repository.transaction(() => {
      const now = this.now().toISOString();
      const ensured = this.repository.ensureActiveFeed(
        input.guildId,
        input.userId,
        now,
        this.tokenFactory,
      );
      const player = this.repository.upsertPlayer(
        {
          sourceUrl: input.profile.profileUrl,
          name: input.profile.name,
          clubImageUrl: input.profile.clubImageUrl,
        },
        now,
      );
      const subscriptionAdded = this.repository.addSubscription(ensured.feed.id, player.id, now);

      const baseline = [...input.baselineArticles]
        .sort(compareArticlesNewestFirst)
        .filter(
          (article, index, articles) =>
            articles.findIndex((candidate) => candidate.url === article.url) === index,
        );
      let bootstrapArticleCount = 0;
      if (subscriptionAdded) {
        const storedArticles = new Map<string, Article>();
        for (const sourceArticle of baseline) {
          const article = this.storeArticle(sourceArticle, now);
          storedArticles.set(article.sourceUrl, article);
          this.repository.linkArticleToPlayer(player.id, article.id, sourceArticle.discoveredAt);
        }
        const bootstrapArticles = baseline.slice(0, BOOTSTRAP_ARTICLE_LIMIT);
        for (const sourceArticle of bootstrapArticles) {
          const article = storedArticles.get(sourceArticle.url) as Article;
          this.repository.addFeedItem(ensured.feed.id, article.id, now);
          this.repository.linkFeedItemToPlayer(ensured.feed.id, article.id, player.id);
        }
        bootstrapArticleCount = bootstrapArticles.length;

        const payload: BootstrapOutboxPayload = {
          kind: 'bootstrap',
          player: toPlayerSummary(player),
          articles: bootstrapArticles.map((sourceArticle) =>
            toArticleSummary(storedArticles.get(sourceArticle.url) as Article),
          ),
          ...(ensured.created && this.publicBaseUrl
            ? {
                rssUrl: `${this.publicBaseUrl}/feeds/${ensured.feed.rssToken}.xml`,
              }
            : {}),
        };
        this.repository.enqueueOutbox({
          feedId: ensured.feed.id,
          eventKey: `bootstrap:${ensured.feed.id}:${player.id}:${now}`,
          kind: 'bootstrap',
          payload,
          now,
        });
      }

      return {
        feed: this.repository.findFeedById(ensured.feed.id) as UserFeed,
        player,
        feedCreated: ensured.created,
        feedReactivated: ensured.reactivated,
        subscriptionAdded,
        bootstrapArticleCount,
      };
    });
  }

  public removePlayer(guildId: string, userId: string, playerId: number): RemovePlayerResult {
    return this.repository.transaction(() => {
      const feed = this.repository.findFeedByUser(guildId, userId);
      if (!feed || !this.repository.removeSubscription(feed.id, playerId)) {
        return {
          removed: false,
          deleteAfter: null,
          remainingSubscriptions: feed ? this.repository.countSubscriptions(feed.id) : 0,
        };
      }

      const remainingSubscriptions = this.repository.countSubscriptions(feed.id);
      const deleteAfter = remainingSubscriptions === 0 ? this.beginGracePeriod(feed) : null;
      return { removed: true, deleteAfter, remainingSubscriptions };
    });
  }

  public clearPlayers(guildId: string, userId: string): ClearPlayersResult {
    return this.repository.transaction(() => {
      const feed = this.repository.findFeedByUser(guildId, userId);
      if (!feed) {
        return { removedCount: 0, deleteAfter: null };
      }
      const removedCount = this.repository.clearSubscriptions(feed.id);
      return {
        removedCount,
        deleteAfter: removedCount > 0 ? this.beginGracePeriod(feed) : feed.deleteAfter,
      };
    });
  }

  public handleMemberLeave(guildId: string, userId: string): ClearPlayersResult {
    return this.clearPlayers(guildId, userId);
  }

  public listPlayers(guildId: string, userId: string): Subscription[] {
    const feed = this.repository.findFeedByUser(guildId, userId);
    return feed ? this.repository.listSubscriptions(feed.id) : [];
  }

  public rotateRssToken(guildId: string, userId: string): UserFeed | null {
    return this.repository.transaction(() => {
      const feed = this.repository.findFeedByUser(guildId, userId);
      if (!feed) {
        return null;
      }
      return this.repository.rotateFeedToken(feed.id, this.now().toISOString(), this.tokenFactory);
    });
  }

  public setChannel(feedId: number, channelId: string): UserFeed {
    return this.repository.setFeedChannel(feedId, channelId, this.now().toISOString());
  }

  public recordPollDiscoveries(batches: readonly ScrapedPlayerNews[]): DiscoveryResult {
    return this.repository.transaction(() => {
      const now = this.now().toISOString();
      const notifications = new Map<
        string,
        {
          feed: UserFeed;
          article: Article;
        }
      >();
      let newPlayerArticleLinks = 0;

      for (const batch of batches) {
        const player = this.repository.upsertPlayer(
          {
            sourceUrl: batch.profile.profileUrl,
            name: batch.profile.name,
            clubImageUrl: batch.profile.clubImageUrl,
          },
          now,
        );
        const subscriberFeeds = this.repository.listSubscriberFeeds(player.id);

        for (const sourceArticle of batch.articles) {
          const article = this.storeArticle(sourceArticle, now);
          const isNewLink = this.repository.linkArticleToPlayer(
            player.id,
            article.id,
            sourceArticle.discoveredAt,
          );
          if (!isNewLink) {
            continue;
          }
          newPlayerArticleLinks += 1;

          for (const feed of subscriberFeeds) {
            const key = `${feed.id}:${article.id}`;
            const notification = notifications.get(key) ?? {
              feed,
              article,
            };
            notifications.set(key, notification);
          }
        }
      }

      let newFeedItems = 0;
      let outboxMessages = 0;
      for (const notification of notifications.values()) {
        const players = this.repository.listSubscribedPlayersForArticle(
          notification.feed.id,
          notification.article.id,
        );
        const added = this.repository.addFeedItem(
          notification.feed.id,
          notification.article.id,
          now,
        );
        for (const player of players) {
          this.repository.linkFeedItemToPlayer(
            notification.feed.id,
            notification.article.id,
            player.id,
          );
        }

        const eventKey = `article:${notification.feed.id}:${notification.article.id}`;
        const payload: ArticleOutboxPayload = {
          kind: 'article',
          article: toArticleSummary(notification.article),
          players: players.map(toPlayerSummary),
        };
        if (added) {
          newFeedItems += 1;
          if (
            this.repository.enqueueOutbox({
              feedId: notification.feed.id,
              eventKey,
              kind: 'article',
              payload,
              now,
            })
          ) {
            outboxMessages += 1;
          }
          continue;
        }

        const existing = this.repository.findOutboxByEventKey<ArticleOutboxPayload>(eventKey);
        if (existing?.status === 'pending' && existing.payload.kind === 'article') {
          const merged = new Map<number, PlayerSummary>();
          for (const item of [...existing.payload.players, ...payload.players]) {
            merged.set(item.id, item);
          }
          this.repository.updatePendingOutboxPayload<ArticleOutboxPayload>(
            eventKey,
            {
              ...payload,
              players: [...merged.values()].sort((left, right) =>
                left.name.localeCompare(right.name, 'en'),
              ),
            },
            now,
          );
        }
      }

      return {
        playersProcessed: batches.length,
        newPlayerArticleLinks,
        newFeedItems,
        outboxMessages,
      };
    });
  }

  private storeArticle(sourceArticle: LigaInsiderArticle, now: string): Article {
    return this.repository.upsertArticle(
      {
        sourceUrl: sourceArticle.url,
        title: sourceArticle.title,
        publishedAt: sourceArticle.publishedAt,
        discoveredAt: sourceArticle.discoveredAt,
      },
      now,
    );
  }

  private beginGracePeriod(feed: UserFeed): string {
    const nowDate = this.now();
    const now = nowDate.toISOString();
    const deleteAfter = DateTime.fromJSDate(nowDate, { zone: 'utc' })
      .plus({ hours: this.graceHours })
      .toISO() as string;
    this.repository.scheduleFeedDeletion(feed.id, deleteAfter, now);
    const payload: DeletionWarningOutboxPayload = {
      kind: 'deletion-warning',
      deleteAfter,
    };
    this.repository.enqueueOutbox({
      feedId: feed.id,
      eventKey: `deletion-warning:${feed.id}:${deleteAfter}`,
      kind: 'deletion-warning',
      payload,
      now,
    });
    return deleteAfter;
  }
}
