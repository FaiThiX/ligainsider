import type { Player, UserFeed } from '../db/index.js';
import type { LigaInsiderArticle, PlayerSearchResult } from '../ligainsider/index.js';

export interface ArticleSummary {
  id: number;
  title: string;
  url: string;
  publishedAt: string;
}

export interface PlayerSummary {
  id: number;
  name: string;
  profileUrl: string;
  clubImageUrl: string | null;
}

export interface BootstrapOutboxPayload {
  kind: 'bootstrap';
  player: PlayerSummary;
  articles: ArticleSummary[];
  rssUrl?: string;
}

export interface ArticleOutboxPayload {
  kind: 'article';
  article: ArticleSummary;
  players: PlayerSummary[];
}

export interface DeletionWarningOutboxPayload {
  kind: 'deletion-warning';
  deleteAfter: string;
}

export type DiscordOutboxPayload =
  BootstrapOutboxPayload | ArticleOutboxPayload | DeletionWarningOutboxPayload;

export interface AddPlayerInput {
  guildId: string;
  userId: string;
  profile: PlayerSearchResult;
  baselineArticles: readonly LigaInsiderArticle[];
}

export interface AddPlayerResult {
  feed: UserFeed;
  player: Player;
  feedCreated: boolean;
  feedReactivated: boolean;
  subscriptionAdded: boolean;
  bootstrapArticleCount: number;
}

export interface RemovePlayerResult {
  removed: boolean;
  deleteAfter: string | null;
  remainingSubscriptions: number;
}

export interface ClearPlayersResult {
  removedCount: number;
  deleteAfter: string | null;
}

export interface ScrapedPlayerNews {
  profile: PlayerSearchResult;
  articles: readonly LigaInsiderArticle[];
}

export interface DiscoveryResult {
  playersProcessed: number;
  newPlayerArticleLinks: number;
  newFeedItems: number;
  outboxMessages: number;
}

export interface CoreLogger {
  debug?(details: Record<string, unknown>, message: string): void;
  info?(details: Record<string, unknown>, message: string): void;
  warn?(details: Record<string, unknown>, message: string): void;
  error?(details: Record<string, unknown>, message: string): void;
}
