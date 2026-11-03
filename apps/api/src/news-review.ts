import { timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import {
  NewsArticleResultSchema,
  NewsCorrectionRecordSchema,
  NewsCoverageReportSchema,
  NewsReviewQueueSchema,
} from '@crypto/contracts';
import type { NewsReviewApi } from '@crypto/contracts';

/** Explicit local service. A session token protects writes from browser-origin requests. */
export function buildNewsReviewApp(data: NewsReviewApi, writeToken: string) {
  if (!/^[a-f0-9]{64}$/.test(writeToken)) throw new Error('Invalid review session token');
  const app = Fastify({ logger: false, requestIdHeader: false, bodyLimit: 16384 });
  app.addHook('onRequest', (request, reply, done) => {
    reply.header('cache-control', 'no-store').header('x-request-id', request.id);
    done();
  });
  app.post('/news/review', (request) => NewsReviewQueueSchema.parse(data.queue(request.body)));
  app.post('/news/coverage', (request) =>
    NewsCoverageReportSchema.parse(data.coverage(request.body)),
  );
  app.post('/news/articles', (request) =>
    NewsArticleResultSchema.parse(data.articles(request.body)),
  );
  app.post('/news/corrections', async (request, reply) => {
    const authorization = request.headers.authorization ?? '',
      expected = `Bearer ${writeToken}`;
    if (
      request.headers.origin !== undefined ||
      Buffer.byteLength(authorization) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(authorization), Buffer.from(expected))
    )
      return reply.code(403).send({ schemaVersion: 'news-review-error.v1', error: 'FORBIDDEN' });
    return reply.code(201).send(NewsCorrectionRecordSchema.parse(await data.correct(request.body)));
  });
  app.setErrorHandler((error, _request, reply) => {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
    const status =
      code === 'CONFLICT'
        ? 409
        : typeof error === 'object' &&
            error !== null &&
            'statusCode' in error &&
            error.statusCode === 413
          ? 413
          : 400;
    void reply.code(status).send({
      schemaVersion: 'news-review-error.v1',
      error: status === 409 ? 'STALE_CORRECTION_HEAD' : 'INVALID_OR_INCOMPATIBLE_REQUEST',
    });
  });
  return app;
}
