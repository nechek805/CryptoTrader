import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import {
  ForwardRun as LiveRunSchema,
  NewsPosition as LivePositionSchema,
  ForwardQuery as LiveQuerySchema,
} from '../../contracts/src/news-forward.js';
import type {
  LiveRun,
  LivePosition,
  LiveSource,
  LiveQuery,
} from '../../contracts/src/news-forward.js';
import { canonicalHash } from '@crypto/core';
const ACTIVE = ['RUNNING', 'PAUSED', 'STOPPING'];
export interface LiveChange {
  state: LiveRun;
  positions: LivePosition[];
  sources: LiveSource[];
  event: unknown;
}
/** Separate namespace and migration registry: historical foundation migrations are unchanged. */
export class NewsForwardStore {
  readonly pool: Pool;
  private lease: PoolClient | null = null;
  private leaseAlive = false;
  constructor(
    url: string,
    readonly schema = 'crypto_news_forward_v1',
  ) {
    if (!/^(crypto_news_forward_v1|crypto_news_forward_test_[a-f0-9]{32})$/.test(schema))
      throw new Error('Invalid live database namespace');
    this.pool = new Pool({
      connectionString: url,
      max: 3,
      connectionTimeoutMillis: 5000,
      statement_timeout: 10000,
      idle_in_transaction_session_timeout: 15000,
    });
    this.pool.on('error', () => {
      this.leaseAlive = false;
    });
  }
  async migrate() {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        this.schema + ':migration',
      ]);
      const exists = await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [
        this.schema,
      ]);
      if (!exists.rowCount) await client.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
      await client.query(`CREATE TABLE IF NOT EXISTS ${this.schema}.version (version integer PRIMARY KEY CHECK(version=1)); INSERT INTO ${this.schema}.version VALUES(1) ON CONFLICT DO NOTHING;
        CREATE TABLE IF NOT EXISTS ${this.schema}.runs (id uuid PRIMARY KEY, status text NOT NULL, started_at bigint NOT NULL, state jsonb NOT NULL, state_hash text NOT NULL);
        CREATE UNIQUE INDEX IF NOT EXISTS one_active_run ON ${this.schema}.runs ((true)) WHERE status IN ('RUNNING','PAUSED','STOPPING');
        CREATE TABLE IF NOT EXISTS ${this.schema}.positions (id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES ${this.schema}.runs(id), data jsonb NOT NULL);
        CREATE INDEX IF NOT EXISTS live_positions_run ON ${this.schema}.positions(run_id);
        CREATE TABLE IF NOT EXISTS ${this.schema}.sources (id uuid PRIMARY KEY, received_at bigint NOT NULL, data jsonb NOT NULL);
        CREATE TABLE IF NOT EXISTS ${this.schema}.events (run_id uuid NOT NULL REFERENCES ${this.schema}.runs(id), revision integer NOT NULL, at bigint NOT NULL, previous_hash text NOT NULL, hash text NOT NULL, data jsonb NOT NULL, PRIMARY KEY(run_id,revision));
        CREATE OR REPLACE FUNCTION ${this.schema}.immutable_row() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Immutable live evidence'; END $$;
        CREATE OR REPLACE TRIGGER evidence_immutable BEFORE UPDATE OR DELETE ON ${this.schema}.sources FOR EACH ROW EXECUTE FUNCTION ${this.schema}.immutable_row();
        CREATE OR REPLACE TRIGGER events_immutable BEFORE UPDATE OR DELETE ON ${this.schema}.events FOR EACH ROW EXECUTE FUNCTION ${this.schema}.immutable_row();`);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  async acquireWorker() {
    if (this.lease) return this.leaseAlive;
    const client = await this.pool.connect();
    const result = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
      [this.schema + ':worker'],
    );
    if (!result.rows[0]?.locked) {
      client.release();
      return false;
    }
    client.on('error', () => {
      this.leaseAlive = false;
    });
    this.lease = client;
    this.leaseAlive = true;
    return true;
  }
  async assertLease() {
    if (!this.lease || !this.leaseAlive) throw new Error('Live worker database lease unavailable');
    await this.lease.query('SELECT 1');
  }
  async read(id?: string) {
    const result = await this.pool.query<{ state: unknown; state_hash: string }>(
      `SELECT state,state_hash FROM ${this.schema}.runs ${id ? 'WHERE id=$1' : ''} ORDER BY started_at DESC LIMIT 1`,
      id ? [id] : [],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (canonicalHash(row.state) !== row.state_hash)
      throw new Error('Persisted live state integrity failure');
    return LiveRunSchema.parse(row.state);
  }
  async listRuns() {
    return (
      await this.pool.query<{ id: string; startedAt: number; status: string }>(
        `SELECT id,started_at::float8 AS "startedAt",status FROM ${this.schema}.runs ORDER BY started_at DESC LIMIT 100`,
      )
    ).rows;
  }
  async change(
    fn: (current: LiveRun | null) => Promise<LiveChange | null> | LiveChange | null,
    requireWorkerLease = false,
  ) {
    if (requireWorkerLease) await this.assertLease();
    const client = requireWorkerLease ? this.lease! : await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [this.schema + ':state']);
      const row = (
        await client.query<{ state: unknown; state_hash: string }>(
          `SELECT state,state_hash FROM ${this.schema}.runs ORDER BY started_at DESC LIMIT 1 FOR UPDATE`,
        )
      ).rows[0];
      if (row && canonicalHash(row.state) !== row.state_hash)
        throw new Error('Persisted state integrity failure');
      const previous = row ? LiveRunSchema.parse(row.state) : null,
        next = await fn(previous);
      if (!next) {
        await client.query('COMMIT');
        return previous;
      }
      const state = LiveRunSchema.parse(next.state),
        isNew = state.id !== previous?.id;
      if (isNew && previous && ACTIVE.includes(previous.status))
        throw new Error('A paper run is already active');
      state.revision = isNew ? 0 : previous.revision + 1;
      const prevHash = isNew ? '' : previous.lastEventHash;
      const payload = {
        at: state.heartbeatAt,
        event: next.event,
        stateHash: canonicalHash({ ...state, lastEventHash: '' }),
      };
      state.lastEventHash = canonicalHash({
        runId: state.id,
        revision: state.revision,
        previous: prevHash,
        payload,
      });
      await client.query(
        `INSERT INTO ${this.schema}.runs(id,status,started_at,state,state_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status,state=EXCLUDED.state,state_hash=EXCLUDED.state_hash`,
        [state.id, state.status, state.startedAt, state, canonicalHash(state)],
      );
      for (const p of next.positions) {
        const position = LivePositionSchema.parse(p);
        if (position.runId !== state.id) throw new Error('Position run mismatch');
        await client.query(
          `INSERT INTO ${this.schema}.positions(id,run_id,data) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data WHERE positions.data->>'lifecycle'<>'CLOSED'`,
          [p.id, state.id, position],
        );
      }
      for (const s of next.sources)
        await client.query(
          `INSERT INTO ${this.schema}.sources(id,received_at,data) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
          [s.id, s.receivedAt, s],
        );
      await client.query(
        `INSERT INTO ${this.schema}.events(run_id,revision,at,previous_hash,hash,data) VALUES($1,$2,$3,$4,$5,$6)`,
        [state.id, state.revision, state.heartbeatAt, prevHash, state.lastEventHash, payload],
      );
      await client.query('COMMIT');
      return state;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      if (!requireWorkerLease) client.release();
    }
  }
  async positions(input: LiveQuery, exporting = false) {
    const q = LiveQuerySchema.parse(input),
      params: unknown[] = [],
      clauses: string[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      clauses.push(sql.replace('?', '$' + params.length));
    };
    if (q.runId) add('run_id=?', q.runId);
    for (const key of ['exchange', 'asset', 'side', 'status', 'lifecycle'] as const)
      if (q[key]) add(`data->>'${key}'=?`, q[key]);
    if (q.from !== undefined) add(`(data->>'${q.dateField}')::bigint>=?`, q.from);
    if (q.to !== undefined) add(`(data->>'${q.dateField}')::bigint<=?`, q.to);
    if (q.minPnl !== undefined) add("(data->>'netPnl')::numeric>=?", q.minPnl);
    if (q.maxPnl !== undefined) add("(data->>'netPnl')::numeric<=?", q.maxPnl);
    const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
    const numeric = ['openedAt', 'closedAt', 'netPnl', 'notional', 'fees'].includes(q.sort);
    const order = `(data->>'${q.sort}')${numeric ? '::numeric' : ''} ${q.direction} NULLS LAST,id ASC`;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const total = Number(
        (
          await client.query<{ count: string }>(
            `SELECT count(*) FROM ${this.schema}.positions${where}`,
            params,
          )
        ).rows[0]!.count,
      );
      if (exporting && total > 50000)
        throw new Error('Export exceeds 50000 positions; narrow filters');
      const result = await client.query<{ data: unknown }>(
        `SELECT data FROM ${this.schema}.positions${where} ORDER BY ${order} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, exporting ? 50000 : q.pageSize, exporting ? 0 : (q.page - 1) * q.pageSize],
      );
      const asOf = Number(
        (
          await client.query<{ at: string }>(
            'SELECT (extract(epoch from transaction_timestamp())*1000)::bigint AS at',
          )
        ).rows[0]!.at,
      );
      await client.query('COMMIT');
      return {
        asOf,
        total,
        page: exporting ? 1 : q.page,
        pageSize: exporting ? total : q.pageSize,
        positions: result.rows.map((r) => LivePositionSchema.parse(r.data)),
      };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  async evidence(runId: string, quoteId: string) {
    return (
      (
        await this.pool.query<{ data: unknown }>(
          `SELECT s.data FROM ${this.schema}.sources s WHERE id=$1 AND EXISTS(SELECT 1 FROM ${this.schema}.events e WHERE e.run_id=$2 AND e.data::text LIKE '%' || $1::text || '%')`,
          [quoteId, runId],
        )
      ).rows[0]?.data ?? null
    );
  }
  async eventPage(runId: string, after: number, ceiling: number) {
    return (
      await this.pool.query<{
        revision: number;
        previous_hash: string;
        hash: string;
        data: unknown;
      }>(
        `SELECT revision,previous_hash,hash,data FROM ${this.schema}.events WHERE run_id=$1 AND revision>$2 AND revision<=$3 ORDER BY revision LIMIT 250`,
        [runId, after, ceiling],
      )
    ).rows;
  }
  async readSources(ids: string[]) {
    if (ids.length > 30) throw new Error('Source batch too large');
    return (
      await this.pool.query<{ data: unknown }>(
        `SELECT data FROM ${this.schema}.sources WHERE id=ANY($1::uuid[])`,
        [ids],
      )
    ).rows.map((r) => r.data);
  }
  async close() {
    if (this.lease) {
      try {
        await this.lease.query('SELECT pg_advisory_unlock(hashtext($1))', [
          this.schema + ':worker',
        ]);
      } finally {
        this.lease.release();
        this.lease = null;
      }
    }
    await this.pool.end();
  }
}
