export const LIGAINSIDER_ORIGIN = 'https://www.ligainsider.de';

const PLAYER_PATH_PATTERN = /^\/[a-z0-9][a-z0-9-]*_\d+\/?$/i;

export class UnsafeLigaInsiderUrlError extends Error {
  public constructor(url: string) {
    super(`The URL is not an allowed LigaInsider URL: ${url}`);
    this.name = 'UnsafeLigaInsiderUrlError';
  }
}

export function normalizeLigaInsiderUrl(
  input: string,
  options: { stripSearch?: boolean } = {},
): string {
  let url: URL;
  try {
    url = new URL(input, LIGAINSIDER_ORIGIN);
  } catch {
    throw new UnsafeLigaInsiderUrlError(input);
  }

  if (url.protocol !== 'https:') {
    throw new UnsafeLigaInsiderUrlError(input);
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname !== 'www.ligainsider.de' && hostname !== 'ligainsider.de') {
    throw new UnsafeLigaInsiderUrlError(input);
  }

  url.hostname = 'www.ligainsider.de';
  url.port = '';
  url.username = '';
  url.password = '';
  url.hash = '';
  if (options.stripSearch ?? true) {
    url.search = '';
  }

  return url.toString();
}

export function normalizePlayerProfileUrl(input: string): string {
  const normalized = normalizeLigaInsiderUrl(input);
  const url = new URL(normalized);
  if (!PLAYER_PATH_PATTERN.test(url.pathname)) {
    throw new UnsafeLigaInsiderUrlError(input);
  }
  if (!url.pathname.endsWith('/')) {
    url.pathname += '/';
  }
  return url.toString();
}

export function isPlayerProfileUrl(input: string): boolean {
  try {
    normalizePlayerProfileUrl(input);
    return true;
  } catch {
    return false;
  }
}

export function normalizeArticleUrl(input: string): string {
  const normalized = normalizeLigaInsiderUrl(input);
  const url = new URL(normalized);
  if (!/^\/[a-z0-9][a-z0-9-]*_\d+\/.+/i.test(url.pathname)) {
    throw new UnsafeLigaInsiderUrlError(input);
  }
  return normalized;
}

export function normalizePaginationUrl(input: string, profileUrl: string): string {
  const normalized = normalizeLigaInsiderUrl(input, { stripSearch: false });
  const url = new URL(normalized);
  const profile = new URL(normalizePlayerProfileUrl(profileUrl));
  const escapedProfilePath = profile.pathname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const allowedPath = new RegExp(`^${escapedProfilePath}(?:\\d+/)?$`);
  if (!allowedPath.test(url.pathname)) {
    throw new UnsafeLigaInsiderUrlError(input);
  }
  return normalized;
}

export function normalizeImageUrl(input: string | undefined): string | null {
  if (!input) {
    return null;
  }

  try {
    const url = new URL(input, LIGAINSIDER_ORIGIN);
    if (url.protocol !== 'https:') {
      return null;
    }
    const hostname = url.hostname.toLowerCase();
    if (
      hostname !== 'www.ligainsider.de' &&
      hostname !== 'ligainsider.de' &&
      hostname !== 'cdn.ligainsider.de'
    ) {
      return null;
    }
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}
