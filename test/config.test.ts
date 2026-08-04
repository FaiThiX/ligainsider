import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';

const requiredEnvironment = {
  DISCORD_TOKEN: 'secret-token',
  DISCORD_APPLICATION_ID: '123456789',
  DISCORD_GUILD_ID: '987654321',
  PUBLIC_BASE_URL: 'https://feeds.example.com/',
};

describe('loadConfig', () => {
  it('loads documented defaults and normalizes the public origin', () => {
    const config = loadConfig(requiredEnvironment);

    expect(config.publicBaseUrl).toBe('https://feeds.example.com');
    expect(config.port).toBe(3_000);
    expect(config.pollIntervalMinutes).toBe(30);
    expect(config.channelDeleteGraceHours).toBe(72);
  });

  it('accepts localhost over plain HTTP for local development', () => {
    const config = loadConfig({
      ...requiredEnvironment,
      PUBLIC_BASE_URL: 'http://127.0.0.1:3000',
    });

    expect(config.publicBaseUrl).toBe('http://127.0.0.1:3000');
  });

  it('rejects a public HTTP origin', () => {
    expect(() =>
      loadConfig({
        ...requiredEnvironment,
        PUBLIC_BASE_URL: 'http://feeds.example.com',
      }),
    ).toThrow(/HTTPS/);
  });
});
