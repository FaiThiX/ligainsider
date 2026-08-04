import { z } from 'zod';

import type { TrackingService } from '../core/index.js';
import type { Repository, Subscription, UserFeed } from '../db/index.js';
import {
  isPlayerProfileUrl,
  type LigaInsiderClient,
  type PlayerSearchResult,
} from '../ligainsider/index.js';
import type {
  AddPlayerResult,
  DiscordFeed,
  DiscordLifecyclePort,
  DiscordOutboxItem,
  DiscordOutboxPayload,
  DiscordOutboxPort,
  DueFeedDeletion,
  EntityId,
  PlayerCandidate,
  PlayerQueryResolution,
  PlayerTrackingPort,
  RemovePlayerResult,
  RssFeedResult,
  TrackedPlayer,
} from '../discord/contracts.js';

const trackedPlayerSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  name: z.string().min(1),
  profileUrl: z.string().url(),
  clubImageUrl: z.string().url().nullable().optional(),
});

const articleSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  title: z.string().min(1),
  url: z.string().url(),
  publishedAt: z.string(),
});

const outboxPayloadSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('article'),
    article: articleSchema,
    players: z.array(trackedPlayerSchema.pick({ name: true, profileUrl: true })),
  }),
  z.object({
    kind: z.literal('bootstrap'),
    player: trackedPlayerSchema.pick({
      name: true,
      profileUrl: true,
      clubImageUrl: true,
    }),
    articles: z.array(articleSchema),
    rssUrl: z.string().url().optional(),
  }),
  z.object({
    kind: z.literal('deletion-warning'),
    deleteAfter: z.string(),
  }),
]);

interface DeletionLease {
  expectedDeleteAfter: string;
  release: () => void;
}

class UserOperationLocks {
  readonly #tails = new Map<string, Promise<void>>();

  public async acquire(key: string): Promise<() => void> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let releaseCurrent = (): void => undefined;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    this.#tails.set(key, current);

    await previous;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      releaseCurrent();
      if (this.#tails.get(key) === current) {
        this.#tails.delete(key);
      }
    };
  }

  public async runExclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire(key);
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function numericId(value: EntityId, label: string): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || String(parsed) !== String(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return parsed;
}

function operationKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

function toCandidate(player: PlayerSearchResult): PlayerCandidate {
  return {
    key: player.profileUrl,
    name: player.name,
    profileUrl: player.profileUrl,
    clubImageUrl: player.clubImageUrl,
  };
}

function toTrackedPlayer(subscription: Subscription): TrackedPlayer {
  return {
    id: subscription.player.id,
    name: subscription.player.name,
    profileUrl: subscription.player.sourceUrl,
    clubImageUrl: subscription.player.clubImageUrl,
    trackedSince: subscription.createdAt,
  };
}

export interface RepositoryDiscordPortsOptions {
  repository: Repository;
  trackingService: TrackingService;
  ligaInsiderClient: LigaInsiderClient;
  publicBaseUrl: string;
  now?: () => Date;
}

