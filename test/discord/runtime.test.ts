import { describe, expect, it } from 'vitest';

import {
  createSessionId,
  discordTimestamp,
  errorMessage,
  systemClock,
} from '../../src/discord/runtime.js';

describe('Discord runtime helpers', () => {
  it('creates compact session identifiers and Discord timestamps', () => {
    expect(createSessionId()).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(discordTimestamp('2026-08-04T10:00:00.000Z', 'R')).toBe('<t:1785837600:R>');
    expect(discordTimestamp('invalid')).toBe('invalid');
    expect(systemClock.now()).toBeInstanceOf(Date);
  });

  it('normalizes thrown and non-error values for structured logs', () => {
    expect(errorMessage(new Error('failure'))).toBe('failure');
    expect(errorMessage(42)).toBe('42');
  });
});
