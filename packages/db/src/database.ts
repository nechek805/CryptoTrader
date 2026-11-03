import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { DatabaseOptionsSchema, UtcTimestampSchema } from '@crypto/contracts';
import type { DatabaseOptions, UtcTimestamp } from '@crypto/contracts';
import { applyMigration } from './migrations.js';
import { PersistenceError, safeDatabaseError } from './errors.js';
import { RepositorySession } from './repository.js';
import type { ReadRepository } from './repository.js';

export class ResearchDatabase {
  readonly schema: string;
  #pool: Pool;
  #now: () => UtcTimestamp;
  #idleFailure = false;
  constructor(
    options: DatabaseOptions,
    now: () => UtcTimestamp = () => UtcTimestampSchema.parse(new Date().toISOString()),
  ) {
    try {
      const config = DatabaseOptionsSchema.parse(options);
      this.schema = config.schema;
      this.#pool = new Pool({
        connectionString: config.connectionString,
        max: 4,
        connectionTimeoutMillis: 3000,
        statement_timeout: 15000,
        idleTimeoutMillis: 10000,
        application_name: 'crypto-research',
      });
      // pg may emit idle-client errors. Subsequent operations surface a sanitized failure.
      this.#pool.on('error', () => {
        this.#idleFailure = true;
      });
      this.#now = now;
    } catch (error) {
      throw safeDatabaseError(error);
    }
  }

  async #session<T>(
    write: boolean,
    work: (client: PoolClient, repo: RepositorySession) => Promise<T>,
  ): Promise<T> {
    if (this.#idleFailure) {
      this.#idleFailure = false;
      throw new PersistenceError('STORAGE');
    }
    let client: PoolClient | undefined;
    let active = true;
    try {
      client = await this.#pool.connect();
      await client.query(write ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      if (write)
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `${this.schema}:writes`,
        ]);
      const repo = new RepositorySession(client, this.schema, this.#now, () => active, write);
      const result = await work(client, repo);
      active = false;
      await client.query('COMMIT');
      return result;
    } catch (error) {
      active = false;
      try {
        await client?.query('ROLLBACK');
      } catch {
        /* Preserve a sanitized primary failure. */
      }
      throw safeDatabaseError(error);
    } finally {
      active = false;
      client?.release();
    }
  }
  transaction<T>(work: (repo: RepositorySession) => Promise<T>): Promise<T> {
    return this.#session(true, (_client, repo) => work(repo));
  }
  read<T>(work: (repo: ReadRepository) => Promise<T>): Promise<T> {
    return this.#session(false, (_client, repo) => work(repo));
  }
  migrate(direction: 'up' | 'down' = 'up'): Promise<string[]> {
    if (direction !== 'up' && direction !== 'down')
      return Promise.reject(new PersistenceError('VALIDATION'));
    return this.#session(true, (client) => applyMigration(client, this.schema, direction));
  }
  /** Explicitly limited to the reserved local-fixture namespace. Never reset normal schemas. */
  resetFixtures(): Promise<string[]> {
    if (!/^crypto_fixture_[a-z0-9_]+$/.test(this.schema))
      return Promise.reject(new PersistenceError('VALIDATION'));
    return this.#session(true, async (client) => {
      await client.query(`DROP SCHEMA IF EXISTS "${this.schema}" CASCADE`);
      return applyMigration(client, this.schema, 'up');
    });
  }
  async close(): Promise<void> {
    await this.#pool.end();
  }
}
