import type { Player, Repository } from '../db/index.js';
import type { LigaInsiderClient } from '../ligainsider/index.js';
import type { CoreLogger, DiscoveryResult, ScrapedPlayerNews } from './types.js';
import type { TrackingService } from './tracking-service.js';

const DEFAULT_POLL_INTERVAL_MS = 30 * 60 * 1_000;

export interface PollingServiceOptions {
  intervalMs?: number;
  maxCatchUpPages?: number;
  logger?: CoreLogger;
}

export interface PollResult extends DiscoveryResult {
  failedPlayers: number;
  skipped: boolean;
}

export class PollingService {
  private readonly intervalMs: number;
  private readonly maxCatchUpPages: number;
  private readonly logger: CoreLogger | undefined;
  private timer: NodeJS.Timeout | null = null;
  private activeRun: Promise<PollResult> | null = null;

  public constructor(
    private readonly repository: Repository,
    private readonly trackingService: TrackingService,
    private readonly client: LigaInsiderClient,
    options: PollingServiceOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxCatchUpPages = Math.max(1, Math.min(options.maxCatchUpPages ?? 10, 10));
    this.logger = options.logger;
  }

  public start(runImmediately = true): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      this.trigger();
    }, this.intervalMs);
    this.timer.unref();
    if (runImmediately) {
      this.trigger();
    }
  }

  public async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.activeRun?.catch(() => undefined);
  }

  public async runOnce(): Promise<PollResult> {
    if (this.activeRun) {
      this.logger?.warn?.({}, 'Skipped an overlapping player news poll.');
      return {
        playersProcessed: 0,
        failedPlayers: 0,
        newPlayerArticleLinks: 0,
        newFeedItems: 0,
        outboxMessages: 0,
        skipped: true,
      };
    }

    const activeRun = this.executePoll();
    this.activeRun = activeRun;
    try {
      return await activeRun;
    } finally {
      if (this.activeRun === activeRun) {
        this.activeRun = null;
      }
    }
  }

  private trigger(): void {
    void this.runOnce().catch((error: unknown) => {
      this.logger?.error?.(
        { error: error instanceof Error ? error.message : String(error) },
        'The player news polling cycle failed.',
      );
    });
  }

  private async executePoll(): Promise<PollResult> {
    const activePlayers = this.repository.listActivePlayers();
    const batches: ScrapedPlayerNews[] = [];
    let failedPlayers = 0;

    for (const player of activePlayers) {
      try {
        batches.push(await this.fetchPlayer(player));
      } catch (error) {
        failedPlayers += 1;
        this.logger?.error?.(
          {
            playerId: player.id,
            profileUrl: player.sourceUrl,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to poll a LigaInsider player profile.',
        );
      }
    }

    const result = this.trackingService.recordPollDiscoveries(batches);
    this.logger?.info?.({ ...result, failedPlayers }, 'Completed the player news poll.');
    return { ...result, failedPlayers, skipped: false };
  }

  private async fetchPlayer(player: Player): Promise<ScrapedPlayerNews> {
    const knownUrls = new Set(this.repository.listKnownArticleUrls(player.id));
    const result = await this.client.fetchNewsPages(player.sourceUrl, {
      maxPages: this.maxCatchUpPages,
      stopWhen: (articles) => articles.some((article) => knownUrls.has(article.url)),
    });
    if (result.truncated) {
      this.logger?.warn?.(
        { playerId: player.id, maxPages: this.maxCatchUpPages },
        'The player news catch-up reached its page limit.',
      );
    }
    return { profile: result.player, articles: result.articles };
  }
}
