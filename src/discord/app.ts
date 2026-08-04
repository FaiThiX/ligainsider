import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  type DMChannel,
  type GuildMember,
  type Interaction,
  type NonThreadGuildBasedChannel,
  type PartialGuildMember,
} from 'discord.js';

import { PrivateChannelManager } from './channel-manager.js';
import { registerGuildPlayerCommand } from './commands.js';
import type { DiscordAppDependencies } from './contracts.js';
import { InteractionController } from './interactions.js';
import { DiscordLifecycleWorker } from './lifecycle-worker.js';
import { DiscordOutboxWorker } from './outbox-worker.js';
import { consoleDiscordLogger, errorMessage, systemClock } from './runtime.js';
import { InteractionSessionStore } from './sessions.js';

export interface DiscordAppConfig {
  token: string;
  applicationId: string;
  guildId: string;
  categoryName?: string;
  lifecycleIntervalMs?: number;
  outboxPollIntervalMs?: number;
  sessionTtlMs?: number;
  registerCommands?: boolean;
}

export interface CreateDiscordAppOptions {
  config: DiscordAppConfig;
  dependencies: DiscordAppDependencies;
  client?: Client;
}

export interface DiscordApplication {
  start(): Promise<void>;
  stop(): Promise<void>;
  isReady(): boolean;
  runLifecycleOnce(): Promise<void>;
  runOutboxOnce(): Promise<void>;
}

export class DiscordApp implements DiscordApplication {
  readonly #config: Required<DiscordAppConfig>;
  readonly #client: Client;
  readonly #dependencies: DiscordAppDependencies;
  readonly #controller: InteractionController;
  readonly #lifecycleWorker: DiscordLifecycleWorker;
  readonly #outboxWorker: DiscordOutboxWorker;
  #started = false;

  constructor(options: CreateDiscordAppOptions) {
    this.#config = {
      ...options.config,
      categoryName: options.config.categoryName ?? 'Player Updates',
      lifecycleIntervalMs: options.config.lifecycleIntervalMs ?? 60_000,
      outboxPollIntervalMs: options.config.outboxPollIntervalMs ?? 2_000,
      sessionTtlMs: options.config.sessionTtlMs ?? 10 * 60_000,
      registerCommands: options.config.registerCommands ?? true,
    };
    this.#dependencies = options.dependencies;
    this.#client =
      options.client ??
      new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

    const logger = options.dependencies.logger ?? consoleDiscordLogger;
    const clock = options.dependencies.clock ?? systemClock;
    const channelManager = new PrivateChannelManager({
      client: this.#client,
      guildId: this.#config.guildId,
      categoryName: this.#config.categoryName,
      logger,
    });
    this.#controller = new InteractionController({
      guildId: this.#config.guildId,
      tracking: options.dependencies.tracking,
      lifecycle: options.dependencies.lifecycle,
      channelManager,
      sessions: new InteractionSessionStore(this.#config.sessionTtlMs, () => clock.now().getTime()),
      logger,
    });
    this.#lifecycleWorker = new DiscordLifecycleWorker({
      lifecycle: options.dependencies.lifecycle,
      channelManager,
      clock,
      logger,
      intervalMs: this.#config.lifecycleIntervalMs,
    });
    this.#outboxWorker = new DiscordOutboxWorker({
      outbox: options.dependencies.outbox,
      lifecycle: options.dependencies.lifecycle,
      channelManager,
      clock,
      logger,
      pollIntervalMs: this.#config.outboxPollIntervalMs,
    });
  }

  async start(): Promise<void> {
    if (this.#started) {
      return;
    }
    this.#started = true;
    this.#client.on(Events.InteractionCreate, this.onInteraction);
    this.#client.on(Events.GuildMemberRemove, this.onGuildMemberRemove);
    this.#client.on(Events.ChannelDelete, this.onChannelDelete);

    try {
      if (this.#config.registerCommands) {
        await registerGuildPlayerCommand({
          token: this.#config.token,
          applicationId: this.#config.applicationId,
          guildId: this.#config.guildId,
        });
      }
      if (!this.#client.isReady()) {
        await this.#client.login(this.#config.token);
      }
      await this.waitUntilReady();
      await this.#client.guilds.fetch(this.#config.guildId);
      this.#lifecycleWorker.start();
      this.#outboxWorker.start();
      (this.#dependencies.logger ?? consoleDiscordLogger).info(
        { guildId: this.#config.guildId },
        'Discord application started',
      );
    } catch (error) {
      this.#started = false;
      this.removeListeners();
      this.#client.destroy();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.#started) {
      return;
    }
    this.#started = false;
    await Promise.all([this.#lifecycleWorker.stop(), this.#outboxWorker.stop()]);
    this.removeListeners();
    this.#client.destroy();
    (this.#dependencies.logger ?? consoleDiscordLogger).info(
      { guildId: this.#config.guildId },
      'Discord application stopped',
    );
  }

  isReady(): boolean {
    return this.#started && this.#client.isReady();
  }

  runLifecycleOnce(): Promise<void> {
    return this.#lifecycleWorker.runOnce();
  }

  runOutboxOnce(): Promise<void> {
    return this.#outboxWorker.runOnce();
  }

  private readonly onInteraction = (interaction: Interaction): void => {
    void this.#controller.handle(interaction);
  };

  private readonly onGuildMemberRemove = (member: GuildMember | PartialGuildMember): void => {
    if (member.guild.id !== this.#config.guildId) {
      return;
    }
    const leftAt = (this.#dependencies.clock ?? systemClock).now().toISOString();
    void this.#dependencies.lifecycle
      .markMemberDeparted({ guildId: member.guild.id, userId: member.id, leftAt })
      .catch((error: unknown) =>
        (this.#dependencies.logger ?? consoleDiscordLogger).error(
          { guildId: member.guild.id, userId: member.id, error: errorMessage(error) },
          'Could not start the grace period for a departed Discord member',
        ),
      );
  };

  private readonly onChannelDelete = (channel: DMChannel | NonThreadGuildBasedChannel): void => {
    if (
      channel.isDMBased() ||
      channel.guildId !== this.#config.guildId ||
      channel.type !== ChannelType.GuildText
    ) {
      return;
    }
    void this.#dependencies.lifecycle
      .markChannelMissing({ guildId: channel.guildId, channelId: channel.id })
      .catch((error: unknown) =>
        (this.#dependencies.logger ?? consoleDiscordLogger).error(
          { guildId: channel.guildId, channelId: channel.id, error: errorMessage(error) },
          'Could not record a deleted private Discord channel',
        ),
      );
  };

  private async waitUntilReady(): Promise<void> {
    if (this.#client.isReady()) {
      return;
    }
    await new Promise<void>((resolve) => this.#client.once(Events.ClientReady, () => resolve()));
  }

  private removeListeners(): void {
    this.#client.off(Events.InteractionCreate, this.onInteraction);
    this.#client.off(Events.GuildMemberRemove, this.onGuildMemberRemove);
    this.#client.off(Events.ChannelDelete, this.onChannelDelete);
  }
}

export function createDiscordApp(options: CreateDiscordAppOptions): DiscordApplication {
  return new DiscordApp(options);
}
