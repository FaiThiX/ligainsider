import { randomBytes } from 'node:crypto';

import type { Clock, DiscordLogger } from './contracts.js';

export const systemClock: Clock = {
  now: () => new Date(),
};

export const consoleDiscordLogger: DiscordLogger = {
  debug: (context, message) => console.debug(message, context),
  info: (context, message) => console.info(message, context),
  warn: (context, message) => console.warn(message, context),
  error: (context, message) => console.error(message, context),
};

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function createSessionId(): string {
  return randomBytes(9).toString('base64url');
}

export function discordTimestamp(isoTimestamp: string, style: 'F' | 'R' = 'F'): string {
  const unixSeconds = Math.floor(new Date(isoTimestamp).getTime() / 1_000);

  if (!Number.isFinite(unixSeconds)) {
    return isoTimestamp;
  }

  return `<t:${unixSeconds}:${style}>`;
}
