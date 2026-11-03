import { readFile } from 'node:fs/promises';
import type { PoolClient } from 'pg';
import { canonicalHash } from '@crypto/core';
import { PersistenceError } from './errors.js';

export const migrationVersion = '0001_foundation';
export async function applyMigration(
  client: PoolClient,
  schema: string,
  direction: 'up' | 'down',
): Promise<string[]> {
  const [up, down] = await Promise.all(
    ['up', 'down'].map(async (extension) =>
      (
        await readFile(
          new URL(`../migrations/${migrationVersion}.${extension}.sql`, import.meta.url),
          'utf8',
        )
      ).replaceAll('\r\n', '\n'),
    ),
  );
  if (up === undefined || down === undefined) throw new PersistenceError('MIGRATION');
  const checksum = canonicalHash({ up, down });
  const namespace = `"${schema}"`;
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${namespace}`);
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${namespace}._migrations (version text PRIMARY KEY, checksum text NOT NULL)`,
  );
  const existing = await client.query<{ version: string; checksum: string }>(
    `SELECT version, checksum FROM ${namespace}._migrations ORDER BY version`,
  );
  if (existing.rows.some((row) => row.version !== migrationVersion || row.checksum !== checksum))
    throw new PersistenceError('MIGRATION');
  if (direction === 'up' && existing.rowCount === 0) {
    await client.query(up.replaceAll('{{schema}}', namespace));
    await client.query(`INSERT INTO ${namespace}._migrations(version, checksum) VALUES ($1, $2)`, [
      migrationVersion,
      checksum,
    ]);
  } else if (direction === 'down' && existing.rowCount === 1) {
    await client.query(down.replaceAll('{{schema}}', namespace));
    await client.query(`DELETE FROM ${namespace}._migrations WHERE version = $1`, [
      migrationVersion,
    ]);
  }
  return direction === 'down' ? [] : [migrationVersion];
}
