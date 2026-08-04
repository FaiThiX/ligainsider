import { describe, expect, it, vi } from 'vitest';

import { LigaInsiderClient, UnsafeLigaInsiderUrlError } from '../../src/ligainsider/index.js';

describe('LigaInsiderClient', () => {
  it('uses the public player search endpoint', async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      expect(url).toContain('searchstring=Noah+Atubolu');
      return new Response(
        '<li class="search_result"><a href="/noah-atubolu_22000/">Noah Atubolu</a></li>',
        { status: 200 },
      );
    });
    const client = new LigaInsiderClient({
      fetch,
      minRequestIntervalMs: 0,
      retries: 0,
    });

    await expect(client.searchPlayers('Noah Atubolu')).resolves.toEqual([
      {
        name: 'Noah Atubolu',
        profileUrl: 'https://www.ligainsider.de/noah-atubolu_22000/',
        clubImageUrl: null,
      },
    ]);
  });

  it('rejects a redirect to another origin', async () => {
    const client = new LigaInsiderClient({
      fetch: async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://example.com/capture' },
        }),
      minRequestIntervalMs: 0,
      retries: 0,
    });

    await expect(
      client.fetchPlayerProfilePage('https://www.ligainsider.de/noah-atubolu_22000/'),
    ).rejects.toBeInstanceOf(UnsafeLigaInsiderUrlError);
  });

  it('retries server failures with exponential backoff', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('Unavailable', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(
          '<div id="news"><div class="green_title"><h2>NEWS von Noah Atubolu</h2></div></div>',
          { status: 200 },
        ),
      );
    const sleep = vi.fn(async () => undefined);
    const client = new LigaInsiderClient({
      fetch,
      sleep,
      minRequestIntervalMs: 0,
      retries: 1,
    });

    await expect(
      client.fetchPlayerProfilePage('https://www.ligainsider.de/noah-atubolu_22000/'),
    ).resolves.toMatchObject({ player: { name: 'Noah Atubolu' } });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1_000);
  });
});
