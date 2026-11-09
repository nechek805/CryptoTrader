import { NewsV3Run, NewsV3Report } from '../../contracts/src/news-research-v3.js';
import type { V3Report } from '../../contracts/src/news-research-v3.js';
import { NewsV4Run, NewsV4Report, NewsV4Corpus } from '../../contracts/src/news-research-v4.js';
import type { V4Report, V4Corpus } from '../../contracts/src/news-research-v4.js';
import { NewsV5Run, NewsV5Report } from '../../contracts/src/news-research-v5.js';
import type { V5Report } from '../../contracts/src/news-research-v5.js';
import {
  NewsV6Run,
  NewsV6Report,
  newsV6ParentProjection,
} from '../../contracts/src/news-research-v6.js';
import type { V6Report } from '../../contracts/src/news-research-v6.js';
import { randomUUID } from 'node:crypto';
import { canonicalHash } from '@crypto/core';
import {
  NewsResearchRun,
  NewsResearchReport,
  NewsResearchSnapshot,
} from '../../contracts/src/news-research.js';
import type {
  ResearchPlan,
  ResearchReport,
  ResearchSnapshot,
} from '../../contracts/src/news-research.js';
import type { LiveNewsStore } from './live-news-store.js';

export class NewsResearchStore {
  constructor(
    readonly news: LiveNewsStore,
    readonly kind: 'legacy' | 'v3' | 'v4' | 'v5' | 'v6' = 'legacy',
  ) {}
  private get prefix() {
    return this.kind === 'legacy' ? 'research' : `research_${this.kind}`;
  }
  private parseRun(value: unknown) {
    return this.kind === 'v6'
      ? NewsV6Run.parse(value)
      : this.kind === 'v5'
        ? NewsV5Run.parse(value)
        : this.kind === 'v4'
          ? NewsV4Run.parse(value)
          : this.kind === 'v3'
            ? NewsV3Run.parse(value)
            : NewsResearchRun.parse(value);
  }
  private parseReport(value: unknown) {
    return this.kind === 'v6'
      ? NewsV6Report.parse(value)
      : this.kind === 'v5'
        ? NewsV5Report.parse(value)
        : this.kind === 'v4'
          ? NewsV4Report.parse(value)
          : this.kind === 'v3'
            ? NewsV3Report.parse(value)
            : NewsResearchReport.parse(value);
  }
  async capture() {
    const c = await this.news.pool.connect();
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const sources = await c.query<{ config: unknown }>(
        `SELECT config FROM ${this.news.schema}.sources ORDER BY id`,
      );
      const versions = await c.query<{
        data: unknown;
      }>(`SELECT v.data FROM ${this.news.schema}.articles a JOIN
        ${this.news.schema}.article_versions v ON v.id=a.latest_version ORDER BY v.id LIMIT 20001`);
      if (versions.rows.length > 20000) throw new Error('NEWS_RESEARCH_CORPUS_LIMIT');
      const snapshot = NewsResearchSnapshot.parse({
        capturedAt: Date.now(),
        total: versions.rows.length,
        sources: sources.rows.map((r) => r.config),
        versions: versions.rows.map((r) => r.data),
      });
      await c.query('COMMIT');
      return snapshot;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  async migrate() {
    const s = this.news.schema;
    await this.news.pool.query(`CREATE TABLE IF NOT EXISTS ${s}.${this.prefix}_runs(
      id uuid PRIMARY KEY, created_at bigint NOT NULL, updated_at bigint NOT NULL,
      window_end bigint NOT NULL,engine_hash text NOT NULL,state text NOT NULL,
      data jsonb NOT NULL,snapshot jsonb NOT NULL,UNIQUE(window_end,engine_hash));
      CREATE TABLE IF NOT EXISTS ${s}.${this.prefix}_reports(run_id uuid PRIMARY KEY REFERENCES ${s}.${this.prefix}_runs,
      hash text NOT NULL,data jsonb NOT NULL);
      CREATE TABLE IF NOT EXISTS ${s}.${this.prefix}_events(id uuid PRIMARY KEY,run_id uuid NOT NULL REFERENCES ${s}.${this.prefix}_runs,
      at bigint NOT NULL,data jsonb NOT NULL);
      CREATE OR REPLACE TRIGGER immutable_evidence BEFORE UPDATE OR DELETE ON ${s}.${this.prefix}_reports
        FOR EACH ROW EXECUTE FUNCTION ${s}.immutable_news();
      CREATE OR REPLACE TRIGGER immutable_evidence BEFORE UPDATE OR DELETE ON ${s}.${this.prefix}_events
        FOR EACH ROW EXECUTE FUNCTION ${s}.immutable_news();
      CREATE OR REPLACE FUNCTION ${s}.guard_${this.prefix}_request() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Immutable research request'; END IF;
        IF OLD.id IS DISTINCT FROM NEW.id OR OLD.snapshot IS DISTINCT FROM NEW.snapshot OR
           OLD.created_at IS DISTINCT FROM NEW.created_at OR OLD.window_end IS DISTINCT FROM NEW.window_end OR
           OLD.engine_hash IS DISTINCT FROM NEW.engine_hash OR OLD.data->'plan' IS DISTINCT FROM NEW.data->'plan' OR
           OLD.data->'baselineRunId' IS DISTINCT FROM NEW.data->'baselineRunId'
        THEN RAISE EXCEPTION 'Immutable research request'; END IF;
        RETURN NEW;
      END $$;
      CREATE OR REPLACE TRIGGER immutable_request BEFORE UPDATE OR DELETE ON ${s}.${this.prefix}_runs
        FOR EACH ROW EXECUTE FUNCTION ${s}.guard_${this.prefix}_request();`);
    if (this.kind === 'v4')
      await this.news.pool.query(
        `CREATE TABLE IF NOT EXISTS ${s}.research_v4_corpora(run_id uuid PRIMARY KEY REFERENCES ${s}.research_v4_runs,hash text NOT NULL,data jsonb NOT NULL); CREATE OR REPLACE TRIGGER immutable_evidence BEFORE UPDATE OR DELETE ON ${s}.research_v4_corpora FOR EACH ROW EXECUTE FUNCTION ${s}.immutable_news();`,
      );
  }
  async runs() {
    const result = await this.news.pool.query<{ data: unknown }>(
      `SELECT data FROM ${this.news.schema}.${this.prefix}_runs ORDER BY created_at DESC LIMIT 20`,
    );
    return result.rows.map((r) => this.parseRun(r.data));
  }
  async run(id: string) {
    const result = await this.news.pool.query<{ data: unknown }>(
      `SELECT data FROM ${this.news.schema}.${this.prefix}_runs WHERE id=$1`,
      [id],
    );
    return result.rows[0] ? this.parseRun(result.rows[0].data) : null;
  }
  async request(
    plan: ResearchPlan,
    engineHash: string,
    snapshot: ResearchSnapshot,
    baselineRunId?: string,
  ) {
    NewsResearchSnapshot.parse(snapshot);
    const c = await this.news.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(74219917)');
      const active = await c.query<{ data: unknown }>(
        `SELECT data FROM ${this.news.schema}.${this.prefix}_runs
        WHERE state IN ('QUEUED','RUNNING') OR (window_end=$1 AND engine_hash=$2) ORDER BY created_at DESC LIMIT 1`,
        [plan.to, engineHash],
      );
      if (active.rows[0]) {
        const existing = this.parseRun(active.rows[0].data);
        if (
          (this.kind === 'v5' || this.kind === 'v6') &&
          (!('baselineRunId' in existing) ||
            existing.baselineRunId !== baselineRunId ||
            canonicalHash(existing.plan) !== canonicalHash(plan))
        )
          throw new Error(`${this.kind.toUpperCase()}_FROZEN_PARENT_CONFLICT`);
        await c.query('COMMIT');
        return existing;
      }
      const recent = await c.query<{ n: number }>(
        `SELECT count(*)::integer AS n FROM ${this.news.schema}.${this.prefix}_runs WHERE created_at>=$1`,
        [Math.floor(Date.now() / 86400000) * 86400000],
      );
      if (recent.rows[0]!.n >= 3) throw new Error('RESEARCH_DAILY_LIMIT');
      const previous = await c.query(
        `SELECT 1 FROM ${this.news.schema}.${this.prefix}_runs WHERE window_end>$1 AND (data->'plan'->>'validationEnd')::bigint<$2 AND state='COMPLETE' LIMIT 1`,
        [plan.validationEnd, plan.to],
      );
      const now = Date.now(),
        run = this.parseRun({
          id: randomUUID(),
          createdAt: now,
          updatedAt: now,
          engineHash,
          plan: {
            ...plan,
            holdoutPreviouslyViewed: plan.holdoutPreviouslyViewed || previous.rowCount !== 0,
          },
          state: 'QUEUED',
          ...(this.kind !== 'legacy' ? { baselineRunId } : {}),
          stage: 'Frozen news snapshot queued',
          error: null,
          reportHash: null,
        });
      await c.query(
        `INSERT INTO ${this.news.schema}.${this.prefix}_runs VALUES($1,$2,$2,$3,$4,$5,$6,$7)`,
        [run.id, now, plan.to, engineHash, run.state, run, snapshot],
      );
      await c.query(`INSERT INTO ${this.news.schema}.${this.prefix}_events VALUES($1,$2,$3,$4)`, [
        randomUUID(),
        run.id,
        now,
        run,
      ]);
      await c.query('COMMIT');
      return run;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  async snapshot(id: string) {
    const rows = await this.news.pool.query<{ snapshot: unknown }>(
      `SELECT snapshot FROM ${this.news.schema}.${this.prefix}_runs WHERE id=$1`,
      [id],
    );
    if (!rows.rows[0]) throw new Error('RESEARCH_RUN_NOT_FOUND');
    return NewsResearchSnapshot.parse(rows.rows[0].snapshot);
  }
  async update(
    id: string,
    state: 'RUNNING' | 'FAILED',
    stage: string,
    error: string | null = null,
  ) {
    const c = await this.news.pool.connect();
    try {
      await c.query('BEGIN');
      const rows = await c.query<{ data: unknown }>(
        `SELECT data FROM ${this.news.schema}.${this.prefix}_runs WHERE id=$1 FOR UPDATE`,
        [id],
      );
      if (!rows.rows[0]) throw new Error('RESEARCH_RUN_NOT_FOUND');
      const prior = this.parseRun(rows.rows[0].data);
      if (prior.state === 'COMPLETE') {
        await c.query('COMMIT');
        return;
      }
      const run = this.parseRun({ ...prior, state, updatedAt: Date.now(), stage, error });
      await c.query(
        `UPDATE ${this.news.schema}.${this.prefix}_runs SET state=$2,updated_at=$3,data=$4 WHERE id=$1`,
        [id, state, run.updatedAt, run],
      );
      await c.query(`INSERT INTO ${this.news.schema}.${this.prefix}_events VALUES($1,$2,$3,$4)`, [
        randomUUID(),
        id,
        run.updatedAt,
        run,
      ]);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  async corpus(id: string) {
    if (this.kind !== 'v4') throw new Error('V4_CORPUS_ONLY');
    const result = await this.news.pool.query<{ hash: string; data: unknown }>(
      `SELECT hash,data FROM ${this.news.schema}.research_v4_corpora WHERE run_id=$1`,
      [id],
    );
    if (!result.rows[0]) return null;
    const corpus = NewsV4Corpus.parse(result.rows[0].data);
    if (canonicalHash(corpus) !== result.rows[0].hash) throw new Error('V4 corpus integrity');
    return corpus;
  }
  async saveCorpus(id: string, input: V4Corpus) {
    if (this.kind !== 'v4') throw new Error('V4_CORPUS_ONLY');
    const corpus = NewsV4Corpus.parse(input),
      run = await this.run(id);
    if (!run || corpus.from !== run.plan.from || corpus.to !== run.plan.to)
      throw new Error('V4 corpus window mismatch');
    await this.news.pool.query(
      `INSERT INTO ${this.news.schema}.research_v4_corpora VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
      [id, canonicalHash(corpus), corpus],
    );
    const saved = await this.corpus(id);
    if (canonicalHash(saved) !== canonicalHash(corpus)) throw new Error('V4 corpus already frozen');
    return saved!;
  }
  async complete(id: string, input: ResearchReport | V3Report | V4Report | V5Report | V6Report) {
    const report = this.parseReport(input),
      hash = canonicalHash(report),
      c = await this.news.pool.connect();
    try {
      await c.query('BEGIN');
      const rows = await c.query<{ data: unknown }>(
        `SELECT data FROM ${this.news.schema}.${this.prefix}_runs WHERE id=$1 FOR UPDATE`,
        [id],
      );
      if (!rows.rows[0]) throw new Error('RESEARCH_RUN_NOT_FOUND');
      const prior = this.parseRun(rows.rows[0].data);
      if (prior.state === 'COMPLETE') {
        await c.query('COMMIT');
        return prior.reportHash;
      }
      const snapshot = await this.snapshot(id);
      if (
        canonicalHash(prior.plan) !== report.planHash ||
        canonicalHash(snapshot) !==
          (report.version === 'news-history-comparison.v4'
            ? report.seedSnapshotHash
            : report.snapshotHash) ||
        prior.engineHash !== report.engineHash
      )
        throw new Error('Research frozen protocol does not match report');
      if (report.version === 'news-history-comparison.v6') {
        if (!('baselineRunId' in prior) || prior.baselineRunId !== report.referenceV5RunId)
          throw new Error('V6 parent mismatch');
        const parent = NewsV5Report.parse(
          await new NewsResearchStore(this.news, 'v5').report(report.referenceV5RunId),
        );
        const corpus = await new NewsResearchStore(this.news, 'v4').corpus(parent.referenceV4RunId);
        if (
          canonicalHash(parent) !== report.referenceV5ReportHash ||
          canonicalHash(newsV6ParentProjection(report, parent)) !== canonicalHash(parent) ||
          !corpus ||
          canonicalHash(corpus) !== report.corpusHash ||
          canonicalHash(corpus.snapshot) !== report.snapshotHash
        )
          throw new Error('V6 changed frozen parent evidence');
      }
      if (report.version === 'news-history-comparison.v5') {
        if (!('baselineRunId' in prior) || prior.baselineRunId !== report.referenceV4RunId)
          throw new Error('V5 parent mismatch');
        const parentStore = new NewsResearchStore(this.news, 'v4');
        const parent = NewsV4Report.parse(await parentStore.report(report.referenceV4RunId));
        const corpus = await parentStore.corpus(report.referenceV4RunId);
        if (
          canonicalHash(parent) !== report.referenceV4ReportHash ||
          !corpus ||
          canonicalHash(corpus) !== report.corpusHash ||
          canonicalHash(corpus.snapshot) !== report.snapshotHash ||
          canonicalHash(parent.plan) !== canonicalHash(report.plan) ||
          parent.snapshotHash !== report.snapshotHash ||
          parent.corpusHash !== report.corpusHash ||
          parent.seedSnapshotHash !== report.seedSnapshotHash ||
          canonicalHash(parent.markets) !== canonicalHash(report.markets) ||
          canonicalHash(parent.coverage) !== canonicalHash(report.coverage) ||
          canonicalHash(parent.events) !== canonicalHash(report.events) ||
          canonicalHash(parent.legacyEvents) !== canonicalHash(report.legacyEvents) ||
          parent.referenceV3ReportHash !== report.referenceV3ReportHash ||
          parent.referenceLegacyReportHash !== report.referenceLegacyReportHash
        )
          throw new Error('V5 changed frozen parent inputs');
        for (const row of report.rows) {
          const original = parent.rows.find((r) => r.asset === row.asset);
          if (
            !original ||
            canonicalHash(original) !==
              canonicalHash(
                (({ v2Attribution, models, ...rest }) => {
                  void v2Attribution;
                  return { ...rest, models: models.slice(0, 4) };
                })(row),
              )
          )
            throw new Error('V5 changed a prior model or account');
        }
      }
      if (report.version === 'news-history-comparison.v4') {
        if (!('baselineRunId' in prior) || prior.baselineRunId !== report.referenceV3RunId)
          throw new Error('V4 parent mismatch');
        const parent = await new NewsResearchStore(this.news, 'v3').report(report.referenceV3RunId),
          corpus = await this.corpus(id);
        if (
          !parent ||
          parent.version !== 'news-history-comparison.v3' ||
          canonicalHash(parent) !== report.referenceV3ReportHash ||
          parent.baselineReportHash !== report.referenceLegacyReportHash ||
          !corpus ||
          canonicalHash(corpus) !== report.corpusHash ||
          canonicalHash(corpus.snapshot) !== report.snapshotHash
        )
          throw new Error('V4 frozen corpus or parent mismatch');
      }
      if (report.version === 'news-history-comparison.v3') {
        if (!('baselineRunId' in prior) || prior.baselineRunId !== report.baselineRunId)
          throw new Error('V3 parent mismatch');
        const baseline = await new NewsResearchStore(this.news).report(report.baselineRunId);
        if (
          !baseline ||
          baseline.version !== 'news-history-report.v1' ||
          canonicalHash(baseline) !== report.baselineReportHash ||
          baseline.engineHash !== report.baselineEngineHash ||
          baseline.snapshotHash !== report.snapshotHash ||
          baseline.planHash !== report.planHash ||
          canonicalHash(baseline.coverage) !== canonicalHash(report.coverage) ||
          canonicalHash(baseline.events) !==
            canonicalHash(report.events.slice(0, baseline.events.length))
        )
          throw new Error('V3 frozen baseline mismatch');
        for (const row of report.rows) {
          const old = baseline.rows.find((r) => r.asset === row.asset);
          if (
            !old ||
            old.marketHash !== row.marketHash ||
            canonicalHash(old.models) !== canonicalHash(row.models.slice(0, 2))
          )
            throw new Error('V3 changed a legacy model or dataset');
        }
      }
      const run = this.parseRun({
        ...prior,
        state: 'COMPLETE',
        updatedAt: Date.now(),
        stage: 'Frozen report ready; inspect evidence and qualification gates',
        error: null,
        reportHash: hash,
      });
      await c.query(`INSERT INTO ${this.news.schema}.${this.prefix}_reports VALUES($1,$2,$3)`, [
        id,
        hash,
        report,
      ]);
      await c.query(
        `UPDATE ${this.news.schema}.${this.prefix}_runs SET state=$2,updated_at=$3,data=$4 WHERE id=$1`,
        [id, run.state, run.updatedAt, run],
      );
      await c.query(`INSERT INTO ${this.news.schema}.${this.prefix}_events VALUES($1,$2,$3,$4)`, [
        randomUUID(),
        id,
        run.updatedAt,
        run,
      ]);
      await c.query('COMMIT');
      return hash;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  async report(id: string) {
    const rows = await this.news.pool.query<{ hash: string; data: unknown }>(
      `SELECT hash,data FROM ${this.news.schema}.${this.prefix}_reports WHERE run_id=$1`,
      [id],
    );
    if (!rows.rows[0]) return null;
    const report = this.parseReport(rows.rows[0].data);
    if (canonicalHash(report) !== rows.rows[0].hash)
      throw new Error('Research report integrity mismatch');
    return report;
  }
}
