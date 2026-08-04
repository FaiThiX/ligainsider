export type EntityId = string | number;

export interface Clock {
  now(): Date;
}

export interface DiscordLogger {
  debug(context: Record<string, unknown>, message: string): void;
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
}

export interface PlayerCandidate {
  key: string;
  name: string;
  profileUrl: string;
  clubName?: string | null;
  clubImageUrl?: string | null;
}

export interface TrackedPlayer {
  id: EntityId;
  name: string;
  profileUrl: string;
  clubName?: string | null;
  clubImageUrl?: string | null;
  trackedSince?: string;
}

export interface ArticleSummary {
  title: string;
  url: string;
  publishedAt: string;
}

export type FeedLifecycleStatus = 'active' | 'grace';

export interface DiscordFeed {
  id: EntityId;
  guildId: string;
  userId: string;
  channelId: string | null;
  rssUrl: string;
  status: FeedLifecycleStatus;
  deleteAfter: string | null;
}

export type PlayerQueryResolution =
  | { kind: 'resolved'; player: PlayerCandidate }
  | { kind: 'multiple'; players: readonly PlayerCandidate[] }
  | { kind: 'not-found' };

export type AddPlayerResult =
  | {
      kind: 'added';
      player: TrackedPlayer;
      feed: DiscordFeed;
      firstPlayer: boolean;
      reactivated: boolean;
    }
  | {
      kind: 'already-tracked';
      player: TrackedPlayer;
      feed: DiscordFeed;
    };

export type RemovePlayerResult =
  | { kind: 'not-found' }
  | {
      kind: 'removed';
      player: TrackedPlayer;
      remainingCount: number;
      deleteAfter: string | null;
    };

export interface ClearPlayersResult {
  removedCount: number;
  deleteAfter: string | null;
}

export interface RssFeedResult {
  feed: DiscordFeed;
}

export interface PlayerTrackingPort {
  resolvePlayerQuery(query: string): Promise<PlayerQueryResolution>;
  addPlayer(input: {
    guildId: string;
    userId: string;
    player: PlayerCandidate;
  }): Promise<AddPlayerResult>;
  listPlayers(input: { guildId: string; userId: string }): Promise<readonly TrackedPlayer[]>;
  removePlayer(input: {
    guildId: string;
    userId: string;
    playerId: string;
  }): Promise<RemovePlayerResult>;
  clearPlayers(input: { guildId: string; userId: string }): Promise<ClearPlayersResult>;
  getRssFeed(input: { guildId: string; userId: string }): Promise<RssFeedResult | null>;
  rotateRssFeed(input: { guildId: string; userId: string }): Promise<RssFeedResult | null>;
}

export interface AttachChannelInput {
  feedId: EntityId;
  channelId: string;
  previousChannelId: string | null;
}

export interface DueFeedDeletion {
  feed: DiscordFeed;
  expectedDeleteAfter: string;
}

export interface DiscordLifecyclePort {
  getFeed(feedId: EntityId): Promise<DiscordFeed | null>;
  attachChannel(input: AttachChannelInput): Promise<boolean>;
  listFeedsForChannelReconciliation(limit: number): Promise<readonly DiscordFeed[]>;
  markChannelMissing(input: { guildId: string; channelId: string }): Promise<void>;
  markMemberDeparted(input: { guildId: string; userId: string; leftAt: string }): Promise<void>;
  listFeedsDueForDeletion(input: {
    now: string;
    limit: number;
  }): Promise<readonly DueFeedDeletion[]>;
  beginFeedDeletion(input: { feedId: EntityId; expectedDeleteAfter: string }): Promise<boolean>;
  completeFeedDeletion(input: { feedId: EntityId; expectedDeleteAfter: string }): Promise<void>;
  releaseFeedDeletion(input: {
    feedId: EntityId;
    expectedDeleteAfter: string;
    error: string;
  }): Promise<void>;
}

export interface ArticleOutboxPayload {
  kind: 'article';
  article: ArticleSummary;
  players: readonly Pick<TrackedPlayer, 'name' | 'profileUrl'>[];
}

export interface BootstrapOutboxPayload {
  kind: 'bootstrap';
  player: Pick<TrackedPlayer, 'name' | 'profileUrl' | 'clubImageUrl'>;
  articles: readonly ArticleSummary[];
  rssUrl?: string;
}

export interface DeletionWarningOutboxPayload {
  kind: 'deletion-warning';
  deleteAfter: string;
}

export type DiscordOutboxPayload =
  ArticleOutboxPayload | BootstrapOutboxPayload | DeletionWarningOutboxPayload;

export interface DiscordOutboxItem {
  id: EntityId;
  feedId: EntityId;
  eventKey: string;
  attempts: number;
  payload: DiscordOutboxPayload;
}

export interface DiscordOutboxPort {
  getNextDue(now: string): Promise<DiscordOutboxItem | null>;
  markDelivered(input: {
    outboxId: EntityId;
    discordMessageId: string;
    deliveredAt: string;
  }): Promise<void>;
  reschedule(input: {
    outboxId: EntityId;
    attempts: number;
    nextAttemptAt: string;
    error: string;
  }): Promise<void>;
  markDead(input: { outboxId: EntityId; attempts: number; error: string }): Promise<void>;
}

export interface DiscordAppDependencies {
  tracking: PlayerTrackingPort;
  lifecycle: DiscordLifecyclePort;
  outbox: DiscordOutboxPort;
  clock?: Clock;
  logger?: DiscordLogger;
}
