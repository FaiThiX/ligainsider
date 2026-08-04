import { randomBytes } from 'node:crypto';

import type { SqliteDatabase } from './database.js';
import type {
  Article,
  FeedItem,
  FeedMetadata,
  FeedItemRow,
  OutboxMessage,
  Player,
  Subscription,
  UpsertArticleInput,
  UpsertPlayerInput,
  UserFeed,
} from './types.js';

type SqlRow = Record<string, unknown>;

function mapFeed(row: SqlRow): UserFeed {
  return {
    id: Number(row.id),
    guildId: String(row.guild_id),
    userId: String(row.user_id),
    channelId: row.channel_id === null ? null : String(row.channel_id),
    rssToken: String(row.rss_token),
    status: row.status as UserFeed['status'],
    deleteAfter: row.delete_after === null ? null : String(row.delete_after),
    cleanupStartedAt: row.cleanup_started_at === null ? null : String(row.cleanup_started_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapPlayer(row: SqlRow): Player {
  return {
    id: Number(row.id),
    sourceUrl: String(row.source_url),
    name: String(row.name),
    clubImageUrl: row.club_image_url === null ? null : String(row.club_image_url),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapArticle(row: SqlRow): Article {
  return {
    id: Number(row.id),
    sourceUrl: String(row.source_url),
    title: String(row.title),
    publishedAt: String(row.published_at),
    discoveredAt: String(row.discovered_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapFeedItemRow(row: SqlRow): FeedItemRow {
  return {
    itemId: Number(row.item_id),
    feedId: Number(row.feed_id),
    articleId: Number(row.article_id),
    addedAt: String(row.added_at),
    sourceUrl: String(row.source_url),
    title: String(row.title),
    publishedAt: String(row.published_at),
    discoveredAt: String(row.discovered_at),
    articleCreatedAt: String(row.article_created_at),
    articleUpdatedAt: String(row.article_updated_at),
  };
}

function parseJson<T>(value: unknown): T {
  return JSON.parse(String(value)) as T;
}

function mapOutbox<TPayload>(row: SqlRow): OutboxMessage<TPayload> {
  return {
    id: Number(row.id),
    feedId: Number(row.user_feed_id),
    eventKey: String(row.event_key),
    kind: String(row.kind),
    payload: parseJson<TPayload>(row.payload_json),
    status: row.status as OutboxMessage<TPayload>['status'],
    attempts: Number(row.attempts),
    nextAttemptAt: String(row.next_attempt_at),
    discordMessageId: row.discord_message_id === null ? null : String(row.discord_message_id),
    lastError: row.last_error === null ? null : String(row.last_error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export interface EnsureFeedResult {
  feed: UserFeed;
  created: boolean;
  reactivated: boolean;
}

export class Repository {
  public constructor(private readonly database: SqliteDatabase) {}

  public transaction<T>(operation: () => T): T {
    return this.database.transaction(operation)();
  }

  public ping(): boolean {
    return (this.database.prepare('SELECT 1 AS ok').get() as { ok: number }).ok === 1;
  }

  public close(): void {
    this.database.close();
  }

  public findFeedByUser(guildId: string, userId: string): UserFeed | null {
    const row = this.database
      .prepare('SELECT * FROM user_feeds WHERE guild_id = ? AND user_id = ?')
      .get(guildId, userId) as SqlRow | undefined;
    return row ? mapFeed(row) : null;
  }

  public findFeedById(feedId: number): UserFeed | null {
    const row = this.database.prepare('SELECT * FROM user_feeds WHERE id = ?').get(feedId) as
      SqlRow | undefined;
    return row ? mapFeed(row) : null;
  }

  public findFeedByToken(rssToken: string): UserFeed | null {
    const row = this.database
      .prepare('SELECT * FROM user_feeds WHERE rss_token = ?')
      .get(rssToken) as SqlRow | undefined;
    return row ? mapFeed(row) : null;
  }

  public ensureActiveFeed(
    guildId: string,
    userId: string,
    now: string,
    tokenFactory: () => string = () => randomBytes(32).toString('base64url'),
  ): EnsureFeedResult {
    const existing = this.findFeedByUser(guildId, userId);
    if (existing) {
      const reactivated = existing.status === 'grace';
      this.database
        .prepare(
          `UPDATE user_feeds
             SET status = 'active', delete_after = NULL,
                 cleanup_started_at = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(now, existing.id);
      return {
        feed: this.findFeedById(existing.id) as UserFeed,
        created: false,
        reactivated,
      };
    }

    const result = this.database
      .prepare(
        `INSERT INTO user_feeds (
           guild_id, user_id, channel_id, rss_token, status,
           delete_after, cleanup_started_at, created_at, updated_at
         ) VALUES (?, ?, NULL, ?, 'active', NULL, NULL, ?, ?)`,
      )
      .run(guildId, userId, tokenFactory(), now, now);

    return {
      feed: this.findFeedById(Number(result.lastInsertRowid)) as UserFeed,
      created: true,
      reactivated: false,
    };
  }

  public setFeedChannel(feedId: number, channelId: string, now: string): UserFeed {
    this.database
      .prepare('UPDATE user_feeds SET channel_id = ?, updated_at = ? WHERE id = ?')
      .run(channelId, now, feedId);
    const feed = this.findFeedById(feedId);
    if (!feed) {
      throw new Error(`Feed ${feedId} does not exist.`);
    }
    return feed;
  }

  public setFeedChannelIfCurrent(
    feedId: number,
    channelId: string,
    previousChannelId: string | null,
    now: string,
  ): boolean {
    const result =
      previousChannelId === null
        ? this.database
            .prepare(
              `UPDATE user_feeds SET channel_id = ?, updated_at = ?
              WHERE id = ? AND channel_id IS NULL`,
            )
            .run(channelId, now, feedId)
        : this.database
            .prepare(
              `UPDATE user_feeds SET channel_id = ?, updated_at = ?
              WHERE id = ? AND channel_id = ?`,
            )
            .run(channelId, now, feedId, previousChannelId);
    return result.changes > 0;
  }

  public clearFeedChannel(feedId: number, now: string): void {
    this.database
      .prepare('UPDATE user_feeds SET channel_id = NULL, updated_at = ? WHERE id = ?')
      .run(now, feedId);
  }

  public clearFeedChannelByGuild(guildId: string, channelId: string, now: string): boolean {
    return (
      this.database
        .prepare(
          `UPDATE user_feeds SET channel_id = NULL, updated_at = ?
            WHERE guild_id = ? AND channel_id = ?`,
        )
        .run(now, guildId, channelId).changes > 0
    );
  }

  public scheduleFeedDeletion(feedId: number, deleteAfter: string, now: string): void {
    this.database
      .prepare(
        `UPDATE user_feeds
            SET status = 'grace', delete_after = ?, cleanup_started_at = NULL,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(deleteAfter, now, feedId);
  }

  public rotateFeedToken(
    feedId: number,
    now: string,
    tokenFactory: () => string = () => randomBytes(32).toString('base64url'),
  ): UserFeed {
    this.database
      .prepare('UPDATE user_feeds SET rss_token = ?, updated_at = ? WHERE id = ?')
      .run(tokenFactory(), now, feedId);
    const feed = this.findFeedById(feedId);
    if (!feed) {
      throw new Error(`Feed ${feedId} does not exist.`);
    }
    return feed;
  }

  public listFeedsDueForDeletion(now: string, limit = 100): UserFeed[] {
    return this.database
      .prepare(
        `SELECT * FROM user_feeds
          WHERE status = 'grace' AND delete_after <= ?
            AND cleanup_started_at IS NULL
          ORDER BY delete_after, id
          LIMIT ?`,
      )
      .all(now, limit)
      .map((row) => mapFeed(row as SqlRow));
  }

  public listFeedsForChannelReconciliation(limit = 100): UserFeed[] {
    return this.database
      .prepare(
        `SELECT * FROM user_feeds
          WHERE status = 'active'
             OR (status = 'grace' AND channel_id IS NOT NULL)
          ORDER BY updated_at, id
          LIMIT ?`,
      )
      .all(limit)
      .map((row) => mapFeed(row as SqlRow));
  }

  public claimFeedDeletion(feedId: number, expectedDeleteAfter: string, now: string): boolean {
    return (
      this.database
        .prepare(
          `UPDATE user_feeds
              SET cleanup_started_at = ?, updated_at = ?
            WHERE id = ? AND status = 'grace' AND delete_after = ?
              AND delete_after <= ? AND cleanup_started_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM subscriptions WHERE user_feed_id = user_feeds.id
              )`,
        )
        .run(now, now, feedId, expectedDeleteAfter, now).changes > 0
    );
  }

  public releaseFeedDeletion(feedId: number, now: string): void {
    this.database
      .prepare(
        `UPDATE user_feeds
            SET cleanup_started_at = NULL, updated_at = ?
          WHERE id = ? AND status = 'grace'`,
      )
      .run(now, feedId);
  }

  public releaseAllFeedDeletionClaims(now: string): number {
    return this.database
      .prepare(
        `UPDATE user_feeds
            SET cleanup_started_at = NULL, updated_at = ?
          WHERE status = 'grace' AND cleanup_started_at IS NOT NULL`,
      )
      .run(now).changes;
  }

  public deleteClaimedFeed(feedId: number, expectedDeleteAfter: string): boolean {
    return (
      this.database
        .prepare(
          `DELETE FROM user_feeds
            WHERE id = ? AND status = 'grace' AND delete_after = ?
              AND cleanup_started_at IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM subscriptions WHERE user_feed_id = user_feeds.id
              )`,
        )
        .run(feedId, expectedDeleteAfter).changes > 0
    );
  }

  public deleteFeed(feedId: number): boolean {
    return this.database.prepare('DELETE FROM user_feeds WHERE id = ?').run(feedId).changes > 0;
  }

  public upsertPlayer(input: UpsertPlayerInput, now: string): Player {
    this.database
      .prepare(
        `INSERT INTO players (
           source_url, name, club_image_url, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(source_url) DO UPDATE SET
           name = excluded.name,
           club_image_url = COALESCE(excluded.club_image_url, players.club_image_url),
           updated_at = excluded.updated_at`,
      )
      .run(input.sourceUrl, input.name, input.clubImageUrl ?? null, now, now);
    return this.findPlayerByUrl(input.sourceUrl) as Player;
  }

  public findPlayerByUrl(sourceUrl: string): Player | null {
    const row = this.database
      .prepare('SELECT * FROM players WHERE source_url = ?')
      .get(sourceUrl) as SqlRow | undefined;
    return row ? mapPlayer(row) : null;
  }

  public findPlayerById(playerId: number): Player | null {
    const row = this.database.prepare('SELECT * FROM players WHERE id = ?').get(playerId) as
      SqlRow | undefined;
    return row ? mapPlayer(row) : null;
  }

  public listActivePlayers(): Player[] {
    return this.database
      .prepare(
        `SELECT DISTINCT p.*
           FROM players p
           JOIN subscriptions s ON s.player_id = p.id
           JOIN user_feeds f ON f.id = s.user_feed_id
          WHERE f.status = 'active'
          ORDER BY p.name COLLATE NOCASE, p.id`,
      )
      .all()
      .map((row) => mapPlayer(row as SqlRow));
  }

  public addSubscription(feedId: number, playerId: number, now: string): boolean {
    return (
      this.database
        .prepare(
          `INSERT OR IGNORE INTO subscriptions (user_feed_id, player_id, created_at)
           VALUES (?, ?, ?)`,
        )
        .run(feedId, playerId, now).changes > 0
    );
  }

  public removeSubscription(feedId: number, playerId: number): boolean {
    return (
      this.database
        .prepare('DELETE FROM subscriptions WHERE user_feed_id = ? AND player_id = ?')
        .run(feedId, playerId).changes > 0
    );
  }

  public clearSubscriptions(feedId: number): number {
    return this.database.prepare('DELETE FROM subscriptions WHERE user_feed_id = ?').run(feedId)
      .changes;
  }

  public countSubscriptions(feedId: number): number {
    return Number(
      (
        this.database
          .prepare('SELECT COUNT(*) AS count FROM subscriptions WHERE user_feed_id = ?')
          .get(feedId) as { count: number }
      ).count,
    );
  }

  public hasSubscription(feedId: number, playerId: number): boolean {
    return Boolean(
      this.database
        .prepare(
          `SELECT 1 FROM subscriptions
            WHERE user_feed_id = ? AND player_id = ?`,
        )
        .get(feedId, playerId),
    );
  }

  public listSubscriptions(feedId: number): Subscription[] {
    return this.database
      .prepare(
        `SELECT s.user_feed_id, s.created_at AS subscription_created_at, p.*
           FROM subscriptions s
           JOIN players p ON p.id = s.player_id
          WHERE s.user_feed_id = ?
          ORDER BY p.name COLLATE NOCASE, p.id`,
      )
      .all(feedId)
      .map((row) => {
        const record = row as SqlRow;
        const player = mapPlayer(record);
        return {
          feedId: Number(record.user_feed_id),
          playerId: player.id,
          createdAt: String(record.subscription_created_at),
          player,
        };
      });
  }

  public listSubscriberFeeds(playerId: number): UserFeed[] {
    return this.database
      .prepare(
        `SELECT f.*
           FROM subscriptions s
           JOIN user_feeds f ON f.id = s.user_feed_id
          WHERE s.player_id = ? AND f.status = 'active'
          ORDER BY f.id`,
      )
      .all(playerId)
      .map((row) => mapFeed(row as SqlRow));
  }

  public upsertArticle(input: UpsertArticleInput, now: string): Article {
    this.database
      .prepare(
        `INSERT INTO articles (
           source_url, title, published_at, discovered_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_url) DO UPDATE SET
           title = excluded.title,
           published_at = excluded.published_at,
           updated_at = CASE
             WHEN articles.title IS NOT excluded.title
               OR articles.published_at IS NOT excluded.published_at
             THEN excluded.updated_at
             ELSE articles.updated_at
           END`,
      )
      .run(input.sourceUrl, input.title, input.publishedAt, input.discoveredAt, now, now);
    return this.findArticleByUrl(input.sourceUrl) as Article;
  }

  public findArticleByUrl(sourceUrl: string): Article | null {
    const row = this.database
      .prepare('SELECT * FROM articles WHERE source_url = ?')
      .get(sourceUrl) as SqlRow | undefined;
    return row ? mapArticle(row) : null;
  }

  public linkArticleToPlayer(playerId: number, articleId: number, discoveredAt: string): boolean {
    return (
      this.database
        .prepare(
          `INSERT OR IGNORE INTO player_articles (
             player_id, article_id, discovered_at
           ) VALUES (?, ?, ?)`,
        )
        .run(playerId, articleId, discoveredAt).changes > 0
    );
  }

  public hasPlayerArticle(playerId: number, sourceUrl: string): boolean {
    return Boolean(
      this.database
        .prepare(
          `SELECT 1
             FROM player_articles pa
             JOIN articles a ON a.id = pa.article_id
            WHERE pa.player_id = ? AND a.source_url = ?`,
        )
        .get(playerId, sourceUrl),
    );
  }

  public listKnownArticleUrls(playerId: number): string[] {
    return this.database
      .prepare(
        `SELECT a.source_url
           FROM player_articles pa
           JOIN articles a ON a.id = pa.article_id
          WHERE pa.player_id = ?
          ORDER BY a.published_at DESC, a.id DESC`,
      )
      .all(playerId)
      .map((row) => String((row as { source_url: string }).source_url));
  }

  public listSubscribedPlayersForArticle(feedId: number, articleId: number): Player[] {
    return this.database
      .prepare(
        `SELECT p.*
           FROM player_articles pa
           JOIN players p ON p.id = pa.player_id
           JOIN subscriptions s
             ON s.player_id = p.id AND s.user_feed_id = ?
          WHERE pa.article_id = ?
          ORDER BY p.name COLLATE NOCASE, p.id`,
      )
      .all(feedId, articleId)
      .map((row) => mapPlayer(row as SqlRow));
  }

  public addFeedItem(feedId: number, articleId: number, now: string): boolean {
    return (
      this.database
        .prepare(
          `INSERT OR IGNORE INTO feed_items (user_feed_id, article_id, added_at)
           VALUES (?, ?, ?)`,
        )
        .run(feedId, articleId, now).changes > 0
    );
  }

  public linkFeedItemToPlayer(feedId: number, articleId: number, playerId: number): boolean {
    return (
      this.database
        .prepare(
          `INSERT OR IGNORE INTO feed_item_players (feed_item_id, player_id)
           SELECT fi.id, ?
             FROM feed_items fi
            WHERE fi.user_feed_id = ? AND fi.article_id = ?`,
        )
        .run(playerId, feedId, articleId).changes > 0
    );
  }

  public listFeedItems(feedId: number): FeedItem[] {
    return Array.from(this.iterateFeedItems(feedId));
  }

  public getFeedMetadata(feedId: number): FeedMetadata | null {
    const row = this.database
      .prepare(
        `SELECT f.updated_at AS feed_updated_at,
                COUNT(fi.id) AS item_count,
                MAX(a.published_at) AS latest_published_at,
                MAX(fi.added_at) AS latest_added_at,
                MAX(a.updated_at) AS latest_article_updated_at
           FROM user_feeds f
           LEFT JOIN feed_items fi ON fi.user_feed_id = f.id
           LEFT JOIN articles a ON a.id = fi.article_id
          WHERE f.id = ?
          GROUP BY f.id`,
      )
      .get(feedId) as SqlRow | undefined;
    if (!row) {
      return null;
    }
    return {
      itemCount: Number(row.item_count),
      latestPublishedAt: row.latest_published_at === null ? null : String(row.latest_published_at),
      latestAddedAt: row.latest_added_at === null ? null : String(row.latest_added_at),
      latestArticleUpdatedAt:
        row.latest_article_updated_at === null ? null : String(row.latest_article_updated_at),
      feedUpdatedAt: String(row.feed_updated_at),
    };
  }

  public *iterateFeedItems(feedId: number): IterableIterator<FeedItem> {
    const rows = this.database
      .prepare(
        `SELECT fi.id AS item_id, fi.user_feed_id AS feed_id,
                fi.article_id, fi.added_at, a.source_url, a.title,
                a.published_at, a.discovered_at,
                a.created_at AS article_created_at,
                a.updated_at AS article_updated_at,
                COALESCE((
                  SELECT json_group_array(json_object(
                    'id', p.id,
                    'name', p.name,
                    'sourceUrl', p.source_url
                  ))
                  FROM feed_item_players fip
                  JOIN players p ON p.id = fip.player_id
                  WHERE fip.feed_item_id = fi.id
                ), '[]') AS players_json
           FROM feed_items fi
           JOIN articles a ON a.id = fi.article_id
          WHERE fi.user_feed_id = ?
          ORDER BY a.published_at DESC, fi.id DESC`,
      )
      .iterate(feedId);

    for (const rawRow of rows) {
      const row = rawRow as SqlRow;
      const item = mapFeedItemRow(row);
      yield {
        id: item.itemId,
        feedId: item.feedId,
        articleId: item.articleId,
        addedAt: item.addedAt,
        article: {
          id: item.articleId,
          sourceUrl: item.sourceUrl,
          title: item.title,
          publishedAt: item.publishedAt,
          discoveredAt: item.discoveredAt,
          createdAt: item.articleCreatedAt,
          updatedAt: item.articleUpdatedAt,
        },
        players: parseJson<FeedItem['players']>(row.players_json).sort((left, right) =>
          left.name.localeCompare(right.name, 'en'),
        ),
      };
    }
  }

  public enqueueOutbox<TPayload>(input: {
    feedId: number;
    eventKey: string;
    kind: string;
    payload: TPayload;
    now: string;
  }): boolean {
    return (
      this.database
        .prepare(
          `INSERT OR IGNORE INTO discord_outbox (
             user_feed_id, event_key, kind, payload_json, status, attempts,
             next_attempt_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
        )
        .run(
          input.feedId,
          input.eventKey,
          input.kind,
          JSON.stringify(input.payload),
          input.now,
          input.now,
          input.now,
        ).changes > 0
    );
  }

  public updatePendingOutboxPayload<TPayload>(
    eventKey: string,
    payload: TPayload,
    now: string,
  ): boolean {
    return (
      this.database
        .prepare(
          `UPDATE discord_outbox
              SET payload_json = ?, updated_at = ?
            WHERE event_key = ? AND status = 'pending'`,
        )
        .run(JSON.stringify(payload), now, eventKey).changes > 0
    );
  }

  public listDueOutbox<TPayload = unknown>(
    now: string,
    limit = 25,
  ): Array<OutboxMessage<TPayload>> {
    return this.database
      .prepare(
        `SELECT * FROM discord_outbox
          WHERE status = 'pending' AND next_attempt_at <= ?
          ORDER BY next_attempt_at, id
          LIMIT ?`,
      )
      .all(now, limit)
      .map((row) => mapOutbox<TPayload>(row as SqlRow));
  }

  public findOutboxByEventKey<TPayload = unknown>(
    eventKey: string,
  ): OutboxMessage<TPayload> | null {
    const row = this.database
      .prepare('SELECT * FROM discord_outbox WHERE event_key = ?')
      .get(eventKey) as SqlRow | undefined;
    return row ? mapOutbox<TPayload>(row) : null;
  }

  public markOutboxDelivered(outboxId: number, discordMessageId: string, now: string): void {
    this.database
      .prepare(
        `UPDATE discord_outbox
            SET status = 'delivered', discord_message_id = ?,
                last_error = NULL, updated_at = ?
          WHERE id = ?`,
      )
      .run(discordMessageId, now, outboxId);
  }

  public markOutboxFailed(input: {
    outboxId: number;
    error: string;
    nextAttemptAt: string;
    now: string;
    dead?: boolean;
  }): void {
    this.database
      .prepare(
        `UPDATE discord_outbox
            SET status = ?, attempts = attempts + 1, last_error = ?,
                next_attempt_at = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        input.dead ? 'dead' : 'pending',
        input.error,
        input.nextAttemptAt,
        input.now,
        input.outboxId,
      );
  }
}
