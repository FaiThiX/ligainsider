import { describe, expect, it } from 'vitest';

import type { TrackedPlayer } from '../../src/discord/contracts.js';
import { buildPlayerListPage, renderOutboxPayload } from '../../src/discord/embeds.js';

function player(id: number, name: string): TrackedPlayer {
  return { id, name, profileUrl: `https://www.ligainsider.de/player-${id}/` };
}

describe('Discord embeds', () => {
  it('sorts and numbers player list pages from one across page boundaries', () => {
    const players = [
      player(12, 'Zulu'),
      ...Array.from({ length: 11 }, (_, index) => player(index + 1, `Player ${index + 1}`)),
    ];

    const first = buildPlayerListPage(players, 0, 10).embed.toJSON();
    const second = buildPlayerListPage(players, 1, 10).embed.toJSON();

    expect(first.description).toContain('1. [Player 1]');
    expect(first.description).toContain('10. [Player 8]');
    expect(second.description).toContain('11. [Player 9]');
    expect(second.description).toContain('12. [Zulu]');
  });

  it('renders one article embed with every matching tracked player', () => {
    const message = renderOutboxPayload({
      kind: 'article',
      article: {
        title: 'A shared article',
        url: 'https://www.ligainsider.de/article/',
        publishedAt: '2026-08-04T10:00:00.000Z',
      },
      players: [
        { name: 'First Player', profileUrl: 'https://www.ligainsider.de/first/' },
        { name: 'Second Player', profileUrl: 'https://www.ligainsider.de/second/' },
      ],
    });

    expect(message.embeds).toHaveLength(1);
    expect(message.embeds[0]?.toJSON().description).toBe(
      'Tracked players: First Player, Second Player',
    );
    expect(message.allowedMentions.parse).toEqual([]);
  });

  it('limits a bootstrap summary to five articles and includes the initial RSS link', () => {
    const message = renderOutboxPayload({
      kind: 'bootstrap',
      player: {
        name: 'Player',
        profileUrl: 'https://www.ligainsider.de/player/',
        clubImageUrl: null,
      },
      articles: Array.from({ length: 7 }, (_, index) => ({
        title: `Article ${index + 1}`,
        url: `https://www.ligainsider.de/article-${index + 1}/`,
        publishedAt: '2026-08-04T10:00:00.000Z',
      })),
      rssUrl: 'https://bot.example/feeds/private.xml',
    });
    const description = message.embeds[0]?.toJSON().description;

    expect(description).toContain('5. [Article 5]');
    expect(description).not.toContain('Article 6');
    expect(description).toContain('https://bot.example/feeds/private.xml');
  });
});
