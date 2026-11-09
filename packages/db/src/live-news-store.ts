import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { randomUUID, createHash } from 'node:crypto';
import {
  LiveNewsSourceSchema,
  LiveNewsSourceInput,
  LiveNewsSourceView,
  LiveNewsSourceHealth,
  LiveNewsVersionSchema,
  LiveNewsAnalysisSchema,
  LiveNewsPage,
  LiveNewsQuery,
} from '../../contracts/src/live-news.js';
import type { LiveNewsSource, LiveNewsVersion } from '../../contracts/src/live-news.js';
import type { LiveFeedItem } from '../../connectors/src/live-news-feed.js';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const emptyHealth = {
  lastAttemptAt: null,
  lastSuccessAt: null,
  nextAllowedAt: 0,
  lastError: null,
  lastHttpStatus: null,
  consecutiveFailures: 0,
  lastItemCount: 0,
  totalArticles: 0,
  requestsToday: 0,
  state: 'WAITING',
};
type SourceRow = {
  config: unknown;
  health: unknown;
  lease_token: string | null;
  lease_until: string | null;
  request_day: string;
  request_count: number;
};
export class LiveNewsStore {
  readonly pool: Pool;
  readonly schema: string;
  constructor(url: string, schema = 'crypto_news_live_v1') {
    if (!/^(crypto_news_live_v1|crypto_news_test_[a-f0-9]{32})$/.test(schema))
      throw new Error('Invalid news namespace');
    this.schema = schema;
    this.pool = new Pool({
      connectionString: url,
      max: 4,
      connectionTimeoutMillis: 5000,
      statement_timeout: 15000,
      idle_in_transaction_session_timeout: 20000,
    });
    this.pool.on('error', () => {
      /* Connection errors are retried through queued work. */
    });
  }
  async transaction<T>(fn: (c: PoolClient) => Promise<T>) {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  async migrate() {
    const s = this.schema;
    await this.transaction(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [s + ':migration']);
      await c.query(`CREATE SCHEMA IF NOT EXISTS ${s};
    CREATE TABLE IF NOT EXISTS ${s}.version(version integer PRIMARY KEY CHECK(version=1)); INSERT INTO ${s}.version VALUES(1) ON CONFLICT DO NOTHING;
    CREATE TABLE IF NOT EXISTS ${s}.sources(id text PRIMARY KEY,config jsonb NOT NULL,health jsonb NOT NULL,lease_token uuid,lease_until bigint,request_day text NOT NULL DEFAULT '',request_count integer NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS ${s}.source_history(id uuid PRIMARY KEY,source_id text NOT NULL REFERENCES ${s}.sources,at bigint NOT NULL,actor text NOT NULL,config jsonb NOT NULL);
    CREATE TABLE IF NOT EXISTS ${s}.polls(id uuid PRIMARY KEY,source_id text NOT NULL REFERENCES ${s}.sources,at bigint NOT NULL,data jsonb NOT NULL);
    CREATE INDEX IF NOT EXISTS polls_source_at ON ${s}.polls(source_id,at DESC);
    CREATE TABLE IF NOT EXISTS ${s}.articles(id text PRIMARY KEY,source_id text NOT NULL REFERENCES ${s}.sources,url text NOT NULL,first_seen_at bigint NOT NULL,last_seen_at bigint NOT NULL,latest_version text,UNIQUE(source_id,url));
    CREATE TABLE IF NOT EXISTS ${s}.article_versions(id text PRIMARY KEY,article_id text NOT NULL REFERENCES ${s}.articles,revision integer NOT NULL,available_at bigint NOT NULL,duplicate_group text NOT NULL,data jsonb NOT NULL,UNIQUE(article_id,revision));
    CREATE INDEX IF NOT EXISTS versions_available ON ${s}.article_versions(available_at DESC);
    CREATE INDEX IF NOT EXISTS versions_duplicates ON ${s}.article_versions(duplicate_group);
    CREATE TABLE IF NOT EXISTS ${s}.ai_requests(id uuid PRIMARY KEY,version_id text NOT NULL REFERENCES ${s}.article_versions,profile_hash text NOT NULL,at bigint NOT NULL,input_hash text NOT NULL);
    CREATE INDEX IF NOT EXISTS ai_budget_at ON ${s}.ai_requests(at);
    CREATE INDEX IF NOT EXISTS ai_requests_version ON ${s}.ai_requests(version_id,profile_hash,at DESC);
    CREATE TABLE IF NOT EXISTS ${s}.ai_results(id uuid PRIMARY KEY REFERENCES ${s}.ai_requests,version_id text NOT NULL REFERENCES ${s}.article_versions,profile_hash text NOT NULL,at bigint NOT NULL,data jsonb NOT NULL);
    CREATE INDEX IF NOT EXISTS ai_results_version ON ${s}.ai_results(version_id,at DESC);
    CREATE TABLE IF NOT EXISTS ${s}.runtime(key text PRIMARY KEY,at bigint NOT NULL,data jsonb NOT NULL);
    CREATE OR REPLACE FUNCTION ${s}.immutable_news() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Immutable news evidence'; END $$;`);
      for (const table of [
        'source_history',
        'polls',
        'article_versions',
        'ai_requests',
        'ai_results',
      ])
        await c.query(
          `CREATE OR REPLACE TRIGGER immutable_evidence BEFORE UPDATE OR DELETE ON ${s}.${table} FOR EACH ROW EXECUTE FUNCTION ${s}.immutable_news()`,
        );
    });
  }
  async seed(sources: LiveNewsSource[]) {
    await this.transaction(async (c) => {
      for (const input of sources) {
        const source = LiveNewsSourceSchema.parse(input);
        const inserted = await c.query(
          `INSERT INTO ${this.schema}.sources(id,config,health) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id`,
          [source.id, source, emptyHealth],
        );
        if (inserted.rowCount)
          await c.query(`INSERT INTO ${this.schema}.source_history VALUES($1,$2,$3,$4,$5)`, [
            randomUUID(),
            source.id,
            source.createdAt,
            'INITIAL_CATALOG',
            source,
          ]);
      }
    });
  }
  async sources(now = Date.now()) {
    const rows = await this.pool.query<SourceRow & { articles: number }>(
      `SELECT s.*, (SELECT count(*)::integer FROM ${this.schema}.articles a WHERE a.source_id=s.id) AS articles FROM ${this.schema}.sources s ORDER BY config->>'name'`,
    );
    return rows.rows.map((row) => {
      const config = LiveNewsSourceSchema.parse(row.config),
        health = LiveNewsSourceHealth.parse(row.health);
      health.totalArticles = row.articles;
      health.nextAllowedAt = Math.max(
        health.nextAllowedAt,
        health.lastAttemptAt === null ? 0 : health.lastAttemptAt + 60000,
      );
      health.requestsToday =
        row.request_day === new Date(now).toISOString().slice(0, 10) ? row.request_count : 0;
      health.state =
        config.adapter === 'SETUP_REQUIRED' || !config.collectionApproved
          ? 'NEEDS_SETUP'
          : !config.enabled
            ? 'DISABLED'
            : health.lastError
              ? 'ERROR'
              : health.lastSuccessAt === null
                ? 'WAITING'
                : now - health.lastSuccessAt > Math.max(config.pollIntervalSeconds * 3000, 900000)
                  ? 'STALE'
                  : 'HEALTHY';
      return LiveNewsSourceView.parse({ config, health });
    });
  }
  async source(id: string) {
    const row = (
      await this.pool.query<{ config: unknown }>(
        `SELECT config FROM ${this.schema}.sources WHERE id=$1`,
        [id],
      )
    ).rows[0];
    return row ? LiveNewsSourceSchema.parse(row.config) : null;
  }
  async saveSource(
    id: string,
    input: unknown,
    expectedRevision: number | null,
    actor = 'OPERATOR',
    now = Date.now(),
  ) {
    const data = LiveNewsSourceInput.parse(input);
    return this.transaction(async (c) => {
      const row = (
        await c.query<{ config: unknown }>(
          `SELECT config FROM ${this.schema}.sources WHERE id=$1 FOR UPDATE`,
          [id],
        )
      ).rows[0];
      const previous = row ? LiveNewsSourceSchema.parse(row.config) : null;
      if ((previous?.revision ?? null) !== expectedRevision)
        throw new Error('SOURCE_CHANGED_RELOAD');
      const config = LiveNewsSourceSchema.parse({
        ...data,
        id,
        revision: (previous?.revision ?? 0) + 1,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      });
      await c.query(
        `INSERT INTO ${this.schema}.sources(id,config,health) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET config=EXCLUDED.config,lease_token=NULL,lease_until=NULL`,
        [id, config, emptyHealth],
      );
      await c.query(`INSERT INTO ${this.schema}.source_history VALUES($1,$2,$3,$4,$5)`, [
        randomUUID(),
        id,
        now,
        actor,
        config,
      ]);
      return config;
    });
  }
  async sourceHistory(id: string) {
    return (
      await this.pool.query<{ at: string; actor: string; config: unknown }>(
        `SELECT at,actor,config FROM ${this.schema}.source_history WHERE source_id=$1 ORDER BY at DESC LIMIT 100`,
        [id],
      )
    ).rows.map((r) => ({
      at: Number(r.at),
      actor: r.actor,
      config: LiveNewsSourceSchema.parse(r.config),
    }));
  }
  async claimPoll(id: string, revision: number, now = Date.now()) {
    return this.transaction(async (c) => {
      const row = (
        await c.query<SourceRow>(`SELECT * FROM ${this.schema}.sources WHERE id=$1 FOR UPDATE`, [
          id,
        ])
      ).rows[0];
      if (!row) return null;
      const source = LiveNewsSourceSchema.parse(row.config),
        health = LiveNewsSourceHealth.parse(row.health);
      if (
        !source.enabled ||
        !source.collectionApproved ||
        source.revision !== revision ||
        !source.feedUrl ||
        source.adapter === 'SETUP_REQUIRED'
      )
        return null;
      if (
        Number(row.lease_until ?? 0) > now ||
        health.nextAllowedAt > now ||
        (health.lastAttemptAt !== null && now - health.lastAttemptAt < 60000)
      )
        return null;
      const day = new Date(now).toISOString().slice(0, 10),
        count = row.request_day === day ? row.request_count : 0;
      if (count >= Math.ceil(86400 / source.pollIntervalSeconds) + 24) return null;
      const token = randomUUID();
      health.lastAttemptAt = now;
      health.requestsToday = count + 1;
      await c.query(
        `UPDATE ${this.schema}.sources SET health=$2,lease_token=$3,lease_until=$4,request_day=$5,request_count=$6 WHERE id=$1`,
        [id, health, token, now + 60000, day, count + 1],
      );
      return { source, token, startedAt: now, initial: health.lastSuccessAt === null };
    });
  }
  async completePoll(
    claim: NonNullable<Awaited<ReturnType<LiveNewsStore['claimPoll']>>>,
    receipt: { items: LiveFeedItem[]; feedHash: string; rejected: number; fetchedAt: number },
    now = Date.now(),
  ) {
    if (now < receipt.fetchedAt || receipt.fetchedAt < claim.startedAt)
      throw new Error('NEWS_RECEIPT_CLOCK');
    return this.transaction(async (c) => {
      const row = (
        await c.query<SourceRow>(`SELECT * FROM ${this.schema}.sources WHERE id=$1 FOR UPDATE`, [
          claim.source.id,
        ])
      ).rows[0];
      if (!row || row.lease_token !== claim.token) return [];
      const health = LiveNewsSourceHealth.parse(row.health),
        newIds: string[] = [];
      for (const item of receipt.items) {
        const articleId = hash(claim.source.id + '\n' + item.url);
        await c.query(
          `INSERT INTO ${this.schema}.articles(id,source_id,url,first_seen_at,last_seen_at) VALUES($1,$2,$3,$4,$4) ON CONFLICT(id) DO UPDATE SET last_seen_at=EXCLUDED.last_seen_at`,
          [articleId, claim.source.id, item.url, receipt.fetchedAt],
        );
        const previous = (
          await c.query<{ first_seen_at: string; data: unknown }>(
            `SELECT a.first_seen_at,v.data FROM ${this.schema}.articles a LEFT JOIN ${this.schema}.article_versions v ON v.id=a.latest_version WHERE a.id=$1`,
            [articleId],
          )
        ).rows[0]!;
        const old = previous.data ? LiveNewsVersionSchema.parse(previous.data) : null;
        const contentHash = hash(
          JSON.stringify({
            item,
            aiAllowed: claim.source.aiAllowed,
            permission: claim.source.permissionReference,
          }),
        );
        if (old?.contentHash === contentHash) continue;
        const revision = (old?.revision ?? 0) + 1,
          id = hash(articleId + '\n' + revision + '\n' + contentHash);
        const version = LiveNewsVersionSchema.parse({
          ...item,
          id,
          articleId,
          sourceId: claim.source.id,
          sourceRevision: claim.source.revision,
          revision,
          publisher: claim.source.name,
          independenceGroup: claim.source.independenceGroup,
          firstSeenAt: Number(previous.first_seen_at),
          fetchedAt: receipt.fetchedAt,
          availableAt: now,
          contentHash,
          feedHash: receipt.feedHash,
          duplicateGroup: hash(item.title.normalize('NFKC').replace(/\s+/g, ' ').toLowerCase()),
          captureKind: claim.initial ? 'INITIAL_SNAPSHOT' : 'LIVE_POLL',
          aiAllowed: claim.source.aiAllowed,
        });
        await c.query(`INSERT INTO ${this.schema}.article_versions VALUES($1,$2,$3,$4,$5,$6)`, [
          id,
          articleId,
          revision,
          now,
          version.duplicateGroup,
          version,
        ]);
        await c.query(`UPDATE ${this.schema}.articles SET latest_version=$2 WHERE id=$1`, [
          articleId,
          id,
        ]);
        newIds.push(id);
      }
      health.lastSuccessAt = now;
      health.lastError = null;
      health.lastHttpStatus = 200;
      health.consecutiveFailures = 0;
      health.lastItemCount = receipt.items.length;
      health.nextAllowedAt = 0;
      await c.query(
        `UPDATE ${this.schema}.sources SET health=$2,lease_token=NULL,lease_until=NULL WHERE id=$1`,
        [claim.source.id, health],
      );
      await c.query(`INSERT INTO ${this.schema}.polls VALUES($1,$2,$3,$4)`, [
        claim.token,
        claim.source.id,
        now,
        {
          status: 'SUCCESS',
          sourceRevision: claim.source.revision,
          requestedAt: claim.startedAt,
          fetchedAt: receipt.fetchedAt,
          availableAt: now,
          feedHash: receipt.feedHash,
          received: receipt.items.length,
          rejected: receipt.rejected,
          newVersions: newIds.length,
        },
      ]);
      return newIds;
    });
  }
  async failPoll(
    claim: NonNullable<Awaited<ReturnType<LiveNewsStore['claimPoll']>>>,
    error: string,
    status: number | null,
    retryAfterMs: number,
    now = Date.now(),
  ) {
    await this.transaction(async (c) => {
      const row = (
        await c.query<SourceRow>(`SELECT * FROM ${this.schema}.sources WHERE id=$1 FOR UPDATE`, [
          claim.source.id,
        ])
      ).rows[0];
      if (!row || row.lease_token !== claim.token) return;
      const health = LiveNewsSourceHealth.parse(row.health);
      health.consecutiveFailures++;
      health.lastError = error.slice(0, 160);
      health.lastHttpStatus = status;
      health.nextAllowedAt =
        now + Math.max(60000 * Math.min(16, 2 ** (health.consecutiveFailures - 1)), retryAfterMs);
      await c.query(
        `UPDATE ${this.schema}.sources SET health=$2,lease_token=NULL,lease_until=NULL WHERE id=$1`,
        [claim.source.id, health],
      );
      await c.query(`INSERT INTO ${this.schema}.polls VALUES($1,$2,$3,$4)`, [
        claim.token,
        claim.source.id,
        now,
        {
          status: 'FAILED',
          sourceRevision: claim.source.revision,
          requestedAt: claim.startedAt,
          error: health.lastError,
          httpStatus: status,
          retryAt: health.nextAllowedAt,
        },
      ]);
    });
  }
  async version(id: string) {
    const row = (
      await this.pool.query<{ data: unknown }>(
        `SELECT data FROM ${this.schema}.article_versions WHERE id=$1`,
        [id],
      )
    ).rows[0];
    return row ? LiveNewsVersionSchema.parse(row.data) : null;
  }
  async versions(articleId: string) {
    return (
      await this.pool.query<{ data: unknown }>(
        `SELECT data FROM ${this.schema}.article_versions WHERE article_id=$1 ORDER BY revision DESC LIMIT 100`,
        [articleId],
      )
    ).rows.map((r) => LiveNewsVersionSchema.parse(r.data));
  }
  async articles(input: unknown, exporting = false) {
    const q = LiveNewsQuery.parse(input),
      values: unknown[] = [],
      where: string[] = [];
    const param = (value: unknown) => {
      values.push(value);
      return '$' + values.length;
    };
    if (q.source) where.push(`a.source_id=${param(q.source)}`);
    if (q.search)
      where.push(
        `v.data->>'title' ILIKE ${param('%' + q.search.replace(/[\\%_]/g, '\\$&') + '%')}`,
      );
    if (q.asset) where.push(`r.data->'result'->'assets' ? ${param(q.asset)}`);
    if (q.from !== undefined) where.push(`v.available_at>=${param(q.from)}`);
    if (q.to !== undefined) where.push(`v.available_at<=${param(q.to)}`);
    const state = `CASE WHEN NOT (v.data->>'aiAllowed')::boolean THEN 'NOT_PERMITTED' ELSE coalesce(r.data->>'status','PENDING') END`;
    if (q.analysis) where.push(`${state}=${param(q.analysis)}`);
    const from = `FROM ${this.schema}.articles a JOIN ${this.schema}.article_versions v ON v.id=a.latest_version LEFT JOIN LATERAL (SELECT data FROM ${this.schema}.ai_results WHERE version_id=v.id ORDER BY at DESC LIMIT 1) r ON true ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
    const total = (
      await this.pool.query<{ count: number }>(`SELECT count(*)::integer AS count ${from}`, values)
    ).rows[0]!.count;
    const sort = q.sort === 'published' ? `(v.data->>'publishedAt')::bigint` : 'v.available_at',
      dir = q.direction === 'asc' ? 'ASC' : 'DESC';
    const rows = await this.pool.query<{
      version: unknown;
      analysis: unknown;
      analysisState: string;
      duplicateCount: number;
    }>(
      `SELECT v.data AS version,r.data AS analysis,${state} AS "analysisState",(SELECT count(DISTINCT d.article_id)::integer FROM ${this.schema}.article_versions d WHERE d.duplicate_group=v.duplicate_group) AS "duplicateCount" ${from} ORDER BY ${sort} ${dir} NULLS LAST,v.id ${dir} LIMIT ${exporting ? 5000 : q.pageSize} OFFSET ${exporting ? 0 : (q.page - 1) * q.pageSize}`,
      values,
    );
    return LiveNewsPage.parse({
      items: rows.rows,
      total,
      page: q.page,
      pageSize: exporting ? 5000 : q.pageSize,
    });
  }
  async runtime(key: string) {
    return (
      (
        await this.pool.query<{ at: string; data: unknown }>(
          `SELECT at,data FROM ${this.schema}.runtime WHERE key=$1`,
          [key],
        )
      ).rows[0] ?? null
    );
  }
  async heartbeat(key: string, data: unknown, now = Date.now()) {
    await this.pool.query(
      `INSERT INTO ${this.schema}.runtime VALUES($1,$2,$3) ON CONFLICT(key) DO UPDATE SET at=EXCLUDED.at,data=EXCLUDED.data`,
      [key, now, data],
    );
  }
  async aiBudget(now = Date.now()) {
    const start = Date.parse(new Date(now).toISOString().slice(0, 10) + 'T00:00:00Z');
    return (
      await this.pool.query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM ${this.schema}.ai_requests WHERE at >= $1`,
        [start],
      )
    ).rows[0]!.count;
  }
  async pendingAi(limit = 20, now = Date.now()) {
    return (
      await this.pool.query<{ id: string }>(
        `SELECT v.id FROM ${this.schema}.article_versions v JOIN ${this.schema}.articles a ON a.latest_version=v.id JOIN ${this.schema}.sources s ON s.id=a.source_id WHERE (s.config->>'aiAllowed')::boolean AND (v.data->>'aiAllowed')::boolean AND (v.data->>'publishedAt' IS NOT NULL OR v.data->>'captureKind'='LIVE_POLL') AND coalesce((v.data->>'publishedAt')::bigint,v.available_at)>=$1 AND NOT EXISTS(SELECT 1 FROM ${this.schema}.ai_results r WHERE r.version_id=v.id) ORDER BY coalesce((v.data->>'publishedAt')::bigint,v.available_at) DESC LIMIT $2`,
        [now - 7 * 86400000, limit],
      )
    ).rows.map((r) => r.id);
  }
  async reserveAi(
    versionId: string,
    profileHash: string,
    dailyLimit: number,
    inputHash: string,
    now = Date.now(),
  ): Promise<{ requestId: string; version: LiveNewsVersion } | { skip: string; until?: number }> {
    return this.transaction(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [this.schema + ':ai-budget']);
      const version = await this.version(versionId);
      if (version && version.availableAt > now) return { skip: 'VERSION_UNAVAILABLE' };
      if (!version || !version.aiAllowed || !(await this.source(version.sourceId))?.aiAllowed)
        return { skip: 'NOT_PERMITTED' };
      const rows = await c.query<{ data: unknown }>(
        `SELECT data FROM ${this.schema}.ai_results WHERE version_id=$1 AND profile_hash=$2 AND data->>'status'='ANALYZED' LIMIT 1`,
        [versionId, profileHash],
      );
      if (rows.rowCount) return { skip: 'ALREADY_ANALYZED' };
      const live = (
        await c.query<{ at: string }>(
          `SELECT q.at FROM ${this.schema}.ai_requests q WHERE q.version_id=$1 AND NOT EXISTS(SELECT 1 FROM ${this.schema}.ai_results r WHERE r.id=q.id) ORDER BY q.at DESC LIMIT 1`,
          [versionId],
        )
      ).rows[0];
      if (live && Number(live.at) + 120000 > now)
        return { skip: 'REQUEST_LEASE', until: Number(live.at) + 120000 };
      const start = Date.parse(new Date(now).toISOString().slice(0, 10) + 'T00:00:00Z');
      const count = (
        await c.query<{ count: number }>(
          `SELECT count(*)::integer AS count FROM ${this.schema}.ai_requests WHERE at >= $1`,
          [start],
        )
      ).rows[0]!.count;
      if (count >= dailyLimit) return { skip: 'DAILY_BUDGET', until: start + 86400000 + 1000 };
      const requestId = randomUUID();
      await c.query(`INSERT INTO ${this.schema}.ai_requests VALUES($1,$2,$3,$4,$5)`, [
        requestId,
        versionId,
        profileHash,
        now,
        inputHash,
      ]);
      return { requestId, version };
    });
  }
  async completeAi(versionId: string, profileHash: string, input: unknown) {
    const analysis = LiveNewsAnalysisSchema.parse(input);
    await this.pool.query(
      `INSERT INTO ${this.schema}.ai_results VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING`,
      [analysis.id, versionId, profileHash, analysis.availableAt, analysis],
    );
  }
  async recentPolls() {
    return (
      await this.pool.query<{ source_id: string; at: string; data: unknown }>(
        `SELECT source_id,at,data FROM ${this.schema}.polls ORDER BY at DESC LIMIT 50`,
      )
    ).rows.map((r) => ({ sourceId: r.source_id, at: Number(r.at), data: r.data }));
  }
  async close() {
    await this.pool.end();
  }
}
