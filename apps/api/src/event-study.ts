import Fastify from 'fastify';
import { EventStudyRequestSchema, EventStudyResultSchema } from '@crypto/contracts';
import { EventControlsRequestSchema, EventControlsResultSchema } from '@crypto/contracts';
import type { EventStudy, EventControls } from '@crypto/contracts';

/** Inject a frozen local dataset at startup; callers cannot upload or mutate evidence. */
export function buildEventStudyApp(study: EventStudy) {
  return researchApp('/research/event-study', (input) =>
    EventStudyResultSchema.parse(study.run(EventStudyRequestSchema.parse(input))),
  );
}
export function buildEventControlsApp(controls: EventControls) {
  return researchApp('/research/event-controls', (input) =>
    EventControlsResultSchema.parse(controls.run(EventControlsRequestSchema.parse(input))),
  );
}
function researchApp(route: string, run: (input: unknown) => unknown) {
  const app = Fastify({ logger: false, requestIdHeader: false, bodyLimit: 16384 });
  app.addHook('onRequest', (request, reply, done) => {
    reply.header('cache-control', 'no-store').header('x-request-id', request.id);
    done();
  });
  app.post(route, (request, reply) => {
    try {
      return run(request.body);
    } catch {
      return reply.code(400).send({ error: 'INVALID_OR_INCOMPATIBLE_STUDY' });
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
    void reply.code(status).send({ error: 'INVALID_OR_INCOMPATIBLE_STUDY' });
  });
  return app;
}
