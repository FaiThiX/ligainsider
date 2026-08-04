import { DiscordAPIError, HTTPError, RESTJSONErrorCodes, type TextChannel } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import type { PrivateChannelManager } from '../../src/discord/channel-manager.js';
import type {
  DiscordFeed,
  DiscordLifecyclePort,
  DiscordLogger,
  DiscordOutboxItem,
  DiscordOutboxPort,
} from '../../src/discord/contracts.js';
import {
  classifyDiscordDeliveryError,
  deterministicDiscordNonce,
  DiscordOutboxWorker,
  nextOutboxAttemptAt,
} from '../../src/discord/outbox-worker.js';

const feed: DiscordFeed = {
  id: 1,
  guildId: 'guild',
  userId: 'user',
  channelId: 'channel',
  rssUrl: 'https://bot.example/feeds/token.xml',
  status: 'active',
  deleteAfter: null,
};

const item: DiscordOutboxItem = {
  id: 7,
  feedId: 1,
  eventKey: 'article:1:9',
  attempts: 0,
  payload: {
    kind: 'article',
    article: {
      title: 'News',
      url: 'https://www.ligainsider.de/news/',
      publishedAt: '2026-08-04T10:00:00.000Z',
    },
    players: [{ name: 'Player', profileUrl: 'https://www.ligainsider.de/player/' }],
  },
};

const logger: DiscordLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function lifecycle(): DiscordLifecyclePort {
  return {
    getFeed: vi.fn(async () => feed),
    attachChannel: vi.fn(async () => true),
    listFeedsForChannelReconciliation: vi.fn(async () => []),
    markChannelMissing: vi.fn(async () => undefined),
    markMemberDeparted: vi.fn(async () => undefined),
    listFeedsDueForDeletion: vi.fn(async () => []),
    beginFeedDeletion: vi.fn(async () => false),
    completeFeedDeletion: vi.fn(async () => undefined),
    releaseFeedDeletion: vi.fn(async () => undefined),
  };
}

function outbox(first: DiscordOutboxItem | null): DiscordOutboxPort {
  let pending = first;
  return {
    getNextDue: vi.fn(async () => {
      const result = pending;
      pending = null;
      return result;
    }),
    markDelivered: vi.fn(async () => undefined),
    reschedule: vi.fn(async () => undefined),
    markDead: vi.fn(async () => undefined),
  };
}

describe('Discord outbox worker', () => {
  it('sends with a deterministic nonce and marks the row delivered', async () => {
    const send = vi.fn(async () => ({ id: 'message' }));
    const channel = { id: 'channel', send } as unknown as TextChannel;
    const channelManager = {
      ensurePrivateChannel: vi.fn(async () => channel),
    } as unknown as PrivateChannelManager;
    const outboxPort = outbox(item);
    const worker = new DiscordOutboxWorker({
      outbox: outboxPort,
      lifecycle: lifecycle(),
      channelManager,
      clock: { now: () => new Date('2026-08-04T10:00:00.000Z') },
      logger,
    });

    await worker.runOnce();

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        nonce: deterministicDiscordNonce(item.eventKey),
        enforceNonce: true,
        allowedMentions: { parse: [], users: [], roles: [], repliedUser: false },
      }),
    );
    expect(outboxPort.markDelivered).toHaveBeenCalledWith({
      outboxId: 7,
      discordMessageId: 'message',
      deliveredAt: '2026-08-04T10:00:00.000Z',
    });
  });

  it('reschedules transient delivery errors with bounded exponential backoff', async () => {
    const send = vi.fn(async () => {
      throw new Error('network unavailable');
    });
    const channel = { id: 'channel', send } as unknown as TextChannel;
    const channelManager = {
      ensurePrivateChannel: vi.fn(async () => channel),
    } as unknown as PrivateChannelManager;
    const outboxPort = outbox(item);
    const worker = new DiscordOutboxWorker({
      outbox: outboxPort,
      lifecycle: lifecycle(),
      channelManager,
      clock: { now: () => new Date('2026-08-04T10:00:00.000Z') },
      logger,
    });

    await worker.runOnce();

    expect(outboxPort.reschedule).toHaveBeenCalledWith({
      outboxId: 7,
      attempts: 1,
      nextAttemptAt: '2026-08-04T10:00:02.000Z',
      error: 'network unavailable',
    });
  });

  it('uses stable 25-character nonces and caps retry delay', () => {
    expect(deterministicDiscordNonce('event')).toHaveLength(25);
    expect(deterministicDiscordNonce('event')).toBe(deterministicDiscordNonce('event'));
    expect(nextOutboxAttemptAt(new Date('2026-08-04T10:00:00.000Z'), 99)).toBe(
      '2026-08-04T10:15:00.000Z',
    );
  });

  it('retries rate limits and server errors but rejects missing permissions', () => {
    const body = { body: null, files: undefined };
    const missingPermissions = new DiscordAPIError(
      { message: 'Missing permissions', code: RESTJSONErrorCodes.MissingPermissions },
      RESTJSONErrorCodes.MissingPermissions,
      403,
      'POST',
      'https://discord.test/channels/1/messages',
      body,
    );

    expect(
      classifyDiscordDeliveryError(new HTTPError(429, 'Rate limited', 'POST', '/', body)),
    ).toBe('retry');
    expect(classifyDiscordDeliveryError(new HTTPError(503, 'Unavailable', 'POST', '/', body))).toBe(
      'retry',
    );
    expect(classifyDiscordDeliveryError(new HTTPError(400, 'Invalid', 'POST', '/', body))).toBe(
      'dead',
    );
    expect(classifyDiscordDeliveryError(missingPermissions)).toBe('dead');
  });

  it('dead-letters delivery when the target feed no longer exists', async () => {
    const lifecyclePort = lifecycle();
    vi.mocked(lifecyclePort.getFeed).mockResolvedValue(null);
    const outboxPort = outbox(item);
    const worker = new DiscordOutboxWorker({
      outbox: outboxPort,
      lifecycle: lifecyclePort,
      channelManager: {} as PrivateChannelManager,
      clock: { now: () => new Date('2026-08-04T10:00:00.000Z') },
      logger,
    });

    await worker.runOnce();

    expect(outboxPort.markDead).toHaveBeenCalledWith({
      outboxId: 7,
      attempts: 1,
      error: 'The target feed no longer exists',
    });
  });
});
