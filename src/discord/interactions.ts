import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type StringSelectMenuInteraction,
} from 'discord.js';

import { PLAYER_COMMAND_NAME } from './commands.js';
import type {
  DiscordFeed,
  DiscordLifecyclePort,
  DiscordLogger,
  PlayerCandidate,
  PlayerTrackingPort,
} from './contracts.js';
import {
  CONFIRM_PREFIX,
  LIST_PAGE_PREFIX,
  listPageCustomId,
  parseConfirmationCustomId,
  parseListPageCustomId,
} from './custom-ids.js';
import { buildPlayerListPage } from './embeds.js';
import type { PrivateChannelManager } from './channel-manager.js';
import { discordTimestamp, errorMessage } from './runtime.js';
import type { InteractionSessionStore, AddPlayerSession, InteractionSession } from './sessions.js';

const ADD_SELECT_PREFIX = 'pn:add:';
const PLAYER_LIST_PAGE_SIZE = 10;

export interface InteractionControllerOptions {
  guildId: string;
  tracking: PlayerTrackingPort;
  lifecycle: DiscordLifecyclePort;
  channelManager: PrivateChannelManager;
  sessions: InteractionSessionStore;
  logger: DiscordLogger;
}

export class InteractionController {
  constructor(private readonly options: InteractionControllerOptions) {}

  async handle(interaction: Interaction): Promise<void> {
    try {
      if (interaction.guildId !== this.options.guildId) {
        await this.rejectWrongGuild(interaction);
        return;
      }

      if (interaction.isAutocomplete()) {
        await this.handleAutocomplete(interaction);
        return;
      }
      if (interaction.isChatInputCommand() && interaction.commandName === PLAYER_COMMAND_NAME) {
        await this.handlePlayerCommand(interaction);
        return;
      }
      if (interaction.isStringSelectMenu() && interaction.customId.startsWith(ADD_SELECT_PREFIX)) {
        await this.handleAddSelection(interaction);
        return;
      }
      if (interaction.isButton() && interaction.customId.startsWith(CONFIRM_PREFIX)) {
        await this.handleConfirmation(interaction);
        return;
      }
      if (interaction.isButton() && interaction.customId.startsWith(LIST_PAGE_PREFIX)) {
        await this.handleListPage(interaction);
      }
    } catch (error) {
      this.options.logger.error(
        {
          interactionId: interaction.id,
          guildId: interaction.guildId,
          userId: interaction.user.id,
          error: errorMessage(error),
        },
        'A Discord interaction failed',
      );
      await this.respondWithError(interaction);
    }
  }

