import { describe, expect, it } from 'vitest';

import {
  listPageCustomId,
  parseConfirmationCustomId,
  parseListPageCustomId,
} from '../../src/discord/custom-ids.js';
import { InteractionSessionStore } from '../../src/discord/sessions.js';

describe('interaction sessions and custom IDs', () => {
  it('expires sessions and consumes confirmations only once', () => {
    let now = 1_000;
    const store = new InteractionSessionStore(100, () => now);
    const first = store.create({ kind: 'clear-players', guildId: 'guild', userId: 'user' });

    expect(store.consume(first.id)).toEqual(first);
    expect(store.consume(first.id)).toBeNull();

    const second = store.create({ kind: 'rotate-rss', guildId: 'guild', userId: 'user' });
    now = 1_100;
    expect(store.get(second.id)).toBeNull();
  });

  it('round-trips owner-bound pagination IDs and rejects malformed IDs', () => {
    expect(parseListPageCustomId(listPageCustomId('123456789', 4))).toEqual({
      userId: '123456789',
      page: 4,
    });
    expect(parseListPageCustomId('pn:list:123:-1')).toBeNull();
    expect(parseListPageCustomId('pn:list:123:1:extra')).toBeNull();
  });

  it('parses explicit confirmation answers', () => {
    expect(parseConfirmationCustomId('pn:confirm:session:yes')).toEqual({
      sessionId: 'session',
      confirmed: true,
    });
    expect(parseConfirmationCustomId('pn:confirm:session:no')).toEqual({
      sessionId: 'session',
      confirmed: false,
    });
    expect(parseConfirmationCustomId('pn:confirm:session:maybe')).toBeNull();
  });
});
