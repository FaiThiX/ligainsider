export const CONFIRM_PREFIX = 'pn:confirm:';
export const LIST_PAGE_PREFIX = 'pn:list:';

export function listPageCustomId(userId: string, page: number): string {
  return `${LIST_PAGE_PREFIX}${userId}:${Math.max(0, Math.trunc(page))}`;
}

export function parseListPageCustomId(customId: string): { userId: string; page: number } | null {
  if (!customId.startsWith(LIST_PAGE_PREFIX)) {
    return null;
  }
  const [userId, rawPage, ...extra] = customId.slice(LIST_PAGE_PREFIX.length).split(':');
  const page = Number.parseInt(rawPage ?? '', 10);
  if (!userId || extra.length > 0 || !Number.isSafeInteger(page) || page < 0) {
    return null;
  }
  return { userId, page };
}

export function parseConfirmationCustomId(
  customId: string,
): { sessionId: string; confirmed: boolean } | null {
  if (!customId.startsWith(CONFIRM_PREFIX)) {
    return null;
  }
  const [sessionId, answer, ...extra] = customId.slice(CONFIRM_PREFIX.length).split(':');
  if (!sessionId || extra.length > 0 || (answer !== 'yes' && answer !== 'no')) {
    return null;
  }
  return { sessionId, confirmed: answer === 'yes' };
}
