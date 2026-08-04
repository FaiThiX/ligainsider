import { describe, expect, it, vi } from 'vitest';

import {
  normalizePaginationUrl,
  normalizePlayerProfileUrl,
  parsePlayerProfilePage,
  parsePlayerSearchResults,
  UnsafeLigaInsiderUrlError,
} from '../../src/ligainsider/index.js';

const PROFILE_URL = 'https://www.ligainsider.de/noah-atubolu_22000/';

describe('LigaInsider parsers', () => {
  it('parses and deduplicates player search results', () => {
    const html = `
      <ul>
        <li class="title_search">Spieler <small>(2)</small></li>
        <li class="search_result">
          <a href="/noah-atubolu_22000/">
            <span><img src="https://cdn.ligainsider.de/images/teams/small/sc-freiburg.png"></span>
            Noah Atubolu
          </a>
        </li>
        <li class="title_search">Vereine <small>(1)</small></li>
        <li class="search_result"><a href="/clubs_99/">Not a player</a></li>
      </ul>
    `;

    expect(parsePlayerSearchResults(html)).toEqual([
      {
        name: 'Noah Atubolu',
        profileUrl: PROFILE_URL,
        clubImageUrl: 'https://cdn.ligainsider.de/images/teams/small/sc-freiburg.png',
      },
    ]);
  });

  it('parses profile metadata, article dates, soft hyphens, and pagination', () => {
    const html = `
      <div class="top_title"><div class="left_photo_icon">
        <div class="photo_column"><img src="https://cdn.ligainsider.de/images/teams/small/sc-freiburg.png"></div>
      </div></div>
      </div>
      <div id="news" class="news_container_box_box">
        <div class="green_title"><h2>NEWS von Noah Atubolu</h2></div>
        <div class="news_container">
          <div class="news_row">
            <h3><a href="/noah-atubolu_22000/neues-trainingslager-415276/">Trainings&shy;lager beginnt</a></h3>
            <div class="news_column_mid"><span>03.08.2026 - 20:02</span></div>
          </div>
          <div class="news_row">
            <h3><a href="https://www.ligainsider.de/noah-atubolu_22000/neues-trainingslager-415276/">Duplicate title</a></h3>
            <div class="news_column_mid"><span>03.08.2026 - 20:02</span></div>
          </div>
        </div>
        <div class="news_pagination_right"><a href="/noah-atubolu_22000/2/#news">Weiter &gt;</a></div>
      </div>
    `;

    const page = parsePlayerProfilePage(html, PROFILE_URL, {
      discoveredAt: '2026-08-04T10:00:00.000Z',
    });

    expect(page.player).toEqual({
      name: 'Noah Atubolu',
      profileUrl: PROFILE_URL,
      clubImageUrl: 'https://cdn.ligainsider.de/images/teams/small/sc-freiburg.png',
    });
    expect(page.articles).toEqual([
      {
        title: 'Trainingslager beginnt',
        url: `${PROFILE_URL}neues-trainingslager-415276/`,
        publishedAt: '2026-08-03T18:02:00Z',
        discoveredAt: '2026-08-04T10:00:00.000Z',
        usedFallbackDate: false,
      },
    ]);
    expect(page.nextPageUrl).toBe(`${PROFILE_URL}2/`);
  });

  it('uses the discovery time for invalid dates and drops invalid rows', () => {
    const warn = vi.fn();
    const fallback = '2026-08-04T10:00:00.000Z';
    const html = `
      <div id="news"><div class="green_title"><h2>NEWS von Noah Atubolu</h2></div></div>
      <div class="news_container">
        <div class="news_row">
          <h3><a href="/noah-atubolu_22000/update-1/">Valid article</a></h3>
          <div class="news_column_mid"><span>unknown</span></div>
        </div>
        <div class="news_row"><h3><a>Missing URL</a></h3></div>
        <div class="news_row"><h3><a href="https://example.com/item">Unsafe</a></h3></div>
      </div>
    `;

    const page = parsePlayerProfilePage(html, PROFILE_URL, {
      discoveredAt: fallback,
      logger: { warn },
    });

    expect(page.articles).toHaveLength(1);
    expect(page.articles[0]?.publishedAt).toBe(fallback);
    expect(page.articles[0]?.usedFallbackDate).toBe(true);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('LigaInsider URL validation', () => {
  it('canonicalizes profile URLs with or without a trailing slash', () => {
    expect(normalizePlayerProfileUrl('https://ligainsider.de/noah-atubolu_22000')).toBe(
      PROFILE_URL,
    );
  });

  it('allows only numbered profile pagination paths', () => {
    expect(normalizePaginationUrl('/noah-atubolu_22000/10/#news', PROFILE_URL)).toBe(
      `${PROFILE_URL}10/`,
    );
    expect(() => normalizePaginationUrl('/another-player_1/2/', PROFILE_URL)).toThrow(
      UnsafeLigaInsiderUrlError,
    );
    expect(() =>
      normalizePaginationUrl('https://example.com/noah-atubolu_22000/2/', PROFILE_URL),
    ).toThrow(UnsafeLigaInsiderUrlError);
  });
});
