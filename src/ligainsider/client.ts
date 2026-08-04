import type {
  FetchNewsPagesOptions,
  LigaInsiderLogger,
  PlayerNewsResult,
  PlayerProfilePage,
  PlayerSearchResult,
} from './types.js';
import { parsePlayerProfilePage, parsePlayerSearchResults } from './parser.js';
import {
  LIGAINSIDER_ORIGIN,
  normalizePaginationUrl,
  normalizePlayerProfileUrl,
  UnsafeLigaInsiderUrlError,
} from './url.js';

type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface LigaInsiderClientOptions {
  fetch?: FetchImplementation;
  logger?: LigaInsiderLogger;
  minRequestIntervalMs?: number;
  timeoutMs?: number;
  retries?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

export class LigaInsiderHttpError extends Error {
  public constructor(
    public readonly status: number,
    public readonly url: string,
  ) {
    super(`LigaInsider returned HTTP ${status} for ${url}.`);
    this.name = 'LigaInsiderHttpError';
  }
}

class RequestQueue {
  private tail: Promise<void> = Promise.resolve();
  private nextStart = 0;

  public constructor(
    private readonly intervalMs: number,
    private readonly sleep: (milliseconds: number) => Promise<void>,
    private readonly now: () => number,
  ) {}

  public async schedule<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release = (): void => undefined;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    const delay = Math.max(0, this.nextStart - this.now());
    if (delay > 0) {
      await this.sleep(delay);
    }
    this.nextStart = this.now() + this.intervalMs;

    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export class LigaInsiderClient {
  private readonly fetchImplementation: FetchImplementation;
  private readonly logger: LigaInsiderLogger | undefined;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly queue: RequestQueue;

  public constructor(options: LigaInsiderClientOptions = {}) {
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    this.logger = options.logger;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.retries = options.retries ?? 2;
    this.sleep = options.sleep ?? defaultSleep;
    this.queue = new RequestQueue(
      options.minRequestIntervalMs ?? 1_000,
      this.sleep,
      options.now ?? Date.now,
    );
  }

  public async searchPlayers(query: string): Promise<PlayerSearchResult[]> {
    const normalizedQuery = query.replaceAll('\u00ad', '').trim();
    if (!normalizedQuery) {
      return [];
    }

    const url = new URL('/search/', LIGAINSIDER_ORIGIN);
    url.searchParams.set('searchstring', normalizedQuery);
    url.searchParams.set('mode', 'pageview');
    url.searchParams.set('searchtype', 'player-verein-user');
    const html = await this.requestText(url.toString(), { method: 'POST' });
    return parsePlayerSearchResults(html);
  }

  public async resolvePlayer(queryOrUrl: string): Promise<PlayerSearchResult[]> {
    try {
      const profileUrl = normalizePlayerProfileUrl(queryOrUrl);
      const page = await this.fetchPlayerProfilePage(profileUrl);
      return [page.player];
    } catch (error) {
      if (!(error instanceof UnsafeLigaInsiderUrlError)) {
        throw error;
      }
      return this.searchPlayers(queryOrUrl);
    }
  }

  public async fetchPlayerProfilePage(profileUrlInput: string): Promise<PlayerProfilePage> {
    const profileUrl = normalizePlayerProfileUrl(profileUrlInput);
    const discoveredAt = new Date().toISOString();
    const html = await this.requestText(profileUrl, { method: 'GET' });
    return parsePlayerProfilePage(html, profileUrl, {
      discoveredAt,
      logger: this.logger,
    });
  }

  public async fetchNewsPages(
    profileUrlInput: string,
    options: FetchNewsPagesOptions = {},
  ): Promise<PlayerNewsResult> {
    const profileUrl = normalizePlayerProfileUrl(profileUrlInput);
    const maxPages = Math.max(1, Math.min(options.maxPages ?? 10, 10));
    const allArticles = new Map<string, PlayerProfilePage['articles'][number]>();
    let nextUrl: string | null = profileUrl;
    let player: PlayerSearchResult | null = null;
    let pagesFetched = 0;

    while (nextUrl && pagesFetched < maxPages) {
      const discoveredAt = new Date().toISOString();
      const html = await this.requestText(nextUrl, { method: 'GET' });
      const page = parsePlayerProfilePage(html, profileUrl, {
        discoveredAt,
        logger: this.logger,
      });
      player ??= page.player;
      pagesFetched += 1;
      for (const article of page.articles) {
        allArticles.set(article.url, article);
      }

      if (await options.stopWhen?.(page.articles, pagesFetched)) {
        nextUrl = null;
        break;
      }

      nextUrl = page.nextPageUrl ? normalizePaginationUrl(page.nextPageUrl, profileUrl) : null;
    }

    if (!player) {
      throw new Error(`No LigaInsider page was fetched for ${profileUrl}.`);
    }

    return {
      player,
      articles: [...allArticles.values()],
      pagesFetched,
      truncated: nextUrl !== null,
    };
  }

  private async requestText(url: string, init: RequestInit): Promise<string> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      try {
        return await this.queue.schedule(async () => {
          return this.fetchTextFollowingSafeRedirects(url, init);
        });
      } catch (error) {
        lastError = error;
        const retryable =
          !(error instanceof UnsafeLigaInsiderUrlError) &&
          (!(error instanceof LigaInsiderHttpError) || isRetryableStatus(error.status));
        if (!retryable || attempt >= this.retries) {
          throw error;
        }

        const backoffMs = 1_000 * 2 ** attempt;
        this.logger?.warn?.(
          { url, attempt: attempt + 1, backoffMs },
          'The LigaInsider request failed and will be retried.',
        );
        await this.sleep(backoffMs);
      }
    }

    throw lastError;
  }

  private async fetchTextFollowingSafeRedirects(
    initialUrl: string,
    init: RequestInit,
  ): Promise<string> {
    let url = new URL(initialUrl);
    if (url.origin !== LIGAINSIDER_ORIGIN) {
      throw new UnsafeLigaInsiderUrlError(initialUrl);
    }

    for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImplementation(url, {
          ...init,
          redirect: 'manual',
          headers: {
            'user-agent': 'player-news-bot/1.0 (+self-hosted RSS reader)',
            accept: 'text/html,application/xhtml+xml',
            ...init.headers,
          },
          signal: controller.signal,
        });
        if (![301, 302, 303, 307, 308].includes(response.status)) {
          if (!response.ok) {
            throw new LigaInsiderHttpError(response.status, response.url || url.toString());
          }
          return await response.text();
        }

        const location = response.headers.get('location');
        if (!location) {
          throw new LigaInsiderHttpError(response.status, response.url || url.toString());
        }
        const redirected = new URL(location, url);
        if (redirected.origin !== LIGAINSIDER_ORIGIN) {
          throw new UnsafeLigaInsiderUrlError(redirected.toString());
        }
        url = redirected;
        if (response.status === 303) {
          init = { ...init, method: 'GET', body: undefined };
        }
      } finally {
        clearTimeout(timeout);
      }
    }

    throw new Error(`LigaInsider redirected too many times: ${initialUrl}`);
  }
}
