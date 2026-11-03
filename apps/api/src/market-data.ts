import Fastify from 'fastify';
import {
  CrossVenueQuerySchema,
  CrossVenueResultSchema,
  MarketDataQuerySchema,
  MarketHistoryQuerySchema,
  MarketHistoryResultSchema,
  MarketQualityQuerySchema,
  MarketQualityResultSchema,
  MarketQueryResultSchema,
  MarketResolveQuerySchema,
  MarketResolveResultSchema,
  UniverseRequestSchema,
  UniverseResultSchema,
} from '@crypto/contracts';
import type { MarketData } from '@crypto/contracts';

/** Separate, explicit read-only query service; existing operational health is unchanged. */
export function buildMarketQueryApp(data: MarketData) {
  const app = Fastify({ logger: false, requestIdHeader: false, bodyLimit: 16384 });
  app.addHook('onRequest', (request, reply, done) => {
    reply.header('cache-control', 'no-store').header('x-request-id', request.id);
    done();
  });
  const routes: [string, (input: unknown) => unknown][] = [
    [
      'query',
      (input) => MarketQueryResultSchema.parse(data.query(MarketDataQuerySchema.parse(input))),
    ],
    [
      'history',
      (input) =>
        MarketHistoryResultSchema.parse(data.history(MarketHistoryQuerySchema.parse(input))),
    ],
    [
      'resolve',
      (input) =>
        MarketResolveResultSchema.parse(data.resolve(MarketResolveQuerySchema.parse(input))),
    ],
    [
      'universe',
      (input) => UniverseResultSchema.parse(data.universe(UniverseRequestSchema.parse(input))),
    ],
    [
      'quality',
      (input) =>
        MarketQualityResultSchema.parse(data.quality(MarketQualityQuerySchema.parse(input))),
    ],
    [
      'compare',
      (input) => CrossVenueResultSchema.parse(data.compare(CrossVenueQuerySchema.parse(input))),
    ],
  ];
  for (const [name, execute] of routes)
    app.post(`/market/${name}`, (request, reply) => {
      try {
        return execute(request.body);
      } catch {
        return reply
          .code(400)
          .send({ schemaVersion: 'market-query-error.v1', error: 'INVALID_OR_INCOMPATIBLE_QUERY' });
      }
    });
  app.setErrorHandler((error, _request, reply) => {
    const status =
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      error.statusCode === 413
        ? 413
        : 400;
    void reply
      .code(status)
      .send({ schemaVersion: 'market-query-error.v1', error: 'INVALID_OR_INCOMPATIBLE_QUERY' });
  });
  return app;
}