export class RepositoryDiscordPorts
  implements PlayerTrackingPort, DiscordLifecyclePort, DiscordOutboxPort
{
  readonly #locks = new UserOperationLocks();
  readonly #deletionLeases = new Map<number, DeletionLease>();
  readonly #repository: Repository;
  readonly #trackingService: TrackingService;
  readonly #ligaInsiderClient: LigaInsiderClient;
  readonly #publicBaseUrl: string;
  readonly #now: () => Date;

  public constructor(options: RepositoryDiscordPortsOptions) {
    this.#repository = options.repository;
    this.#trackingService = options.trackingService;
    this.#ligaInsiderClient = options.ligaInsiderClient;
    this.#publicBaseUrl = options.publicBaseUrl.replace(/\/+$/, '');
    this.#now = options.now ?? (() => new Date());
  }

  public async resolvePlayerQuery(query: string): Promise<PlayerQueryResolution> {
    const normalized = query.replaceAll('\u00ad', '').trim();
    if (!normalized) {
      return { kind: 'not-found' };
    }

    if (/^[a-z][a-z\d+.-]*:\/\//i.test(normalized) && !isPlayerProfileUrl(normalized)) {
      return { kind: 'not-found' };
    }

    const resolved = await this.#ligaInsiderClient.resolvePlayer(normalized);
    const players = [...new Map(resolved.map((player) => [player.profileUrl, player])).values()]
      .filter((player) => player.name.length > 0)
      .map(toCandidate);
    if (players.length === 0) {
      return { kind: 'not-found' };
    }
    if (players.length === 1) {
      return { kind: 'resolved', player: players[0] as PlayerCandidate };
    }
    return { kind: 'multiple', players };
  }

  public async addPlayer(input: {
    guildId: string;
    userId: string;
    player: PlayerCandidate;
  }): Promise<AddPlayerResult> {
    const page = await this.#ligaInsiderClient.fetchPlayerProfilePage(input.player.profileUrl);
    return this.#locks.runExclusive(operationKey(input.guildId, input.userId), async () => {
      const subscriptionsBefore = this.#trackingService.listPlayers(input.guildId, input.userId);
      const result = this.#trackingService.addPlayer({
        guildId: input.guildId,
        userId: input.userId,
        profile: page.player,
        baselineArticles: page.articles,
      });
      const tracked: TrackedPlayer = {
        id: result.player.id,
        name: result.player.name,
        profileUrl: result.player.sourceUrl,
        clubImageUrl: result.player.clubImageUrl,
      };
      const feed = this.toDiscordFeed(result.feed);
      if (!result.subscriptionAdded) {
        return { kind: 'already-tracked', player: tracked, feed };
      }
      return {
        kind: 'added',
        player: tracked,
        feed,
        firstPlayer: subscriptionsBefore.length === 0,
        reactivated: result.feedReactivated,
      };
    });
  }

  public async listPlayers(input: {
    guildId: string;
    userId: string;
  }): Promise<readonly TrackedPlayer[]> {
    return this.#trackingService.listPlayers(input.guildId, input.userId).map(toTrackedPlayer);
  }

  public async removePlayer(input: {
    guildId: string;
    userId: string;
    playerId: string;
  }): Promise<RemovePlayerResult> {
    return this.#locks.runExclusive(operationKey(input.guildId, input.userId), async () => {
      const playerId = numericId(input.playerId, 'Player ID');
      const subscription = this.#trackingService
        .listPlayers(input.guildId, input.userId)
        .find((candidate) => candidate.playerId === playerId);
      if (!subscription) {
        return { kind: 'not-found' };
      }

      const result = this.#trackingService.removePlayer(input.guildId, input.userId, playerId);
      if (!result.removed) {
        return { kind: 'not-found' };
      }
      return {
        kind: 'removed',
        player: toTrackedPlayer(subscription),
        remainingCount: result.remainingSubscriptions,
        deleteAfter: result.deleteAfter,
      };
    });
  }

  public async clearPlayers(input: {
    guildId: string;
    userId: string;
  }): Promise<{ removedCount: number; deleteAfter: string | null }> {
    return this.#locks.runExclusive(operationKey(input.guildId, input.userId), async () =>
      this.#trackingService.clearPlayers(input.guildId, input.userId),
    );
  }

  public async getRssFeed(input: {
    guildId: string;
    userId: string;
  }): Promise<RssFeedResult | null> {
    const feed = this.#repository.findFeedByUser(input.guildId, input.userId);
    return feed ? { feed: this.toDiscordFeed(feed) } : null;
  }

  public async rotateRssFeed(input: {
    guildId: string;
    userId: string;
  }): Promise<RssFeedResult | null> {
    return this.#locks.runExclusive(operationKey(input.guildId, input.userId), async () => {
      const feed = this.#trackingService.rotateRssToken(input.guildId, input.userId);
      return feed ? { feed: this.toDiscordFeed(feed) } : null;
    });
  }

  public async getFeed(feedId: EntityId): Promise<DiscordFeed | null> {
    const feed = this.#repository.findFeedById(numericId(feedId, 'Feed ID'));
    return feed ? this.toDiscordFeed(feed) : null;
  }

  public async attachChannel(input: {
    feedId: EntityId;
    channelId: string;
    previousChannelId: string | null;
  }): Promise<boolean> {
    const feedId = numericId(input.feedId, 'Feed ID');
    const feed = this.#repository.findFeedById(feedId);
    if (!feed) {
      return false;
    }
    return this.#locks.runExclusive(operationKey(feed.guildId, feed.userId), async () =>
      this.#repository.setFeedChannelIfCurrent(
        feedId,
        input.channelId,
        input.previousChannelId,
        this.#now().toISOString(),
      ),
    );
  }

  public async listFeedsForChannelReconciliation(limit: number): Promise<readonly DiscordFeed[]> {
    return this.#repository
      .listFeedsForChannelReconciliation(limit)
      .map((feed) => this.toDiscordFeed(feed));
  }

  public async markChannelMissing(input: { guildId: string; channelId: string }): Promise<void> {
    this.#repository.clearFeedChannelByGuild(
      input.guildId,
      input.channelId,
      this.#now().toISOString(),
    );
  }

  public async markMemberDeparted(input: {
    guildId: string;
    userId: string;
    leftAt: string;
  }): Promise<void> {
    await this.#locks.runExclusive(operationKey(input.guildId, input.userId), async () => {
      this.#trackingService.handleMemberLeave(input.guildId, input.userId);
    });
  }

  public async listFeedsDueForDeletion(input: {
    now: string;
    limit: number;
  }): Promise<readonly DueFeedDeletion[]> {
    return this.#repository.listFeedsDueForDeletion(input.now, input.limit).map((feed) => ({
      feed: this.toDiscordFeed(feed),
      expectedDeleteAfter: feed.deleteAfter as string,
    }));
  }

  public async beginFeedDeletion(input: {
    feedId: EntityId;
    expectedDeleteAfter: string;
  }): Promise<boolean> {
    const feedId = numericId(input.feedId, 'Feed ID');
    const initialFeed = this.#repository.findFeedById(feedId);
    if (!initialFeed) {
      return false;
    }

    const release = await this.#locks.acquire(
      operationKey(initialFeed.guildId, initialFeed.userId),
    );
    let claimed: boolean;
    try {
      claimed = this.#repository.claimFeedDeletion(
        feedId,
        input.expectedDeleteAfter,
        this.#now().toISOString(),
      );
    } catch (error) {
      release();
      throw error;
    }
    if (!claimed) {
      release();
      return false;
    }
    this.#deletionLeases.set(feedId, {
      expectedDeleteAfter: input.expectedDeleteAfter,
      release,
    });
    return true;
  }

  public async completeFeedDeletion(input: {
    feedId: EntityId;
    expectedDeleteAfter: string;
  }): Promise<void> {
    const feedId = numericId(input.feedId, 'Feed ID');
    const lease = this.#deletionLeases.get(feedId);
    if (!lease) {
      return;
    }
    if (lease.expectedDeleteAfter !== input.expectedDeleteAfter) {
      this.#repository.releaseFeedDeletion(feedId, this.#now().toISOString());
      this.#deletionLeases.delete(feedId);
      lease.release();
      throw new Error('The feed deletion deadline changed during cleanup.');
    }
    try {
      this.#repository.deleteClaimedFeed(feedId, lease.expectedDeleteAfter);
    } finally {
      this.#deletionLeases.delete(feedId);
      lease.release();
    }
  }

  public async releaseFeedDeletion(input: {
    feedId: EntityId;
    expectedDeleteAfter: string;
    error: string;
  }): Promise<void> {
    const feedId = numericId(input.feedId, 'Feed ID');
    const lease = this.#deletionLeases.get(feedId);
    try {
      this.#repository.releaseFeedDeletion(feedId, this.#now().toISOString());
    } finally {
      this.#deletionLeases.delete(feedId);
      lease?.release();
    }
  }

  public async getNextDue(now: string): Promise<DiscordOutboxItem | null> {
    for (;;) {
      const item = this.#repository.listDueOutbox<unknown>(now, 1)[0];
      if (!item) {
        return null;
      }
      const parsed = outboxPayloadSchema.safeParse(item.payload);
      if (parsed.success) {
        return {
          id: item.id,
          feedId: item.feedId,
          eventKey: item.eventKey,
          attempts: item.attempts,
          payload: parsed.data as DiscordOutboxPayload,
        };
      }
      this.#repository.markOutboxFailed({
        outboxId: item.id,
        error: 'The persisted Discord payload is invalid.',
        nextAttemptAt: now,
        now,
        dead: true,
      });
    }
  }

  public async markDelivered(input: {
    outboxId: EntityId;
    discordMessageId: string;
    deliveredAt: string;
  }): Promise<void> {
    this.#repository.markOutboxDelivered(
      numericId(input.outboxId, 'Outbox ID'),
      input.discordMessageId,
      input.deliveredAt,
    );
  }

  public async reschedule(input: {
    outboxId: EntityId;
    attempts: number;
    nextAttemptAt: string;
    error: string;
  }): Promise<void> {
    this.#repository.markOutboxFailed({
      outboxId: numericId(input.outboxId, 'Outbox ID'),
      error: input.error.slice(0, 2_000),
      nextAttemptAt: input.nextAttemptAt,
      now: this.#now().toISOString(),
    });
  }

  public async markDead(input: {
    outboxId: EntityId;
    attempts: number;
    error: string;
  }): Promise<void> {
    const now = this.#now().toISOString();
    this.#repository.markOutboxFailed({
      outboxId: numericId(input.outboxId, 'Outbox ID'),
      error: input.error.slice(0, 2_000),
      nextAttemptAt: now,
      now,
      dead: true,
    });
  }

  private toDiscordFeed(feed: UserFeed): DiscordFeed {
    return {
      id: feed.id,
      guildId: feed.guildId,
      userId: feed.userId,
      channelId: feed.channelId,
      rssUrl: `${this.#publicBaseUrl}/feeds/${feed.rssToken}.xml`,
      status: feed.status,
      deleteAfter: feed.deleteAfter,
    };
  }
}
