import { EmbedBuilder, escapeMarkdown } from 'discord.js';

import type { ArticleSummary, DiscordOutboxPayload, TrackedPlayer } from './contracts.js';
import { discordTimestamp } from './runtime.js';

const COLORS = {
  info: 0x3b82f6,
  success: 0x22c55e,
  warning: 0xf59e0b,
} as const;

const MAX_EMBED_DESCRIPTION_LENGTH = 4_096;
const MAX_EMBED_TITLE_LENGTH = 256;

function truncate(value: string, maximumLength: number): string {
  if (value.length <= maximumLength) {
    return value;
  }

  return `${value.slice(0, maximumLength - 1)}…`;
}

function validTimestamp(timestamp: string): string | null {
  return Number.isNaN(new Date(timestamp).getTime()) ? null : timestamp;
}

function articleLine(article: ArticleSummary, index: number): string {
  return `${index + 1}. [${escapeMarkdown(article.title)}](${article.url})`;
}

export function buildArticleEmbed(
  payload: Extract<DiscordOutboxPayload, { kind: 'article' }>,
): EmbedBuilder {
  const playerNames = payload.players.map((player) => escapeMarkdown(player.name)).join(', ');
  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(truncate(payload.article.title, MAX_EMBED_TITLE_LENGTH))
    .setURL(payload.article.url)
    .setDescription(truncate(`Tracked players: ${playerNames}`, MAX_EMBED_DESCRIPTION_LENGTH))
    .setFooter({ text: 'Source: LigaInsider' });
  const timestamp = validTimestamp(payload.article.publishedAt);
  if (timestamp) {
    embed.setTimestamp(new Date(timestamp));
  }
  return embed;
}

export function buildBootstrapEmbed(
  payload: Extract<DiscordOutboxPayload, { kind: 'bootstrap' }>,
): EmbedBuilder {
  const articles = payload.articles.slice(0, 5);
  const lines = articles.map(articleLine);
  if (payload.rssUrl) {
    lines.push('', `Your private RSS feed: ${payload.rssUrl}`);
  }

  const description =
    lines.length > 0
      ? lines.join('\n')
      : 'The player is now tracked. No recent articles were found.';
  const embed = new EmbedBuilder()
    .setColor(COLORS.success)
    .setTitle(truncate(`Now tracking ${payload.player.name}`, MAX_EMBED_TITLE_LENGTH))
    .setURL(payload.player.profileUrl)
    .setDescription(truncate(description, MAX_EMBED_DESCRIPTION_LENGTH))
    .setFooter({ text: 'Source: LigaInsider' });

  if (payload.player.clubImageUrl) {
    embed.setThumbnail(payload.player.clubImageUrl);
  }
  return embed;
}

export function buildDeletionWarningEmbed(
  payload: Extract<DiscordOutboxPayload, { kind: 'deletion-warning' }>,
): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(COLORS.warning)
    .setTitle('Tracking paused')
    .setDescription(
      `You are no longer tracking any players. This channel and its RSS feed will be deleted ${discordTimestamp(payload.deleteAfter, 'R')} (${discordTimestamp(payload.deleteAfter)}). Add a player before then to keep both.`,
    );
}

export function renderOutboxPayload(payload: DiscordOutboxPayload): {
  embeds: EmbedBuilder[];
  allowedMentions: {
    parse: [];
    users: [];
    roles: [];
    repliedUser: false;
  };
} {
  let embed: EmbedBuilder;
  switch (payload.kind) {
    case 'article':
      embed = buildArticleEmbed(payload);
      break;
    case 'bootstrap':
      embed = buildBootstrapEmbed(payload);
      break;
    case 'deletion-warning':
      embed = buildDeletionWarningEmbed(payload);
      break;
  }

  return {
    embeds: [embed],
    allowedMentions: { parse: [], users: [], roles: [], repliedUser: false },
  };
}

export interface PlayerListPage {
  embed: EmbedBuilder;
  page: number;
  totalPages: number;
  totalPlayers: number;
}

export function buildPlayerListPage(
  unsortedPlayers: readonly TrackedPlayer[],
  requestedPage: number,
  pageSize = 10,
): PlayerListPage {
  const players = [...unsortedPlayers].sort((left, right) =>
    left.name.localeCompare(right.name, 'en', { sensitivity: 'base' }),
  );
  const totalPages = Math.max(1, Math.ceil(players.length / pageSize));
  const page = Math.max(0, Math.min(Math.trunc(requestedPage), totalPages - 1));
  const start = page * pageSize;
  const pagePlayers = players.slice(start, start + pageSize);
  const description =
    pagePlayers.length === 0
      ? 'You are not tracking any players.'
      : pagePlayers
          .map(
            (player, index) =>
              `${start + index + 1}. [${escapeMarkdown(player.name)}](${player.profileUrl})`,
          )
          .join('\n');

  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('Tracked players')
    .setDescription(description)
    .setFooter({
      text: `Page ${page + 1} of ${totalPages} • ${players.length} player${players.length === 1 ? '' : 's'}`,
    });

  return { embed, page, totalPages, totalPlayers: players.length };
}
