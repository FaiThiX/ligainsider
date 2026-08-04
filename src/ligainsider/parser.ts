import * as cheerio from 'cheerio';
import { DateTime } from 'luxon';

import type {
  LigaInsiderArticle,
  LigaInsiderLogger,
  PlayerProfilePage,
  PlayerSearchResult,
} from './types.js';
import {
  isPlayerProfileUrl,
  normalizeArticleUrl,
  normalizeImageUrl,
  normalizePaginationUrl,
  normalizePlayerProfileUrl,
} from './url.js';

const SOURCE_ZONE = 'Europe/Berlin';
const SOURCE_DATE_FORMAT = 'dd.MM.yyyy - HH:mm';

export function normalizeSourceText(value: string): string {
  return value.replaceAll('\u00ad', '').replace(/\s+/g, ' ').trim();
}

export function parseSourceDate(
  value: string,
  fallback: string,
): { value: string; usedFallback: boolean } {
  const parsed = DateTime.fromFormat(normalizeSourceText(value), SOURCE_DATE_FORMAT, {
    zone: SOURCE_ZONE,
    locale: 'de',
  });

  if (!parsed.isValid) {
    return { value: fallback, usedFallback: true };
  }

  const iso = parsed.toUTC().toISO({ suppressMilliseconds: true });
  return { value: iso ?? fallback, usedFallback: iso === null };
}

export function parsePlayerSearchResults(html: string): PlayerSearchResult[] {
  const $ = cheerio.load(html);
  const results = new Map<string, PlayerSearchResult>();
  const hasSectionTitles = $('li.title_search').length > 0;
  let inPlayerSection = !hasSectionTitles;

  $('li').each((_index, listItem) => {
    const item = $(listItem);
    if (item.hasClass('title_search')) {
      inPlayerSection = /^spieler\b/i.test(normalizeSourceText(item.text()));
      return;
    }
    if (!inPlayerSection || !item.hasClass('search_result')) {
      return;
    }

    const element = item.find('a').first();
    const href = element.attr('href');
    if (!href || !isPlayerProfileUrl(href)) {
      return;
    }

    const profileUrl = normalizePlayerProfileUrl(href);
    const name = normalizeSourceText(element.clone().find('img').remove().end().text());
    if (!name) {
      return;
    }

    if (!results.has(profileUrl)) {
      results.set(profileUrl, {
        name,
        profileUrl,
        clubImageUrl: normalizeImageUrl(element.find('img').first().attr('src')),
      });
    }
  });

  return [...results.values()];
}

function findPlayerName($: cheerio.CheerioAPI, profileUrl: string): string {
  const newsHeading = normalizeSourceText(
    $('#news .green_title h2, .news_container_box_box .green_title h2').first().text(),
  ).replace(/^NEWS\s+von\s+/i, '');
  if (newsHeading) {
    return newsHeading;
  }

  const heading = normalizeSourceText($('h1').first().text());
  if (heading) {
    return heading;
  }

  const slug = new URL(profileUrl).pathname.split('/').filter(Boolean)[0] ?? '';
  return slug
    .replace(/_\d+$/, '')
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function findNextPageUrl($: cheerio.CheerioAPI, profileUrl: string): string | null {
  const candidates = $(
    "a[rel='next'], .pagination a, .pages a, .pagination_container a, .news_pagination a, .news_pagination_right a",
  ).toArray();

  for (const element of candidates) {
    const text = normalizeSourceText($(element).text()).toLowerCase();
    const rel = ($(element).attr('rel') ?? '').toLowerCase();
    const aria = ($(element).attr('aria-label') ?? '').toLowerCase();
    const looksNext =
      rel.split(/\s+/).includes('next') ||
      text.startsWith('weiter') ||
      text === '>' ||
      text === '›' ||
      text === '»' ||
      aria.includes('next') ||
      aria.includes('weiter');
    if (!looksNext) {
      continue;
    }

    const href = $(element).attr('href');
    if (!href) {
      continue;
    }

    try {
      return normalizePaginationUrl(href, profileUrl);
    } catch {
      continue;
    }
  }

  return null;
}

export function parsePlayerProfilePage(
  html: string,
  profileUrlInput: string,
  options: { discoveredAt?: string; logger?: LigaInsiderLogger } = {},
): PlayerProfilePage {
  const profileUrl = normalizePlayerProfileUrl(profileUrlInput);
  const discoveredAt = options.discoveredAt ?? new Date().toISOString();
  const $ = cheerio.load(html);
  const player: PlayerSearchResult = {
    name: findPlayerName($, profileUrl),
    profileUrl,
    clubImageUrl: normalizeImageUrl(
      $(
        '.top_title .left_photo_icon .photo_column:first img, .photo_column.pull-left a img, .photo_column a img',
      )
        .first()
        .attr('src'),
    ),
  };
  const articles = new Map<string, LigaInsiderArticle>();

  $('.news_container .news_row').each((_index, element) => {
    const anchor = $(element).find('h3 a').first();
    const title = normalizeSourceText(anchor.text());
    const href = anchor.attr('href');
    if (!title || !href) {
      return;
    }

    let url: string;
    try {
      url = normalizeArticleUrl(href);
    } catch {
      options.logger?.warn?.({ href, profileUrl }, 'Ignored an article with an unsafe URL.');
      return;
    }

    const rawDate = $(element).find('.news_column_mid span').first().text();
    const publishedAt = parseSourceDate(rawDate, discoveredAt);
    if (publishedAt.usedFallback) {
      options.logger?.warn?.(
        { profileUrl, articleUrl: url, sourceDate: normalizeSourceText(rawDate) },
        'The source date was invalid; the discovery time was used instead.',
      );
    }

    if (!articles.has(url)) {
      articles.set(url, {
        title,
        url,
        publishedAt: publishedAt.value,
        discoveredAt,
        usedFallbackDate: publishedAt.usedFallback,
      });
    }
  });

  return {
    player,
    articles: [...articles.values()],
    nextPageUrl: findNextPageUrl($, profileUrl),
  };
}
