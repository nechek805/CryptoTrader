import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  matchSourceEntities,
  evaluateEntityPrototype,
} from '../research_prototypes/source-entities/index.js';
import { entityPrototypeFixture } from '../research_prototypes/source-entities/fixture.js';

describe('Module 16 detached fixture prototype', () => {
  it('abstains on ambiguous/future/confusable mentions and retains known false positives', () => {
    const f = entityPrototypeFixture(),
      r = evaluateEntityPrototype(f.input, f.labels);
    expect(r.truePositive).toBe(4);
    expect(r.falsePositive).toBe(2);
    expect(r.falseNegative).toBe(0);
    expect(r.decision).toBe('DEFER');
    expect(r.realMoneyAuthorized).toBe(false);
    for (const id of ['future-alias', 'confusable', 'symbol-boundary', 'ambiguity'])
      expect(r.result.rows.find((v) => v.articleId === `synthetic:${id}`)!.symbols).toEqual([]);
    expect(r.result.rows.find((v) => v.articleId === 'synthetic:ambiguity')!.status).toBe(
      'AMBIGUOUS_ABSTENTION',
    );
  });
  it('does not access labels, public sources, future articles or arbitrary instructions', () => {
    const f = entityPrototypeFixture(),
      first = matchSourceEntities(f.input),
      changed = structuredClone(f.input);
    expect(() => matchSourceEntities({ ...f.input, origin: 'PUBLIC_READ_ONLY' })).toThrow();
    changed.articles[0]!.availableAt =
      '2026-01-02T00:00:00.000000000Z' as (typeof changed.articles)[0]['availableAt'];
    expect(matchSourceEntities(changed).rows[0]!.status).toBe('NOT_YET_AVAILABLE');
    expect(
      Object.keys(first.rows.find((r) => r.articleId === 'synthetic:injection')!),
    ).not.toContain('action');
    expect(first.execution).toBe('DISABLED');
    expect(() =>
      matchSourceEntities({
        ...f.input,
        articles: [{ ...f.input.articles[0], text: 'x'.repeat(2001) }],
      }),
    ).toThrow();
    expect(() => evaluateEntityPrototype(f.input, [])).toThrow();
  });
  it('reproduces the exact fixture output in two independent processes', async () => {
    const run = () =>
      promisify(execFile)(
        process.execPath,
        ['--import', 'tsx', 'research_prototypes/source-entities/run.ts'],
        { cwd: process.cwd(), maxBuffer: 1048576 },
      );
    const a = await run(),
      b = await run();
    expect(a.stderr).toBe('');
    expect(a.stdout).toBe(b.stdout);
  });
  it('has no imports into production apps or packages', async () => {
    async function visit(path: string): Promise<void> {
      for (const e of await readdir(path, { withFileTypes: true })) {
        if (['node_modules', '.next', 'dist'].includes(e.name)) continue;
        const target = join(path, e.name);
        if (e.isDirectory()) await visit(target);
        else if (/\.(ts|tsx|mjs)$/.test(e.name))
          expect(await readFile(target, 'utf8'), target).not.toMatch(/research_prototypes[\\/]/);
      }
    }
    await visit('apps');
    await visit('packages');
  });
});
