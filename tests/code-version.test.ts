import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { workingTreeVersion } from '../apps/cli/src/database-fixtures.js';
it('does not change frozen code identity when Next generates build/cache output', async () => {
  const directory = join(process.cwd(), 'apps/web/.next'),
    path = join(directory, `ignored-code-hash-${randomUUID()}.json`),
    before = await workingTreeVersion();
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(path, JSON.stringify({ generatedAt: 'synthetic:build-only' }));
    expect(await workingTreeVersion()).toBe(before);
  } finally {
    await unlink(path);
  }
});
