import { InteractionContextType, REST, Routes, SlashCommandBuilder } from 'discord.js';

export const PLAYER_COMMAND_NAME = 'player';

export function buildPlayerCommand() {
  return new SlashCommandBuilder()
    .setName(PLAYER_COMMAND_NAME)
    .setDescription('Track LigaInsider player news')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((subcommand) =>
      subcommand
        .setName('add')
        .setDescription('Add a player to your tracking list')
        .addStringOption((option) =>
          option
            .setName('query')
            .setDescription('A player name or LigaInsider profile URL')
            .setRequired(true)
            .setMinLength(2)
            .setMaxLength(200),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('remove')
        .setDescription('Remove a player from your tracking list')
        .addStringOption((option) =>
          option
            .setName('player')
            .setDescription('The player to stop tracking')
            .setRequired(true)
            .setAutocomplete(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('list').setDescription('Show all players you are tracking'),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('clear').setDescription('Stop tracking every player'),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('rss')
        .setDescription('Show or rotate your private RSS link')
        .addStringOption((option) =>
          option
            .setName('action')
            .setDescription('Choose what to do with your private RSS link')
            .setRequired(true)
            .addChoices(
              { name: 'Show link', value: 'show' },
              { name: 'Rotate link', value: 'rotate' },
            ),
        ),
    );
}

export interface RegisterPlayerCommandOptions {
  token: string;
  applicationId: string;
  guildId: string;
  rest?: REST;
}

export async function registerGuildPlayerCommand(
  options: RegisterPlayerCommandOptions,
): Promise<void> {
  const rest = options.rest ?? new REST({ version: '10' }).setToken(options.token);
  await rest.put(Routes.applicationGuildCommands(options.applicationId, options.guildId), {
    body: [buildPlayerCommand().toJSON()],
  });
}
