export interface PlayerSearchResult {
  name: string;
  profileUrl: string;
  clubImageUrl: string | null;
}

export interface LigaInsiderArticle {
  title: string;
  url: string;
  publishedAt: string;
  discoveredAt: string;
  usedFallbackDate: boolean;
}

export interface PlayerProfilePage {
  player: PlayerSearchResult;
  articles: LigaInsiderArticle[];
  nextPageUrl: string | null;
}

export interface PlayerNewsResult {
  player: PlayerSearchResult;
  articles: LigaInsiderArticle[];
  pagesFetched: number;
  truncated: boolean;
}

export interface FetchNewsPagesOptions {
  maxPages?: number;
  stopWhen?: (
    articles: readonly LigaInsiderArticle[],
    pageNumber: number,
  ) => boolean | Promise<boolean>;
}

export interface LigaInsiderLogger {
  debug?(details: Record<string, unknown>, message: string): void;
  warn?(details: Record<string, unknown>, message: string): void;
}
