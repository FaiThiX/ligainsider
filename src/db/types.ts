export const FEED_STATUSES = ['active', 'grace'] as const;
export type FeedStatus = (typeof FEED_STATUSES)[number];

export interface UserFeed {
  id: number;
  guildId: string;
  userId: string;
  channelId: string | null;
  rssToken: string;
  status: FeedStatus;
  deleteAfter: string | null;
  cleanupStartedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Player {
  id: number;
  sourceUrl: string;
  name: string;
  clubImageUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Subscription {
  feedId: number;
  playerId: number;
  createdAt: string;
  player: Player;
}

export interface Article {
  id: number;
  sourceUrl: string;
  title: string;
  publishedAt: string;
  discoveredAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface FeedItem {
  id: number;
  feedId: number;
  articleId: number;
  addedAt: string;
  article: Article;
  players: Array<Pick<Player, 'id' | 'name' | 'sourceUrl'>>;
}

export interface FeedMetadata {
  itemCount: number;
  latestPublishedAt: string | null;
  latestAddedAt: string | null;
  latestArticleUpdatedAt: string | null;
  feedUpdatedAt: string;
}

export const OUTBOX_STATUSES = ['pending', 'delivered', 'dead'] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

export interface OutboxMessage<TPayload = unknown> {
  id: number;
  feedId: number;
  eventKey: string;
  kind: string;
  payload: TPayload;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: string;
  discordMessageId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertPlayerInput {
  sourceUrl: string;
  name: string;
  clubImageUrl?: string | null;
}

export interface UpsertArticleInput {
  sourceUrl: string;
  title: string;
  publishedAt: string;
  discoveredAt: string;
}

export interface FeedItemRow {
  itemId: number;
  feedId: number;
  articleId: number;
  addedAt: string;
  sourceUrl: string;
  title: string;
  publishedAt: string;
  discoveredAt: string;
  articleCreatedAt: string;
  articleUpdatedAt: string;
}
