import { it, expect } from 'vitest';
import { paperRedisConnection } from '../apps/api/src/live-paper-queue.js';
import { PaperQueueCommandSchema } from '../apps/api/src/queue-command.js';
it('validates Redis configuration and separates producer versus worker retry policy', () => {
  expect(paperRedisConnection('redis://default:fixture@127.0.0.1:6379/2', true)).toMatchObject({
    db: 2,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  expect(paperRedisConnection('redis://localhost:6379/0')).toMatchObject({
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
  });
  for (const url of ['https://evil.test', 'redis://host/0?next=1', 'redis://host/wrong'])
    expect(() => paperRedisConnection(url)).toThrow();
});
it('only accepts bounded paper commands with explicit run and request identities', () => {
  expect(PaperQueueCommandSchema.safeParse({ action: 'REAL_ORDER' }).success).toBe(false);
  expect(
    PaperQueueCommandSchema.safeParse({
      id: 'not-uuid',
      action: 'START',
      expectedRunId: null,
      requestedAt: 0,
    }).success,
  ).toBe(false);
});
