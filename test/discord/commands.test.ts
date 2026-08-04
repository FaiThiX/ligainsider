import { ApplicationCommandOptionType, InteractionContextType } from 'discord.js';
import { describe, expect, it } from 'vitest';

import { buildPlayerCommand } from '../../src/discord/commands.js';

describe('player command definition', () => {
  it('registers all guild-scoped subcommands', () => {
    const command = buildPlayerCommand().toJSON();

    expect(command.name).toBe('player');
    expect(command.contexts).toEqual([InteractionContextType.Guild]);
    expect(command.options?.map((option) => option.name)).toEqual([
      'add',
      'remove',
      'list',
      'clear',
      'rss',
    ]);
    expect(
      command.options?.every((option) => option.type === ApplicationCommandOptionType.Subcommand),
    ).toBe(true);
  });

  it('uses autocomplete for removal and fixed RSS actions', () => {
    const command = buildPlayerCommand().toJSON();
    const remove = command.options?.find((option) => option.name === 'remove');
    const rss = command.options?.find((option) => option.name === 'rss');

    expect(remove).toMatchObject({
      options: [{ name: 'player', required: true, autocomplete: true }],
    });
    expect(rss).toMatchObject({
      options: [
        {
          name: 'action',
          required: true,
          choices: [
            { name: 'Show link', value: 'show' },
            { name: 'Rotate link', value: 'rotate' },
          ],
        },
      ],
    });
  });
});
