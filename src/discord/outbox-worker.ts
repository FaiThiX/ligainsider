import { createHash } from 'node:crypto';

import { DiscordAPIError, HTTPError, RESTJSONErrorCodes, RateLimitError } from 'discord.js';

import type {
  Clock,
  DiscordFeed,
  DiscordLifecyclePort,
  DiscordLogger,
  DiscordOutboxItem,
  DiscordOutboxPort,
} from './contracts.js';
import type { PrivateChannelManager } from './channel-manager.js';
import { renderOutboxPayload } from './embeds.js';
import { errorMessage } from './runtime.js';

export interface DiscordOutboxWorkerOptions {
  outbox: DiscordOutboxPort;
  lifecycle: DiscordLifecyclePort;
  channelManager: PrivateChannelManager;
  clock: Clock;
  logger: DiscordLogger;
  pollIntervalMs?: number;
  maxAttempts?: number;
  batchSize?: number;
}

export type DiscordDeliveryErrorDisposition = 'retry' | 'dead';

export function classifyDiscordDeliveryError(error: unknown): DiscordDeliveryErrorDisposition {
  if (error instanceof RateLimitError) {
    return 'retry';
  }
  if (error instanceof DiscordAPIError) {
    if (error.code === RESTJSONErrorCodes.UnknownChannel || error.status >= 500) {
      return 'retry';
    }
    if (
      error.code === RESTJSONErrorCodes.MissingAccess ||
      error.code === RESTJSONErrorCodes.MissingPermissions
    ) {
      return 'dead';
    }
    return error.status === 429 ? 'retry' : 'dead';
  }
  if (error instanceof HTTPError) {
    return error.status === 429 || error.status >= 500 ? 'retry' : 'dead';
  }
  return 'retry';
}

export function deterministicDiscordNonce(eventKey: string): string {
  return createHash('sha256').update(eventKey).digest('base64url').slice(0, 25);
}

export function nextOutboxAttemptAt(now: Date, attempts: number): string {
  const delayMs = Math.min(15 * 60_000, 2_000 * 2 ** Math.min(Math.max(attempts - 1, 0), 16));
  return new Date(now.getTime() + delayMs).toISOString();
}

export class DiscordOutboxWorker {
  readonly #pollIntervalMs: number;
  readonly #maxAttempts: number;
  readonly #batchSize: number;
  #timer: NodeJS.Timeout | null = null;
  #running: Promise<void> | null = null;

  constructor(private readonly options: DiscordOutboxWorkerOptions) {
    this.#pollIntervalMs = options.pollIntervalMs ?? 2_000;
    this.#maxAttempts = options.maxAttempts ?? 8;
    this.#batchSize = options.batchSize ?? 25;
  }

  start(): void {
    if (this.#timer) {
      return;
    }
    this.trigger();
    this.#timer = setInterval(() => this.trigger(), this.#pollIntervalMs);
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

    this.#running = this.drain().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  private trigger(): void {
    void this.runOnce().catch((error: unknown) =>
      this.options.logger.error(
        { error: errorMessage(error) },
        'The Discord outbox worker cycle failed',
      ),
    );
  }

  private async drain(): Promise<void> {
    for (let processed = 0; processed < this.#batchSize; processed += 1) {
      const item = await this.options.outbox.getNextDue(this.options.clock.now().toISOString());
      if (!item) {
        return;
      }
      const shouldContinue = await this.deliver(item);
      if (!shouldContinue) {
        return;
      }
    }
  }

  private async deliver(item: DiscordOutboxItem): Promise<boolean> {
    const feed = await this.options.lifecycle.getFeed(item.feedId);
    if (!feed) {
      await this.options.outbox.markDead({
        outboxId: item.id,
        attempts: item.attempts + 1,
        error: 'The target feed no longer exists',
      });
      return true;
    }

    try {
      const channel = await this.ensureAttachedChannel(feed);
      const message = await channel.send({
        ...renderOutboxPayload(item.payload),
        nonce: deterministicDiscordNonce(item.eventKey),
        enforceNonce: true,
      });

      try {
        await this.options.outbox.markDelivered({
          outboxId: item.id,
          discordMessageId: message.id,
          deliveredAt: this.options.clock.now().toISOString(),
        });
      } catch (error) {
        this.options.logger.error(
          { outboxId: item.id, discordMessageId: message.id, error: errorMessage(error) },
          'Discord accepted a message but its outbox row could not be marked delivered',
        );
        return false;
      }

      return true;
    } catch (error) {
      await this.handleDeliveryError(item, error);
      return true;
    }
  }

  private async ensureAttachedChannel(feed: DiscordFeed) {
    const channel = await this.options.channelManager.ensurePrivateChannel(feed);
    if (channel.id === feed.channelId) {
      return channel;
    }

    const attached = await this.options.lifecycle.attachChannel({
      feedId: feed.id,
      channelId: channel.id,
      previousChannelId: feed.channelId,
    });
    if (!attached) {
      await channel.delete('Discard a channel created for an unavailable feed');
      throw new Error('The target feed changed while preparing Discord delivery');
    }
    return channel;
  }

  private async handleDeliveryError(item: DiscordOutboxItem, error: unknown): Promise<void> {
    const attempts = item.attempts + 1;
    const message = errorMessage(error).slice(0, 2_000);
    const disposition = classifyDiscordDeliveryError(error);
    if (disposition === 'dead' || attempts >= this.#maxAttempts) {
      await this.options.outbox.markDead({ outboxId: item.id, attempts, error: message });
      this.options.logger.error(
        { outboxId: item.id, feedId: item.feedId, attempts, error: message },
        'A Discord outbox message was moved to the dead-letter state',
      );
      return;
    }

    const nextAttemptAt = nextOutboxAttemptAt(this.options.clock.now(), attempts);
    await this.options.outbox.reschedule({
      outboxId: item.id,
      attempts,
      nextAttemptAt,
      error: message,
    });
    this.options.logger.warn(
      { outboxId: item.id, feedId: item.feedId, attempts, nextAttemptAt, error: message },
      'A Discord outbox delivery will be retried',
    );
  }
}
