import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

import { RepositoryDiscordPorts } from './adapters/discord-ports.js';
import { RepositoryRssStore } from './adapters/repository-rss-store.js';
import { loadConfig } from './config.js';
import { PollingService, TrackingService, type CoreLogger } from './core/index.js';
import { openDatabase, Repository } from './db/index.js';
import { createDiscordApp, type DiscordApplication, type DiscordLogger } from './discord/index.js';
import { createHttpServer } from './http/index.js';
import { LigaInsiderClient } from './ligainsider/index.js';

export interface ApplicationRuntime {
  isReady(): boolean;
  stop(reason?: string): Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function startApplication(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ApplicationRuntime> {
  const config = loadConfig(environment);
  if (config.databasePath !== ':memory:') {
    await mkdir(dirname(config.databasePath), { recursive: true });
  }

  const database = openDatabase(config.databasePath);
  const repository = new Repository(database);
  let discord: DiscordApplication | null = null;
  const rssStore = new RepositoryRssStore(repository);
  const server = createHttpServer({
    loggerLevel: config.logLevel,
    publicBaseUrl: config.publicBaseUrl,
    rssStore,
    readiness: () => {
      try {
        return repository.ping() && discord?.isReady() === true;
      } catch {
        return false;
      }
    },
  });
  const logger: DiscordLogger & CoreLogger = {
    debug: (context, message) => server.log.debug(context, message),
    info: (context, message) => server.log.info(context, message),
    warn: (context, message) => server.log.warn(context, message),
    error: (context, message) => server.log.error(context, message),
  };

  const recoveredClaims = repository.releaseAllFeedDeletionClaims(new Date().toISOString());
  if (recoveredClaims > 0) {
    logger.warn(
      { recoveredClaims },
      'Recovered interrupted feed cleanup operations after startup.',
    );
  }

  const ligaInsiderClient = new LigaInsiderClient({
    logger,
    minRequestIntervalMs: config.sourceRequestDelayMs,
    timeoutMs: config.sourceRequestTimeoutMs,
    retries: config.sourceMaxRetries,
  });
  const trackingService = new TrackingService(repository, {
    publicBaseUrl: config.publicBaseUrl,
    graceHours: config.channelDeleteGraceHours,
  });
  const ports = new RepositoryDiscordPorts({
    repository,
    trackingService,
    ligaInsiderClient,
    publicBaseUrl: config.publicBaseUrl,
  });
  discord = createDiscordApp({
    config: {
      token: config.discordToken,
      applicationId: config.discordApplicationId,
      guildId: config.discordGuildId,
      categoryName: config.channelCategoryName,
      lifecycleIntervalMs: 60_000,
    },
    dependencies: {
      tracking: ports,
      lifecycle: ports,
      outbox: ports,
      logger,
    },
  });
  const polling = new PollingService(repository, trackingService, ligaInsiderClient, {
    intervalMs: config.pollIntervalMinutes * 60_000,
    maxCatchUpPages: config.sourceMaxCatchupPages,
    logger,
  });

  let stopped = false;
  const stop = async (reason = 'Application shutdown requested.'): Promise<void> => {
    if (stopped) {
      return;
    }
    stopped = true;
    logger.info({ reason }, 'Stopping the application.');
    await discord?.stop();
    await polling.stop();
    await server.close();
    repository.close();
    logger.info({}, 'Application stopped.');
  };

  try {
    await server.listen({ host: '0.0.0.0', port: config.port });
    await discord.start();
    polling.start(true);
    logger.info(
      {
        guildId: config.discordGuildId,
        port: config.port,
        pollIntervalMinutes: config.pollIntervalMinutes,
      },
      'Player News Discord Bot started.',
    );
  } catch (error) {
    await stop('Application startup failed.').catch(() => undefined);
    throw error;
  }

  return {
    isReady: () => !stopped && repository.ping() && discord?.isReady() === true,
    stop,
  };
}

async function main(): Promise<void> {
  const runtime = await startApplication();
  const shutdown = (signal: NodeJS.Signals): void => {
    void runtime
      .stop(`Received ${signal}.`)
      .then(() => {
        process.exitCode = 0;
      })
      .catch((error: unknown) => {
        console.error(
          JSON.stringify({
            level: 'error',
            message: 'Graceful shutdown failed.',
            error: errorMessage(error),
          }),
        );
        process.exitCode = 1;
      });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entrypoint === import.meta.url) {
  void main().catch((error: unknown) => {
    console.error(
      JSON.stringify({
        level: 'fatal',
        message: 'Application startup failed.',
        error: errorMessage(error),
      }),
    );
    process.exitCode = 1;
  });
}
