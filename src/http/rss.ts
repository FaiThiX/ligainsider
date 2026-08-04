import { Readable } from 'node:stream';

export interface RssFeed {
  id: number;
  token: string;
  updatedAt: string;
}

export interface RssFeedItem {
  id: number;
  title: string;
  sourceUrl: string;
  publishedAt: string;
  addedAt: string;
  playerNames: string[];
}

export interface RssFeedSnapshot {
  itemCount: number;
  lastChangedAt: string;
  revision: string;
}

export interface RssStore {
  findFeedByToken(token: string): RssFeed | null;
  getFeedSnapshot(feedId: number): RssFeedSnapshot;
  iterateFeedItems(feedId: number): Iterable<RssFeedItem>;
}

export function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function asRfc822(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? new Date(0).toUTCString() : date.toUTCString();
}

function itemTitle(item: RssFeedItem): string {
  const players = item.playerNames.join(', ');
  return players.length > 0 ? `${players}: ${item.title}` : item.title;
}

function* renderRss(feedUrl: string, items: Iterable<RssFeedItem>): Generator<string> {
  const escapedUrl = escapeXml(feedUrl);
  yield '<?xml version="1.0" encoding="UTF-8"?>\n';
  yield '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n';
  yield '  <channel>\n';
  yield '    <title>Player News Updates</title>\n';
  yield `    <link>${escapedUrl}</link>\n`;
  yield '    <description>News for your tracked players, provided by LigaInsider.</description>\n';
  yield '    <language>de-DE</language>\n';
  yield `    <atom:link href="${escapedUrl}" rel="self" type="application/rss+xml" />\n`;
  yield '    <generator>Player News Discord Bot</generator>\n';

  for (const item of items) {
    const sourceUrl = escapeXml(item.sourceUrl);
    const players = item.playerNames.join(', ');
    yield '    <item>\n';
    yield `      <title>${escapeXml(itemTitle(item))}</title>\n`;
    yield `      <link>${sourceUrl}</link>\n`;
    yield `      <guid isPermaLink="true">${sourceUrl}</guid>\n`;
    yield `      <pubDate>${asRfc822(item.publishedAt || item.addedAt)}</pubDate>\n`;
    yield `      <description>${escapeXml(`Tracked players: ${players || 'Unknown'}. Source: LigaInsider.`)}</description>\n`;
    yield '    </item>\n';
  }

  yield '  </channel>\n';
  yield '</rss>\n';
}

export function createRssStream(feedUrl: string, items: Iterable<RssFeedItem>): Readable {
  return Readable.from(renderRss(feedUrl, items), { encoding: 'utf8' });
}

export function createFeedEtag(feedId: number, snapshot: RssFeedSnapshot): string {
  const revision = Buffer.from(snapshot.revision).toString('base64url').slice(0, 32);
  return `W/"${feedId}-${snapshot.itemCount}-${revision}"`;
}
