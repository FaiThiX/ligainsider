import {
  ChannelType,
  DiscordAPIError,
  OverwriteType,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  type CategoryChannel,
  type Client,
  type Guild,
  type TextChannel,
} from 'discord.js';

import type { DiscordFeed, DiscordLogger } from './contracts.js';

const DISCORD_CATEGORY_CHANNEL_LIMIT = 50;

export interface PrivateChannelManagerOptions {
  client: Client;
  guildId: string;
  categoryName: string;
  logger: DiscordLogger;
}

export class PrivateChannelManager {
  readonly #guildLocks = new Map<string, Promise<void>>();

  constructor(private readonly options: PrivateChannelManagerOptions) {}

  async ensurePrivateChannel(feed: DiscordFeed): Promise<TextChannel> {
    if (feed.guildId !== this.options.guildId) {
      throw new Error(`Feed ${String(feed.id)} belongs to a different guild`);
    }

    return this.withGuildLock(feed.guildId, async () => {
      const guild =
        this.options.client.guilds.cache.get(feed.guildId) ??
        (await this.options.client.guilds.fetch(feed.guildId));
      const existing = await this.fetchTextChannel(guild, feed.channelId);
      if (existing) {
        await this.applyPrivatePermissions(existing, feed.userId);
        return existing;
      }

      const category = await this.findOrCreateCategory(guild);
      const botId = guild.members.me?.id ?? this.options.client.user?.id;
      if (!botId) {
        throw new Error('The Discord bot user is unavailable');
      }

      const member = await guild.members.fetch(feed.userId).catch(() => null);
      const displayName = member?.displayName ?? `user-${feed.userId.slice(-6)}`;
      const channel = await guild.channels.create({
        name: this.channelName(displayName, feed.userId),
        type: ChannelType.GuildText,
        parent: category.id,
        permissionOverwrites: this.permissionOverwrites(guild, feed.userId, botId),
        reason: 'Create a private player news channel',
      });

      this.options.logger.info(
        { feedId: feed.id, guildId: feed.guildId, userId: feed.userId, channelId: channel.id },
        'Created a private player news channel',
      );
      return channel;
    });
  }

  async deletePrivateChannel(feed: DiscordFeed): Promise<void> {
    if (!feed.channelId) {
      return;
    }

    const guild =
      this.options.client.guilds.cache.get(feed.guildId) ??
      (await this.options.client.guilds.fetch(feed.guildId));
    const channel = await guild.channels.fetch(feed.channelId).catch((error: unknown) => {
      if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownChannel) {
        return null;
      }
      throw error;
    });
    if (!channel) {
      return;
    }
    if (channel.type !== ChannelType.GuildText) {
      this.options.logger.error(
        { feedId: feed.id, guildId: feed.guildId, channelId: feed.channelId },
        'Refused to delete a non-text channel referenced by a feed',
      );
      return;
    }