  private async handlePlayerCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const subcommand = interaction.options.getSubcommand();
    switch (subcommand) {
      case 'add':
        await this.handleAddCommand(interaction);
        break;
      case 'remove':
        await this.handleRemoveCommand(interaction);
        break;
      case 'list':
        await this.handleListCommand(interaction);
        break;
      case 'clear':
        await this.handleClearCommand(interaction);
        break;
      case 'rss':
        await this.handleRssCommand(interaction);
        break;
      default:
        await interaction.reply({
          content: 'That player command is not supported.',
          flags: MessageFlags.Ephemeral,
        });
    }
  }

  private async handleAddCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const query = interaction.options.getString('query', true).trim();
    const resolution = await this.options.tracking.resolvePlayerQuery(query);

    if (resolution.kind === 'not-found') {
      await interaction.editReply(
        'No LigaInsider player matched that name or URL. Check the spelling and try again.',
      );
      return;
    }

    if (resolution.kind === 'multiple') {
      const players = resolution.players.slice(0, 25);
      if (players.length === 0) {
        await interaction.editReply('No usable LigaInsider player result was found.');
        return;
      }
      const session = this.options.sessions.create({
        kind: 'add-player',
        guildId: this.options.guildId,
        userId: interaction.user.id,
        players,
      });
      await interaction.editReply({
        content: 'Several players matched. Choose the player you want to track.',
        components: [this.addPlayerSelect(session)],
      });
      return;
    }

    await this.completeAdd(interaction, resolution.player);
  }

  private async handleAddSelection(interaction: StringSelectMenuInteraction): Promise<void> {
    const sessionId = interaction.customId.slice(ADD_SELECT_PREFIX.length);
    const session = this.options.sessions.get(sessionId);
    if (!session || session.kind !== 'add-player') {
      await interaction.reply({
        content: 'This player selection has expired. Run `/player add` again.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!this.sessionBelongsToInteraction(session, interaction)) {
      await interaction.reply({
        content: 'This player selection belongs to another user.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const selectedIndex = Number.parseInt(interaction.values[0] ?? '', 10);
    const player = session.players[selectedIndex];
    if (!player) {
      await interaction.reply({
        content: 'That player selection is invalid. Run `/player add` again.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    this.options.sessions.consume(session.id);
    await interaction.deferUpdate();
    await this.completeAdd(interaction, player);
  }

  private async completeAdd(
    interaction: ChatInputCommandInteraction | StringSelectMenuInteraction,
    player: PlayerCandidate,
  ): Promise<void> {
    const result = await this.options.tracking.addPlayer({
      guildId: this.options.guildId,
      userId: interaction.user.id,
      player,
    });

    let channelId: string | null = result.feed.channelId;
    let channelError: string | null = null;
    try {
      channelId = await this.ensureAttachedChannel(result.feed);
    } catch (error) {
      channelError = errorMessage(error);
      this.options.logger.error(
        { feedId: result.feed.id, userId: interaction.user.id, error: channelError },
        'Could not provision a private player news channel',
      );
    }

    if (result.kind === 'already-tracked') {
      await interaction.editReply(
        `${result.player.name} is already on your tracking list.${channelId ? ` Updates are posted in <#${channelId}>.` : ''}`,
      );
      return;
    }

    const state = result.reactivated ? 'Tracking was reactivated' : 'Tracking started';
    const destination = channelId
      ? ` Updates will be posted in <#${channelId}>.`
      : ' Tracking is saved, but the private channel could not be prepared yet. The bot will retry automatically.';
    await interaction.editReply(`${state} for ${result.player.name}.${destination}`);
  }

  private async handleRemoveCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await this.options.tracking.removePlayer({
      guildId: this.options.guildId,
      userId: interaction.user.id,
      playerId: interaction.options.getString('player', true),
    });

    if (result.kind === 'not-found') {
      await interaction.editReply('That player is not on your tracking list.');
      return;
    }

    await interaction.editReply(
      `Stopped tracking ${result.player.name}.${this.gracePeriodText(result.deleteAfter)}`,
    );
  }

  private async handleListCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const players = await this.options.tracking.listPlayers({
      guildId: this.options.guildId,
      userId: interaction.user.id,
    });
    const page = buildPlayerListPage(players, 0, PLAYER_LIST_PAGE_SIZE);
    await interaction.editReply({
      embeds: [page.embed],
      components: this.playerListComponents(interaction.user.id, page.page, page.totalPages),
    });
  }

  private async handleListPage(interaction: ButtonInteraction): Promise<void> {
    const parsed = parseListPageCustomId(interaction.customId);
    if (!parsed) {
      return;
    }
    if (parsed.userId !== interaction.user.id) {
      await interaction.reply({
        content: 'These controls belong to another user.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferUpdate();
    const players = await this.options.tracking.listPlayers({
      guildId: this.options.guildId,
      userId: interaction.user.id,
    });
    const page = buildPlayerListPage(players, parsed.page, PLAYER_LIST_PAGE_SIZE);
    await interaction.editReply({
      embeds: [page.embed],
      components: this.playerListComponents(interaction.user.id, page.page, page.totalPages),
    });
  }

  private async handleClearCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const session = this.options.sessions.create({
      kind: 'clear-players',
      guildId: this.options.guildId,
      userId: interaction.user.id,
    });
    await interaction.reply({
      content:
        'Stop tracking every player? Your private channel and RSS feed will enter the configured grace period.',
      components: [this.confirmationButtons(session.id, 'Clear all players')],
      flags: MessageFlags.Ephemeral,
    });
  }

  private async handleRssCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const action = interaction.options.getString('action', true);
    if (action === 'show') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await this.options.tracking.getRssFeed({
        guildId: this.options.guildId,
        userId: interaction.user.id,
      });
      await interaction.editReply(
        result
          ? `Your private RSS feed: <${result.feed.rssUrl}>\nKeep this link secret.`
          : 'You do not have an RSS feed yet. Add a player first.',
      );
      return;
    }

    const session = this.options.sessions.create({
      kind: 'rotate-rss',
      guildId: this.options.guildId,
      userId: interaction.user.id,
    });
    await interaction.reply({
      content:
        'Rotate your private RSS link? The current link will stop working immediately and cannot be recovered.',
      components: [this.confirmationButtons(session.id, 'Rotate RSS link')],
      flags: MessageFlags.Ephemeral,
    });
  }

  private async handleConfirmation(interaction: ButtonInteraction): Promise<void> {
    const parsed = parseConfirmationCustomId(interaction.customId);
    if (!parsed) {
      return;
    }
    const session = this.options.sessions.get(parsed.sessionId);
    if (!session) {
      await interaction.reply({
        content: 'This confirmation has expired. Run the command again.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!this.sessionBelongsToInteraction(session, interaction)) {
      await interaction.reply({
        content: 'This confirmation belongs to another user.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    this.options.sessions.consume(session.id);
    await interaction.deferUpdate();
    if (!parsed.confirmed) {
      await interaction.editReply({ content: 'Cancelled.', components: [] });
      return;
    }

    if (session.kind === 'clear-players') {
      const result = await this.options.tracking.clearPlayers({
        guildId: this.options.guildId,
        userId: interaction.user.id,
      });
      const message =
        result.removedCount === 0
          ? 'You are not tracking any players.'
          : `Stopped tracking ${result.removedCount} player${result.removedCount === 1 ? '' : 's'}.${this.gracePeriodText(result.deleteAfter)}`;
      await interaction.editReply({ content: message, components: [] });
      return;
    }

    if (session.kind === 'rotate-rss') {
      const result = await this.options.tracking.rotateRssFeed({
        guildId: this.options.guildId,
        userId: interaction.user.id,
      });
      await interaction.editReply({
        content: result
          ? `Your new private RSS feed: <${result.feed.rssUrl}>\nThe previous link no longer works.`
          : 'You do not have an RSS feed yet. Add a player first.',
        components: [],
      });
    }
  }

  private async handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
    if (
      interaction.commandName !== PLAYER_COMMAND_NAME ||
      interaction.options.getSubcommand(false) !== 'remove'
    ) {
      await interaction.respond([]);
      return;
    }

    const query = interaction.options.getFocused().toLocaleLowerCase('en');
    const players = await this.options.tracking.listPlayers({
      guildId: this.options.guildId,
      userId: interaction.user.id,
    });
    const choices = players
      .filter((player) => player.name.toLocaleLowerCase('en').includes(query))
      .sort((left, right) => left.name.localeCompare(right.name, 'en', { sensitivity: 'base' }))
      .slice(0, 25)
      .map((player) => ({
        name: player.name.slice(0, 100),
        value: String(player.id).slice(0, 100),
      }));
    await interaction.respond(choices);
  }

  private addPlayerSelect(session: AddPlayerSession): ActionRowBuilder<StringSelectMenuBuilder> {
    const select = new StringSelectMenuBuilder()
      .setCustomId(`${ADD_SELECT_PREFIX}${session.id}`)
      .setPlaceholder('Choose a player')
      .addOptions(
        session.players.map((player, index) => {
          const option = new StringSelectMenuOptionBuilder()
            .setLabel(player.name.slice(0, 100))
            .setValue(String(index));
          const description = player.clubName ?? player.profileUrl;
          option.setDescription(description.slice(0, 100));
          return option;
        }),
      );
    return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  }

  private confirmationButtons(
    sessionId: string,
    confirmLabel: string,
  ): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${CONFIRM_PREFIX}${sessionId}:yes`)
        .setLabel(confirmLabel)
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`${CONFIRM_PREFIX}${sessionId}:no`)
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary),
    );
  }

  private playerListComponents(
    userId: string,
    page: number,
    totalPages: number,
  ): ActionRowBuilder<ButtonBuilder>[] {
    if (totalPages <= 1) {
      return [];
    }

    return [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(listPageCustomId(userId, page - 1))
          .setLabel('Previous')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page === 0),
        new ButtonBuilder()
          .setCustomId(listPageCustomId(userId, page + 1))
          .setLabel('Next')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page >= totalPages - 1),
      ),
    ];
  }

  private async ensureAttachedChannel(feed: DiscordFeed): Promise<string> {
    const channel = await this.options.channelManager.ensurePrivateChannel(feed);
    if (channel.id === feed.channelId) {
      return channel.id;
    }

    const attached = await this.options.lifecycle.attachChannel({
      feedId: feed.id,
      channelId: channel.id,
      previousChannelId: feed.channelId,
    });
    if (!attached) {
      await channel.delete('Discard a channel created for a feed that changed concurrently');
      throw new Error('The feed changed while its Discord channel was being created');
    }
    return channel.id;
  }

  private gracePeriodText(deleteAfter: string | null): string {
    if (!deleteAfter) {
      return '';
    }
    return ` Your private channel and RSS feed will be deleted ${discordTimestamp(deleteAfter, 'R')} (${discordTimestamp(deleteAfter)}). Add a player before then to keep them.`;
  }

  private sessionBelongsToInteraction(
    session: InteractionSession,
    interaction: ButtonInteraction | StringSelectMenuInteraction,
  ): boolean {
    return session.guildId === interaction.guildId && session.userId === interaction.user.id;
  }

  private async rejectWrongGuild(interaction: Interaction): Promise<void> {
    if (interaction.isAutocomplete()) {
      await interaction.respond([]);
      return;
    }
    if (interaction.isRepliable()) {
      await interaction.reply({
        content: 'This bot is configured for a different Discord server.',
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  private async respondWithError(interaction: Interaction): Promise<void> {
    if (interaction.isAutocomplete()) {
      if (!interaction.responded) {
        await interaction.respond([]).catch(() => undefined);
      }
      return;
    }
    if (!interaction.isRepliable()) {
      return;
    }

    const content = 'Something went wrong while processing that command. Please try again.';
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content, components: [] }).catch(() => undefined);
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => undefined);
    }
  }
}
