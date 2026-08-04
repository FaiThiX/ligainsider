import Fastify, { type FastifyInstance } from 'fastify';

import { createFeedEtag, createRssStream, type RssStore } from './rss.js';

export interface HttpServerOptions {
  loggerLevel: string;
  publicBaseUrl: string;
  rssStore: RssStore;
  readiness: () => boolean | Promise<boolean>;
}

interface FeedRouteParameters {
  token: string;
}

const rssTokenPattern = /^[A-Za-z0-9_-]{43}$/;

export function createHttpServer(options: HttpServerOptions): FastifyInstance {
  const server = Fastify({
    disableRequestLogging: true,
    logger: {
      level: options.loggerLevel,
      redact: ['req.url', 'request.url'],
    },
  });

  server.get('/healthz', async () => ({ status: 'ok' }));

  server.get('/readyz', async (_request, reply) => {
    if (!(await options.readiness())) {
      return reply.code(503).send({ status: 'not-ready' });
    }
    return { status: 'ready' };
  });

  server.get<{ Params: FeedRouteParameters }>('/feeds/:token.xml', async (request, reply) => {
    const { token } = request.params;
    if (!rssTokenPattern.test(token)) {
      return reply.code(404).send({ error: 'Feed not found.' });
    }

    const feed = options.rssStore.findFeedByToken(token);
    if (!feed) {
      return reply.code(404).send({ error: 'Feed not found.' });
    }

    const snapshot = options.rssStore.getFeedSnapshot(feed.id);
    const etag = createFeedEtag(feed.id, snapshot);
    const lastModified = new Date(snapshot.lastChangedAt).toUTCString();

    reply.headers({
      'cache-control': 'private, no-cache',
      'content-type': 'application/rss+xml; charset=utf-8',
      etag,
      'last-modified': lastModified,
      'x-content-type-options': 'nosniff',
      'x-robots-tag': 'noindex, nofollow',
    });

    const modifiedSince = request.headers['if-modified-since'];
    const notModifiedByDate =
      modifiedSince !== undefined &&
      new Date(modifiedSince).valueOf() >= new Date(snapshot.lastChangedAt).valueOf();
    if (request.headers['if-none-match'] === etag || notModifiedByDate) {
      return reply.code(304).send();
    }

    const feedUrl = `${options.publicBaseUrl}/feeds/${token}.xml`;
    return reply.send(createRssStream(feedUrl, options.rssStore.iterateFeedItems(feed.id)));
  });

  return server;
}