    await channel.delete('Delete an expired player news feed');
    this.options.logger.info(
      { feedId: feed.id, guildId: feed.guildId, channelId: feed.channelId },
      'Deleted an expired player news channel',
    );
  }

  private async fetchTextChannel(
    guild: Guild,
    channelId: string | null,
  ): Promise<TextChannel | null> {
    if (!channelId) {
      return null;
    }

    const cached = guild.channels.cache.get(channelId);
    if (cached) {
      return cached.type === ChannelType.GuildText ? cached : null;
    }

    const channel = await guild.channels.fetch(channelId).catch((error: unknown) => {
      if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownChannel) {
        this.options.logger.warn(
          { guildId: guild.id, channelId },
          'A stored private channel no longer exists',
        );
        return null;
      }
      throw error;
    });
    return channel?.type === ChannelType.GuildText ? channel : null;
  }

  private async findOrCreateCategory(guild: Guild): Promise<CategoryChannel> {
    await guild.channels.fetch();
    const matching = guild.channels.cache
      .filter(
        (channel): channel is CategoryChannel =>
          channel.type === ChannelType.GuildCategory && this.categoryIndex(channel.name) !== null,
      )
      .sort(
        (left, right) =>
          (this.categoryIndex(left.name) ?? Number.MAX_SAFE_INTEGER) -
          (this.categoryIndex(right.name) ?? Number.MAX_SAFE_INTEGER),
      );

    const available = matching.find(
      (category) => category.children.cache.size < DISCORD_CATEGORY_CHANNEL_LIMIT,
    );
    if (available) {
      return available;
    }

    const usedIndexes = new Set(
      matching
        .map((category) => this.categoryIndex(category.name))
        .filter((value) => value !== null),
    );
    let index = 1;
    while (usedIndexes.has(index)) {
      index += 1;
    }
    const botId = guild.members.me?.id ?? this.options.client.user?.id;
    if (!botId) {
      throw new Error('The Discord bot user is unavailable');
    }

    const category = await guild.channels.create({
      name: index === 1 ? this.options.categoryName : `${this.options.categoryName} ${index}`,
      type: ChannelType.GuildCategory,
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          type: OverwriteType.Role,
          deny: [PermissionFlagsBits.ViewChannel],
        },
        {
          id: botId,
          type: OverwriteType.Member,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels],
        },
      ],
      reason: 'Create a private player news category',
    });

    this.options.logger.info(
      { guildId: guild.id, categoryId: category.id, categoryName: category.name },
      'Created a player news category',
    );
    return category;
  }

  private async applyPrivatePermissions(channel: TextChannel, userId: string): Promise<void> {
    const botId = channel.guild.members.me?.id ?? this.options.client.user?.id;
    if (!botId) {
      throw new Error('The Discord bot user is unavailable');
    }

    const expectedIds = new Set([channel.guild.roles.everyone.id, userId, botId]);
    const hasUnexpectedOverwrite = channel.permissionOverwrites.cache.some(
      (overwrite) => !expectedIds.has(overwrite.id),
    );
    const everyone = channel.permissionOverwrites.cache.get(channel.guild.roles.everyone.id);
    const user = channel.permissionOverwrites.cache.get(userId);
    const bot = channel.permissionOverwrites.cache.get(botId);
    const permissionsAreCurrent =
      !hasUnexpectedOverwrite &&
      channel.permissionOverwrites.cache.size === expectedIds.size &&
      everyone?.deny.has(PermissionFlagsBits.ViewChannel) === true &&
      user?.allow.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.UseApplicationCommands,
      ]) === true &&
      bot?.allow.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.ManageChannels,
      ]) === true;

    if (!permissionsAreCurrent) {
      await channel.permissionOverwrites.set(
        this.permissionOverwrites(channel.guild, userId, botId),
        'Reconcile private player news permissions',
      );
    }
  }

  private permissionOverwrites(guild: Guild, userId: string, botId: string) {
    return [
      {
        id: guild.roles.everyone.id,
        type: OverwriteType.Role,
        deny: [PermissionFlagsBits.ViewChannel],
      },
      {
        id: userId,
        type: OverwriteType.Member,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.UseApplicationCommands,
        ],
      },
      {
        id: botId,
        type: OverwriteType.Member,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.ManageChannels,
        ],
      },
    ];
  }

  private categoryIndex(name: string): number | null {
    if (name === this.options.categoryName) {
      return 1;
    }

    const prefix = `${this.options.categoryName} `;
    if (!name.startsWith(prefix)) {
      return null;
    }
    const suffix = name.slice(prefix.length);
    if (!/^\d+$/.test(suffix)) {
      return null;
    }
    const index = Number.parseInt(suffix, 10);
    return index >= 2 ? index : null;
  }

  private channelName(displayName: string, userId: string): string {
    const slug = displayName
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 70);
    return `player-updates-${slug || 'user'}-${userId.slice(-6)}`.slice(0, 100);
  }

  private async withGuildLock<T>(guildId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#guildLocks.get(guildId) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = previous.then(() => current);
    this.#guildLocks.set(guildId, chain);

    await previous;
    try {
      return await operation();
    } finally {
      release?.();
      if (this.#guildLocks.get(guildId) === chain) {
        this.#guildLocks.delete(guildId);
      }
    }
  }
}
