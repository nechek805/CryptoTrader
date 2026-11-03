import { describe, expect, it } from 'vitest';
import {
  DatabaseOptionsSchema,
  PageRequestSchema,
  RetentionRequestSchema,
  ResearchRunSchema,
} from '@crypto/contracts';
import { ResearchDatabase } from '@crypto/db';
import { createDomainFixtures } from './fixtures/domain.js';

describe('persistence boundary validation without a database', () => {
  it('rejects injected identifiers and unsupported connection protocols', () => {
    expect(
      DatabaseOptionsSchema.safeParse({
        connectionString: 'https://example.invalid',
        schema: 'crypto_research',
      }).success,
    ).toBe(false);
    for (const schema of [
      'crypto_research;DROP SCHEMA public',
      '"public"',
      'public.other',
      '',
      'x'.repeat(64),
    ]) {
      expect(
        DatabaseOptionsSchema.safeParse({
          connectionString: 'postgresql://research@127.0.0.1/postgres',
          schema,
        }).success,
      ).toBe(false);
    }
    expect(() => new ResearchDatabase({ connectionString: 'https://example.invalid' })).toThrow(
      'validation',
    );
  });
  it('bounds page/retention batches and makes retention preview the default', () => {
    expect(PageRequestSchema.parse({}).limit).toBe(100);
    expect(PageRequestSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(PageRequestSchema.safeParse({ limit: 501 }).success).toBe(false);
    expect(
      RetentionRequestSchema.parse({ kind: 'RAW_EVENT', before: '2026-01-01T00:00:00Z' }).dryRun,
    ).toBe(true);
    expect(
      RetentionRequestSchema.safeParse({ kind: 'AUDIT', before: '2026-01-01T00:00:00Z' }).success,
    ).toBe(false);
  });
  it('validates versioned run manifests and their completed/generated time order', () => {
    const input = {
      schemaVersion: 'research-run.v1',
      id: 'run:validation',
      purpose: 'FIXTURE_IMPORT',
      execution: 'SIMULATED',
      experimentId: null,
      startedAt: '2026-01-02T00:00:00Z',
      completedAt: '2026-01-02T00:00:01Z',
      status: 'SUCCEEDED',
      reproducibility: {
        ...createDomainFixtures().signalCandidate.reproducibility,
        generatedAt: '2026-01-02T00:00:01Z',
      },
    };
    const parsed = ResearchRunSchema.parse(input);
    expect(ResearchRunSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    expect(
      ResearchRunSchema.safeParse({ ...input, completedAt: '2026-01-01T00:00:00Z' }).success,
    ).toBe(false);
    expect(ResearchRunSchema.safeParse({ ...input, execution: 'LIVE' }).success).toBe(false);
  });
});
