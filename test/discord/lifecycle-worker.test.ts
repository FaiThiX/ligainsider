import type { TextChannel } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import type { PrivateChannelManager } from '../../src/discord/channel-manager.js';
import type {
  DiscordFeed,
  DiscordLifecyclePort,
  DiscordLogger,
} from '../../src/discord/contracts.js';
import { DiscordLifecycleWorker } from '../../src/discord/lifecycle-worker.js';

const feed: DiscordFeed = {
  id: 1,
  guildId: 'guild',
  userId: 'user',
  channelId: null,
  rssUrl: 'https://bot.example/feeds/token.xml',
  status: 'active',
  deleteAfter: null,
};

const logger: DiscordLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe('Discord lifecycle worker', () => {
  it('attaches replacement channels and completes claimed expirations', async () => {
    const expiringFeed: DiscordFeed = {
      ...feed,
      id: 2,
      channelId: 'old-channel',
      status: 'grace',
      deleteAfter: '2026-08-04T09:00:00.000Z',
    };
    const lifecycle: DiscordLifecyclePort = {
      getFeed: vi.fn(async () => feed),
      attachChannel: vi.fn(async () => true),
      listFeedsForChannelReconciliation: vi.fn(async () => [feed]),
      markChannelMissing: vi.fn(async () => undefined),
      markMemberDeparted: vi.fn(async () => undefined),
      listFeedsDueForDeletion: vi.fn(async () => [
        { feed: expiringFeed, expectedDeleteAfter: expiringFeed.deleteAfter as string },
      ]),
      beginFeedDeletion: vi.fn(async () => true),
      completeFeedDeletion: vi.fn(async () => undefined),
      releaseFeedDeletion: vi.fn(async () => undefined),
    };
    const channel = {
      id: 'new-channel',
      delete: vi.fn(async () => undefined),
    } as unknown as TextChannel;
    const manager = {
      ensurePrivateChannel: vi.fn(async () => channel),
      deletePrivateChannel: vi.fn(async () => undefined),
    } as unknown as PrivateChannelManager;
    const worker = new DiscordLifecycleWorker({
      lifecycle,
      channelManager: manager,
      clock: { now: () => new Date('2026-08-04T10:00:00.000Z') },
      logger,
    });

    await worker.runOnce();

    expect(lifecycle.attachChannel).toHaveBeenCalledWith({
      feedId: 1,
      channelId: 'new-channel',
      previousChannelId: null,
    });
    expect(manager.deletePrivateChannel).toHaveBeenCalledWith(expiringFeed);
    expect(lifecycle.completeFeedDeletion).toHaveBeenCalledWith({
      feedId: 2,
      expectedDeleteAfter: '2026-08-04T09:00:00.000Z',
    });
  });

  it('releases a cleanup claim when Discord channel deletion fails', async () => {
    const expiringFeed: DiscordFeed = {
      ...feed,
      id: 2,
      channelId: 'old-channel',
      status: 'grace',
      deleteAfter: '2026-08-04T09:00:00.000Z',
    };
    const lifecycle: DiscordLifecyclePort = {
      getFeed: vi.fn(async () => feed),
      attachChannel: vi.fn(async () => true),
      listFeedsForChannelReconciliation: vi.fn(async () => []),
      markChannelMissing: vi.fn(async () => undefined),
      markMemberDeparted: vi.fn(async () => undefined),
      listFeedsDueForDeletion: vi.fn(async () => [
        { feed: expiringFeed, expectedDeleteAfter: expiringFeed.deleteAfter as string },
      ]),
      beginFeedDeletion: vi.fn(async () => true),
      completeFeedDeletion: vi.fn(async () => undefined),
      releaseFeedDeletion: vi.fn(async () => undefined),
    };
    const manager = {
      deletePrivateChannel: vi.fn(async () => {
        throw new Error('Discord unavailable');
      }),
    } as unknown as PrivateChannelManager;
    const worker = new DiscordLifecycleWorker({
      lifecycle,
      channelManager: manager,
      clock: { now: () => new Date('2026-08-04T10:00:00.000Z') },
      logger,
    });

    await worker.runOnce();

    expect(lifecycle.releaseFeedDeletion).toHaveBeenCalledWith({
      feedId: 2,
      expectedDeleteAfter: '2026-08-04T09:00:00.000Z',
      error: 'Discord unavailable',
    });
    expect(lifecycle.completeFeedDeletion).not.toHaveBeenCalled();
  });
});
