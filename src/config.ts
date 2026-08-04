import { z } from 'zod';

const integerFromEnvironment = (minimum: number, maximum: number) =>
  z.coerce.number().int().min(minimum).max(maximum);

const publicBaseUrl = z
  .string()
  .url()
  .transform((value) => value.replace(/\/+$/, ''))
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === 'https:' ||
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '::1'
    );
  }, 'PUBLIC_BASE_URL must use HTTPS unless it points to localhost.');

const configSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_APPLICATION_ID: z.string().regex(/^\d+$/),
  DISCORD_GUILD_ID: z.string().regex(/^\d+$/),
  PUBLIC_BASE_URL: publicBaseUrl,
  PORT: integerFromEnvironment(1, 65_535).default(3_000),
  DATABASE_PATH: z.string().min(1).default('/data/player-news.sqlite'),
  POLL_INTERVAL_MINUTES: integerFromEnvironment(1, 24 * 60).default(30),
  CHANNEL_CATEGORY_NAME: z.string().trim().min(1).max(90).default('Player Updates'),
  CHANNEL_DELETE_GRACE_HOURS: integerFromEnvironment(1, 24 * 365).default(72),
  SOURCE_REQUEST_DELAY_MS: integerFromEnvironment(500, 60_000).default(1_000),
  SOURCE_REQUEST_TIMEOUT_MS: integerFromEnvironment(1_000, 120_000).default(15_000),
  SOURCE_MAX_RETRIES: integerFromEnvironment(0, 10).default(2),
  SOURCE_MAX_CATCHUP_PAGES: integerFromEnvironment(1, 10).default(10),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export interface AppConfig {
  discordToken: string;
  discordApplicationId: string;
  discordGuildId: string;
  publicBaseUrl: string;
  port: number;
  databasePath: string;
  pollIntervalMinutes: number;
  channelCategoryName: string;
  channelDeleteGraceHours: number;
  sourceRequestDelayMs: number;
  sourceRequestTimeoutMs: number;
  sourceMaxRetries: number;
  sourceMaxCatchupPages: number;
  logLevel: z.infer<typeof configSchema>['LOG_LEVEL'];
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = configSchema.parse(environment);

  return {
    discordToken: parsed.DISCORD_TOKEN,
    discordApplicationId: parsed.DISCORD_APPLICATION_ID,
    discordGuildId: parsed.DISCORD_GUILD_ID,
    publicBaseUrl: parsed.PUBLIC_BASE_URL,
    port: parsed.PORT,
    databasePath: parsed.DATABASE_PATH,
    pollIntervalMinutes: parsed.POLL_INTERVAL_MINUTES,
    channelCategoryName: parsed.CHANNEL_CATEGORY_NAME,
    channelDeleteGraceHours: parsed.CHANNEL_DELETE_GRACE_HOURS,
    sourceRequestDelayMs: parsed.SOURCE_REQUEST_DELAY_MS,
    sourceRequestTimeoutMs: parsed.SOURCE_REQUEST_TIMEOUT_MS,
    sourceMaxRetries: parsed.SOURCE_MAX_RETRIES,
    sourceMaxCatchupPages: parsed.SOURCE_MAX_CATCHUP_PAGES,
    logLevel: parsed.LOG_LEVEL,
  };
}
