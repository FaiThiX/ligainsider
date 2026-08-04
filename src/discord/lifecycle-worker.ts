import type { Clock, DiscordFeed, DiscordLifecyclePort, DiscordLogger } from './contracts.js';
import type { PrivateChannelManager } from './channel-manager.js';
import { errorMessage } from './runtime.js';

export interface DiscordLifecycleWorkerOptions {
  lifecycle: DiscordLifecyclePort;
  channelManager: PrivateChannelManager;
  clock: Clock;
  logger: DiscordLogger;
  intervalMs?: number;
  batchSize?: number;
}

export class DiscordLifecycleWorker {
  readonly #intervalMs: number;
  readonly #batchSize: number;
  #timer: NodeJS.Timeout | null = null;
  #running: Promise<void> | null = null;

  constructor(private readonly options: DiscordLifecycleWorkerOptions) {
    this.#intervalMs = options.intervalMs ?? 60_000;
    this.#batchSize = options.batchSize ?? 1_000;
  }

  start(): void {
    if (this.#timer) {
      return;
    }
    this.trigger();
    this.#timer = setInterval(() => this.trigger(), this.#intervalMs);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    await this.#running;
  }

  async runOnce(): Promise<void> {
    if (this.#running) {
      return this.#running;
    }
    this.#running = this.reconcile().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  private trigger(): void {
    void this.runOnce().catch((error: unknown) =>
      this.options.logger.error(
        { error: errorMessage(error) },
        'The Discord lifecycle worker cycle failed',
      ),
    );
  }

  private async reconcile(): Promise<void> {
    const feeds = await this.options.lifecycle.listFeedsForChannelReconciliation(this.#batchSize);
    for (const feed of feeds) {
      await this.reconcileChannel(feed);
    }

    const due = await this.options.lifecycle.listFeedsDueForDeletion({
      now: this.options.clock.now().toISOString(),
      limit: this.#batchSize,
    });
    for (const deletion of due) {
      const claimed = await this.options.lifecycle.beginFeedDeletion({
        feedId: deletion.feed.id,
        expectedDeleteAfter: deletion.expectedDeleteAfter,
      });
      if (!claimed) {
        continue;
      }

      try {
        await this.options.channelManager.deletePrivateChannel(deletion.feed);
        await this.options.lifecycle.completeFeedDeletion({
          feedId: deletion.feed.id,
          expectedDeleteAfter: deletion.expectedDeleteAfter,
        });
      } catch (error) {
        const message = errorMessage(error);
        this.options.logger.error(
          { feedId: deletion.feed.id, channelId: deletion.feed.channelId, error: message },
          'Could not delete an expired Discord feed channel',
        );
        await this.options.lifecycle.releaseFeedDeletion({
          feedId: deletion.feed.id,
          expectedDeleteAfter: deletion.expectedDeleteAfter,
          error: message,
        });
      }
    }
  }

  private async reconcileChannel(feed: DiscordFeed): Promise<void> {
    try {
      const channel = await this.options.channelManager.ensurePrivateChannel(feed);
      if (channel.id === feed.channelId) {
        return;
      }
      const attached = await this.options.lifecycle.attachChannel({
        feedId: feed.id,
        channelId: channel.id,
        previousChannelId: feed.channelId,
      });
      if (!attached) {
        await channel.delete('Discard a channel created for a feed that changed concurrently');
      }
    } catch (error) {
      this.options.logger.error(
        { feedId: feed.id, channelId: feed.channelId, error: errorMessage(error) },
        'Could not reconcile a private Discord feed channel',
      );
    }
  }
}
