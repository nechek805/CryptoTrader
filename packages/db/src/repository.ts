import { z } from 'zod';
import type { PoolClient } from 'pg';
import {
  AuditEntrySchema,
  DatabaseOptionsSchema,
  ExperimentManifestSchema,
  IdSchema,
  InputReferencesSchema,
  MarketBarSchema,
  NewsDocumentSchema,
  PageRequestSchema,
  RawIngestSchema,
  ResearchRunSchema,
  RetentionRequestSchema,
  RetentionResultSchema,
  RevisionOptionsSchema,
  SequenceSchema,
  StoredRawEventSchema,
  StoredResearchRecordSchema,
  UtcTimestampSchema,
  storedRevisionSchema,
  utcNanoseconds,
} from '@crypto/contracts';
import type {
  AuditEntry,
  DerivedKind,
  InputReference,
  MarketBar,
  NewsDocument,
  Page,
  PageRequest,
  RetentionRequest,
  RevisionOptions,
  StoredRawEvent,
  StoredResearchRecord,
  StoredRevision,
  UtcTimestamp,
} from '@crypto/contracts';
import { canonicalHash, canonicalJson, deterministicId } from '@crypto/core';
import { decodeCursor, encodeCursor } from './cursor.js';
import { PersistenceError } from './errors.js';

type Row = Record<string, unknown>;
type WriteResult<T> = { created: boolean; record: T };
const ns = (timestamp: UtcTimestamp) => utcNanoseconds(timestamp).toString();
const same = (left: unknown, right: unknown) => canonicalHash(left) === canonicalHash(right);
const sortedRefs = (refs: InputReference[]) =>
  [...refs].sort((a, b) => {
    const left = `${a.kind}:${a.id}`,
      right = `${b.kind}:${b.id}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });

export type ReadRepository = Pick<
  RepositorySession,
  | 'getRaw'
  | 'findRawDelivery'
  | 'listRaw'
  | 'getBarVersion'
  | 'getNewsVersion'
  | 'barHistory'
  | 'newsHistory'
  | 'barsAt'
  | 'newsAt'
  | 'getResearchRecord'
  | 'listResearchRecords'
  | 'listAudit'
  | 'verifyAuditChain'
>;

export class RepositorySession {
  #client: PoolClient;
  #schema: string;
  #namespace: string;
  #now: () => UtcTimestamp;
  #active: () => boolean;
  #writable: boolean;
  constructor(
    client: PoolClient,
    schema: string,
    now: () => UtcTimestamp,
    active: () => boolean,
    writable: boolean,
  ) {
    DatabaseOptionsSchema.shape.schema.parse(schema);
    this.#client = client;
    this.#schema = schema;
    this.#namespace = `"${schema}"`;
    this.#now = now;
    this.#active = active;
    this.#writable = writable;
  }
  async #query(text: string, values: unknown[] = []): Promise<Row[]> {
    if (!this.#active()) throw new PersistenceError('CLOSED');
    return (await this.#client.query<Row>(text, values)).rows;
  }
  #write(): void {
    if (!this.#active()) throw new PersistenceError('CLOSED');
    if (!this.#writable) throw new PersistenceError('READ_ONLY');
  }
  #time(): UtcTimestamp {
    return UtcTimestampSchema.parse(this.#now());
  }
  #scope(operation: string, filter: unknown) {
    return { schema: this.#schema, operation, filter };
  }
  #page<T>(
    rows: Row[],
    request: z.output<typeof PageRequestSchema>,
    scope: unknown,
    parse: (row: Row) => T,
    key: (row: Row) => string,
  ): Page<T> {
    const last = rows[request.limit - 1];
    return {
      items: rows.slice(0, request.limit).map(parse),
      nextCursor: rows.length > request.limit && last ? encodeCursor(scope, key(last)) : null,
    };
  }
  #raw(row: Row): StoredRawEvent {
    const result = StoredRawEventSchema.parse({
      schemaVersion: 'stored-raw-event.v1',
      id: row.id,
      sequence: row.sequence,
      contentHash: row.content_hash,
      storedAt: row.stored_at,
      envelope: row.envelope,
    });
    if (canonicalHash(result.envelope) !== result.contentHash)
      throw new PersistenceError('CORRUPT');
    return result;
  }
  #selectDerived(): string {
    return `d.*, ARRAY(SELECT raw_event_id FROM ${this.#namespace}.derived_sources WHERE derived_id=d.id ORDER BY raw_event_id COLLATE "C") AS sources`;
  }
  #revision<T>(row: Row, schema: z.ZodType<T>): StoredRevision<T> {
    const parsed = storedRevisionSchema(schema).parse({
      schemaVersion: 'stored-revision.v1',
      versionId: row.id,
      entityId: row.entity_id,
      kind: row.kind,
      revision: row.revision,
      previousVersionId: row.previous_id,
      sourceRawIds: row.sources,
      contentHash: row.content_hash,
      sequence: row.sequence,
      storedAt: row.stored_at,
      knownAt: row.known_at,
      record: row.payload,
    }) as StoredRevision<T>;
    if (canonicalHash(parsed.record) !== parsed.contentHash) throw new PersistenceError('CORRUPT');
    return parsed;
  }
  async #audit(
    action: AuditEntry['action'],
    entityType: AuditEntry['entityType'],
    entityId: string,
    contentHash: string,
  ): Promise<void> {
    const previous = await this.#query(
      `SELECT entry_hash FROM ${this.#namespace}.audit_entries ORDER BY sequence DESC LIMIT 1`,
    );
    const previousHash = previous[0] ? z.string().parse(previous[0].entry_hash) : null;
    const body = {
      schemaVersion: 'audit-entry.v1',
      action,
      entityType,
      entityId,
      occurredAt: this.#time(),
      contentHash,
      previousHash,
    };
    await this.#query(
      `INSERT INTO ${this.#namespace}.audit_entries
      (id,action,entity_type,entity_id,occurred_at,content_hash,previous_hash,entry_hash)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        deterministicId('audit', body),
        action,
        entityType,
        entityId,
        body.occurredAt,
        contentHash,
        previousHash,
        canonicalHash(body),
      ],
    );
  }

  async ingestRaw(input: unknown): Promise<WriteResult<StoredRawEvent>> {
    this.#write();
    const { envelope, sourceRawId } = RawIngestSchema.parse(input);
    if (Buffer.byteLength(canonicalJson(envelope), 'utf8') > 1048576)
      throw new PersistenceError('VALIDATION');
    const id = deterministicId('raw', { provider: envelope.provider, rawHash: envelope.rawHash });
    const signature = canonicalHash({
      kind: envelope.kind,
      occurredAt: envelope.occurredAt,
      payload: envelope.payload,
    });
    if (sourceRawId !== null) {
      const aliases = await this.#query(
        `SELECT raw_event_id FROM ${this.#namespace}.raw_delivery_keys WHERE provider=$1 AND raw_id=$2`,
        [envelope.provider, sourceRawId],
      );
      if (aliases[0] && aliases[0].raw_event_id !== id) throw new PersistenceError('CONFLICT');
    }
    const existing = await this.#query(`SELECT * FROM ${this.#namespace}.raw_events WHERE id=$1`, [
      id,
    ]);
    let created = false;
    if (existing[0]) {
      if (existing[0].signature !== signature) throw new PersistenceError('CONFLICT');
    } else {
      const storedAt = this.#time(),
        contentHash = canonicalHash(envelope);
      await this.#query(
        `INSERT INTO ${this.#namespace}.raw_events(id,provider,raw_hash,signature,content_hash,stored_at,stored_at_ns,envelope)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        [
          id,
          envelope.provider,
          envelope.rawHash,
          signature,
          contentHash,
          storedAt,
          ns(storedAt),
          canonicalJson(envelope),
        ],
      );
      await this.#audit('RAW_INGESTED', 'RAW_EVENT', id, contentHash);
      created = true;
    }
    if (sourceRawId !== null) {
      const added = await this.#query(
        `INSERT INTO ${this.#namespace}.raw_delivery_keys(provider,raw_id,raw_event_id)
        VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING raw_event_id`,
        [envelope.provider, sourceRawId, id],
      );
      if (added.length)
        await this.#audit(
          'RAW_ALIAS_LINKED',
          'RAW_EVENT',
          id,
          canonicalHash({ provider: envelope.provider, sourceRawId, id }),
        );
    }
    const record = await this.getRaw(id, true);
    if (!record) throw new PersistenceError('CORRUPT');
    return { created, record };
  }
  async getRaw(id: string, includeArchived = false): Promise<StoredRawEvent | null> {
    const rows = await this.#query(
      `SELECT r.* FROM ${this.#namespace}.raw_events r WHERE r.id=$1 AND
      ($2::boolean OR NOT EXISTS (SELECT 1 FROM ${this.#namespace}.retention_marks a WHERE a.kind='RAW_EVENT' AND a.entity_id=r.id))`,
      [IdSchema.parse(id), z.boolean().parse(includeArchived)],
    );
    return rows[0] ? this.#raw(rows[0]) : null;
  }
  async findRawDelivery(provider: string, sourceRawId: string): Promise<StoredRawEvent | null> {
    const rows = await this.#query(
      `SELECT raw_event_id FROM ${this.#namespace}.raw_delivery_keys WHERE provider=$1 AND raw_id=$2`,
      [IdSchema.parse(provider), IdSchema.parse(sourceRawId)],
    );
    return rows[0] ? this.getRaw(z.string().parse(rows[0].raw_event_id)) : null;
  }
  async listRaw(page: PageRequest = {}): Promise<Page<StoredRawEvent>> {
    const request = PageRequestSchema.parse(page),
      scope = this.#scope('raw', request.includeArchived);
    const after = decodeCursor(scope, request.cursor);
    const rows = await this.#query(
      `SELECT r.* FROM ${this.#namespace}.raw_events r WHERE sequence>$1::bigint AND
      ($2::boolean OR NOT EXISTS (SELECT 1 FROM ${this.#namespace}.retention_marks a WHERE a.kind='RAW_EVENT' AND a.entity_id=r.id))
      ORDER BY sequence LIMIT $3`,
      [
        after === null ? '0' : SequenceSchema.parse(after),
        request.includeArchived,
        request.limit + 1,
      ],
    );
    return this.#page(
      rows,
      request,
      scope,
      (row) => this.#raw(row),
      (row) => SequenceSchema.parse(row.sequence),
    );
  }

  appendMarketBar(
    input: unknown,
    options: RevisionOptions,
  ): Promise<WriteResult<StoredRevision<MarketBar>>> {
    return this.#appendRevision(
      'MARKET_BAR',
      MarketBarSchema.parse(input),
      MarketBarSchema,
      options,
    );
  }
  appendNewsDocument(
    input: unknown,
    options: RevisionOptions,
  ): Promise<WriteResult<StoredRevision<NewsDocument>>> {
    return this.#appendRevision(
      'NEWS_DOCUMENT',
      NewsDocumentSchema.parse(input),
      NewsDocumentSchema,
      options,
    );
  }
  async #appendRevision<T extends MarketBar | NewsDocument>(
    kind: DerivedKind,
    record: T,
    schema: z.ZodType<T>,
    options: RevisionOptions,
  ): Promise<WriteResult<StoredRevision<T>>> {
    this.#write();
    const config = RevisionOptionsSchema.parse(options),
      sources = [...config.sourceRawIds].sort();
    if (record.availableAt !== null && record.availableAt < config.knownAt)
      throw new PersistenceError('VALIDATION');
    for (const sourceId of sources) {
      const source = await this.getRaw(sourceId);
      if (!source) throw new PersistenceError('NOT_FOUND');
      if (
        source.envelope.observedAt > config.knownAt ||
        (source.envelope.availableAt !== null && source.envelope.availableAt > config.knownAt) ||
        (record.researchUse === 'ELIGIBLE' &&
          (source.envelope.researchUse !== 'ELIGIBLE' || source.envelope.availableAt === null))
      )
        throw new PersistenceError('VALIDATION');
    }
    const contentHash = canonicalHash(record);
    const history = await this.#query(
      `SELECT ${this.#selectDerived()} FROM ${this.#namespace}.derived_records d
      WHERE kind=$1 AND entity_id=$2 ORDER BY revision DESC`,
      [kind, record.id],
    );
    const duplicate = history.find((row) => row.content_hash === contentHash);
    if (duplicate) {
      if (!same(duplicate.sources, sources) || duplicate.known_at !== config.knownAt)
        throw new PersistenceError('CONFLICT');
      return { created: false, record: this.#revision(duplicate, schema) };
    }
    const latest = history[0] ? this.#revision(history[0], schema) : null;
    if (
      (latest?.versionId ?? null) !== config.previousVersionId ||
      (latest && latest.knownAt >= config.knownAt)
    )
      throw new PersistenceError('CONFLICT');
    if (latest && latest.record.provenance.origin !== record.provenance.origin)
      throw new PersistenceError('CONFLICT');
    if (kind === 'MARKET_BAR') {
      const bar = MarketBarSchema.parse(record);
      const natural = await this.#query(
        `SELECT entity_id FROM ${this.#namespace}.derived_records
        WHERE kind='MARKET_BAR' AND source_key=$1 AND instrument_id=$2 AND open_at_ns=$3 AND
        payload->>'marketType'=$4 AND payload->'interval'=$5::jsonb LIMIT 1`,
        [
          bar.exchange,
          bar.instrumentId,
          ns(bar.openAt),
          bar.marketType,
          canonicalJson(bar.interval),
        ],
      );
      if (natural[0] && natural[0].entity_id !== record.id) throw new PersistenceError('CONFLICT');
      if (latest) {
        const prior = MarketBarSchema.parse(latest.record);
        if (
          !same(
            [
              prior.exchange,
              prior.instrumentId,
              prior.marketType,
              prior.interval,
              prior.openAt,
              prior.closeAt,
            ],
            [bar.exchange, bar.instrumentId, bar.marketType, bar.interval, bar.openAt, bar.closeAt],
          )
        )
          throw new PersistenceError('CONFLICT');
      }
    } else if (
      latest &&
      NewsDocumentSchema.parse(latest.record).sourceId !== NewsDocumentSchema.parse(record).sourceId
    )
      throw new PersistenceError('CONFLICT');
    const revision = latest ? latest.revision + 1 : 1,
      id = deterministicId('revision', { kind, entityId: record.id, revision, contentHash });
    const storedAt = this.#time(),
      bar = kind === 'MARKET_BAR' ? MarketBarSchema.parse(record) : null;
    await this.#query(
      `INSERT INTO ${this.#namespace}.derived_records
      (id,kind,entity_id,revision,previous_id,content_hash,stored_at,stored_at_ns,available_at_ns,known_at,known_at_ns,research_use,source_key,instrument_id,open_at_ns,payload)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)`,
      [
        id,
        kind,
        record.id,
        revision,
        config.previousVersionId,
        contentHash,
        storedAt,
        ns(storedAt),
        record.availableAt === null ? null : ns(record.availableAt),
        config.knownAt,
        ns(config.knownAt),
        record.researchUse,
        bar?.exchange ?? NewsDocumentSchema.parse(record).sourceId,
        bar?.instrumentId ?? null,
        bar ? ns(bar.openAt) : null,
        canonicalJson(record),
      ],
    );
    for (const sourceId of sources)
      await this.#query(
        `INSERT INTO ${this.#namespace}.derived_sources(derived_id,raw_event_id) VALUES ($1,$2)`,
        [id, sourceId],
      );
    await this.#audit('REVISION_APPENDED', kind, id, contentHash);
    const rows = await this.#query(
      `SELECT ${this.#selectDerived()} FROM ${this.#namespace}.derived_records d WHERE id=$1`,
      [id],
    );
    if (!rows[0]) throw new PersistenceError('CORRUPT');
    return { created: true, record: this.#revision(rows[0], schema) };
  }
  async #getRevision<T>(
    id: string,
    kind: DerivedKind,
    schema: z.ZodType<T>,
    includeArchived: boolean,
  ): Promise<StoredRevision<T> | null> {
    const rows = await this.#query(
      `SELECT ${this.#selectDerived()} FROM ${this.#namespace}.derived_records d WHERE id=$1 AND kind=$2 AND
      ($3::boolean OR NOT EXISTS (SELECT 1 FROM ${this.#namespace}.retention_marks a WHERE a.kind=d.kind AND a.entity_id=d.id))`,
      [IdSchema.parse(id), kind, z.boolean().parse(includeArchived)],
    );
    return rows[0] ? this.#revision(rows[0], schema) : null;
  }
  getBarVersion(id: string, includeArchived = false) {
    return this.#getRevision(id, 'MARKET_BAR', MarketBarSchema, includeArchived);
  }
  getNewsVersion(id: string, includeArchived = false) {
    return this.#getRevision(id, 'NEWS_DOCUMENT', NewsDocumentSchema, includeArchived);
  }
  async #history<T>(
    entityId: string,
    kind: DerivedKind,
    schema: z.ZodType<T>,
    page: PageRequest,
  ): Promise<Page<StoredRevision<T>>> {
    const request = PageRequestSchema.parse(page),
      scope = this.#scope('history', { kind, entityId, includeArchived: request.includeArchived });
    const after = decodeCursor(scope, request.cursor);
    const rows = await this.#query(
      `SELECT ${this.#selectDerived()} FROM ${this.#namespace}.derived_records d WHERE kind=$1 AND entity_id=$2 AND sequence>$3::bigint AND
      ($4::boolean OR NOT EXISTS (SELECT 1 FROM ${this.#namespace}.retention_marks a WHERE a.kind=d.kind AND a.entity_id=d.id))
      ORDER BY sequence LIMIT $5`,
      [
        kind,
        IdSchema.parse(entityId),
        after === null ? '0' : SequenceSchema.parse(after),
        request.includeArchived,
        request.limit + 1,
      ],
    );
    return this.#page(
      rows,
      request,
      scope,
      (row) => this.#revision(row, schema),
      (row) => SequenceSchema.parse(row.sequence),
    );
  }
  barHistory(entityId: string, page: PageRequest = {}) {
    return this.#history(entityId, 'MARKET_BAR', MarketBarSchema, page);
  }
  newsHistory(entityId: string, page: PageRequest = {}) {
    return this.#history(entityId, 'NEWS_DOCUMENT', NewsDocumentSchema, page);
  }
  async #at<T>(
    decisionAt: UtcTimestamp,
    kind: DerivedKind,
    schema: z.ZodType<T>,
    page: PageRequest,
  ): Promise<Page<StoredRevision<T>>> {
    const decision = UtcTimestampSchema.parse(decisionAt),
      request = PageRequestSchema.parse(page);
    const scope = this.#scope('at', { kind, decision, includeArchived: request.includeArchived }),
      after = decodeCursor(scope, request.cursor);
    // Latest knowable revision first; an ineligible correction must not revive older data.
    const rows = await this.#query(
      `WITH latest AS (
      SELECT DISTINCT ON(entity_id) * FROM ${this.#namespace}.derived_records
      WHERE kind=$1 AND known_at_ns<=$2::numeric ORDER BY entity_id,revision DESC
    ) SELECT ${this.#selectDerived()} FROM latest d WHERE research_use='ELIGIBLE' AND available_at_ns<=$2::numeric
      AND ($3::text IS NULL OR entity_id COLLATE "C">$3 COLLATE "C") AND
      ($4::boolean OR NOT EXISTS (SELECT 1 FROM ${this.#namespace}.retention_marks a WHERE a.kind=d.kind AND a.entity_id=d.id))
      ORDER BY entity_id COLLATE "C" LIMIT $5`,
      [kind, ns(decision), after, request.includeArchived, request.limit + 1],
    );
    return this.#page(
      rows,
      request,
      scope,
      (row) => this.#revision(row, schema),
      (row) => IdSchema.parse(row.entity_id),
    );
  }
  barsAt(decisionAt: UtcTimestamp, page: PageRequest = {}) {
    return this.#at(decisionAt, 'MARKET_BAR', MarketBarSchema, page);
  }
  newsAt(decisionAt: UtcTimestamp, page: PageRequest = {}) {
    return this.#at(decisionAt, 'NEWS_DOCUMENT', NewsDocumentSchema, page);
  }

  async #validateInputs(input: unknown): Promise<InputReference[]> {
    const refs = sortedRefs(InputReferencesSchema.parse(input));
    for (const ref of refs) {
      const record =
        ref.kind === 'RAW_EVENT'
          ? await this.getRaw(ref.id)
          : ref.kind === 'MARKET_BAR'
            ? await this.getBarVersion(ref.id)
            : await this.getNewsVersion(ref.id);
      if (!record) throw new PersistenceError('NOT_FOUND');
      if (record.contentHash !== ref.contentHash) throw new PersistenceError('CONFLICT');
    }
    return refs;
  }
  recordRun(input: unknown, inputs: InputReference[]) {
    return this.#recordResearch('RUN', ResearchRunSchema.parse(input), inputs);
  }
  recordExperiment(input: unknown, inputs: InputReference[]) {
    return this.#recordResearch('EXPERIMENT', ExperimentManifestSchema.parse(input), inputs);
  }
  async #recordResearch(
    kind: 'RUN' | 'EXPERIMENT',
    record: z.infer<typeof ResearchRunSchema> | z.infer<typeof ExperimentManifestSchema>,
    inputs: InputReference[],
  ): Promise<WriteResult<StoredResearchRecord>> {
    this.#write();
    const refs = await this.#validateInputs(inputs);
    const hashes =
      record.schemaVersion === 'research-run.v1'
        ? record.reproducibility.datasetHashes
        : record.inputSnapshotHashes;
    if (!same([...new Set(hashes)].sort(), [...new Set(refs.map((ref) => ref.contentHash))].sort()))
      throw new PersistenceError('VALIDATION');
    if (record.schemaVersion === 'research-run.v1' && record.experimentId !== null) {
      const experiment = await this.getResearchRecord(record.experimentId);
      if (experiment?.record.schemaVersion !== 'experiment-manifest.v1')
        throw new PersistenceError('NOT_FOUND');
    }
    if (record.schemaVersion === 'experiment-manifest.v1')
      for (const ref of refs) {
        const captured =
          ref.kind === 'RAW_EVENT'
            ? (await this.getRaw(ref.id))?.envelope.observedAt
            : ref.kind === 'MARKET_BAR'
              ? (await this.getBarVersion(ref.id))?.knownAt
              : (await this.getNewsVersion(ref.id))?.knownAt;
        if (captured === undefined || captured > record.frozenAt)
          throw new PersistenceError('VALIDATION');
      }
    const contentHash = canonicalHash({ record, inputs: refs });
    const old = await this.getResearchRecord(record.id);
    if (old) {
      if (old.contentHash !== contentHash) throw new PersistenceError('CONFLICT');
      return { created: false, record: old };
    }
    const storedAt = this.#time();
    await this.#query(
      `INSERT INTO ${this.#namespace}.research_records(id,kind,content_hash,stored_at,payload,experiment_id)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
      [
        record.id,
        kind,
        contentHash,
        storedAt,
        canonicalJson(record),
        record.schemaVersion === 'research-run.v1' ? record.experimentId : null,
      ],
    );
    for (const ref of refs)
      await this.#query(
        `INSERT INTO ${this.#namespace}.research_inputs(record_id,input_id,kind,content_hash,raw_id,derived_id)
      VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          record.id,
          ref.id,
          ref.kind,
          ref.contentHash,
          ref.kind === 'RAW_EVENT' ? ref.id : null,
          ref.kind === 'RAW_EVENT' ? null : ref.id,
        ],
      );
    await this.#audit(
      kind === 'RUN' ? 'RUN_RECORDED' : 'EXPERIMENT_RECORDED',
      kind,
      record.id,
      contentHash,
    );
    const stored = await this.getResearchRecord(record.id);
    if (!stored) throw new PersistenceError('CORRUPT');
    return { created: true, record: stored };
  }
  async #research(row: Row): Promise<StoredResearchRecord> {
    const inputs = await this.#query(
      `SELECT kind,input_id AS id,content_hash AS "contentHash" FROM ${this.#namespace}.research_inputs
      WHERE record_id=$1 ORDER BY kind COLLATE "C",input_id COLLATE "C"`,
      [row.id],
    );
    const result = StoredResearchRecordSchema.parse({
      schemaVersion: 'stored-research-record.v1',
      id: row.id,
      sequence: row.sequence,
      contentHash: row.content_hash,
      storedAt: row.stored_at,
      record: row.payload,
      inputs,
    });
    if (
      canonicalHash({ record: result.record, inputs: sortedRefs(result.inputs) }) !==
      result.contentHash
    )
      throw new PersistenceError('CORRUPT');
    return result;
  }
  async getResearchRecord(id: string): Promise<StoredResearchRecord | null> {
    const rows = await this.#query(
      `SELECT * FROM ${this.#namespace}.research_records WHERE id=$1`,
      [IdSchema.parse(id)],
    );
    return rows[0] ? this.#research(rows[0]) : null;
  }
  async listResearchRecords(
    kind: 'RUN' | 'EXPERIMENT',
    page: PageRequest = {},
  ): Promise<Page<StoredResearchRecord>> {
    const parsedKind = z.enum(['RUN', 'EXPERIMENT']).parse(kind),
      request = PageRequestSchema.parse(page);
    const scope = this.#scope('research', parsedKind),
      after = decodeCursor(scope, request.cursor);
    const rows = await this.#query(
      `SELECT * FROM ${this.#namespace}.research_records WHERE kind=$1 AND sequence>$2::bigint ORDER BY sequence LIMIT $3`,
      [parsedKind, after === null ? '0' : SequenceSchema.parse(after), request.limit + 1],
    );
    const selected = rows.slice(0, request.limit),
      last = selected.at(-1);
    return {
      items: await Promise.all(selected.map((row) => this.#research(row))),
      nextCursor:
        rows.length > request.limit && last
          ? encodeCursor(scope, SequenceSchema.parse(last.sequence))
          : null,
    };
  }
  async listAudit(page: PageRequest = {}): Promise<Page<AuditEntry>> {
    const request = PageRequestSchema.parse(page),
      scope = this.#scope('audit', null),
      after = decodeCursor(scope, request.cursor);
    const rows = await this.#query(
      `SELECT id,sequence,action,entity_type AS "entityType",entity_id AS "entityId",occurred_at AS "occurredAt",
      content_hash AS "contentHash",previous_hash AS "previousHash",entry_hash AS "entryHash" FROM ${this.#namespace}.audit_entries
      WHERE sequence>$1::bigint ORDER BY sequence LIMIT $2`,
      [after === null ? '0' : SequenceSchema.parse(after), request.limit + 1],
    );
    return this.#page(
      rows,
      request,
      scope,
      (row) => AuditEntrySchema.parse({ ...row, schemaVersion: 'audit-entry.v1' }),
      (row) => SequenceSchema.parse(row.sequence),
    );
  }
  async verifyAuditChain(): Promise<{ valid: true; count: number; headHash: string | null }> {
    let cursor: string | undefined,
      previous: string | null = null,
      count = 0;
    do {
      const page = await this.listAudit(cursor ? { limit: 500, cursor } : { limit: 500 });
      for (const entry of page.items) {
        const { id, entryHash } = entry;
        const body = {
          schemaVersion: entry.schemaVersion,
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId,
          occurredAt: entry.occurredAt,
          contentHash: entry.contentHash,
          previousHash: entry.previousHash,
        };
        if (
          body.previousHash !== previous ||
          canonicalHash(body) !== entryHash ||
          deterministicId('audit', body) !== id
        )
          throw new PersistenceError('CORRUPT');
        previous = entryHash;
        count++;
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return { valid: true, count, headHash: previous };
  }
  async archiveBefore(input: RetentionRequest) {
    this.#write();
    const request = RetentionRequestSchema.parse(input),
      raw = request.kind === 'RAW_EVENT',
      table = raw ? 'raw_events' : 'derived_records';
    const rows = await this.#query(
      `SELECT r.id,r.content_hash FROM ${this.#namespace}.${table} r WHERE stored_at_ns<$1::numeric AND
      ${raw ? 'TRUE' : 'r.kind=$2'} AND NOT EXISTS (SELECT 1 FROM ${this.#namespace}.retention_marks a WHERE a.kind=$2 AND a.entity_id=r.id)
      ORDER BY stored_at_ns,r.id COLLATE "C" LIMIT $3`,
      [ns(request.before), request.kind, request.limit],
    );
    const ids = rows.map((row) => IdSchema.parse(row.id));
    if (!request.dryRun)
      for (const row of rows) {
        await this.#query(
          `INSERT INTO ${this.#namespace}.retention_marks(kind,entity_id,archived_at) VALUES ($1,$2,$3)`,
          [request.kind, row.id, this.#time()],
        );
        await this.#audit(
          'RETENTION_ARCHIVED',
          request.kind,
          IdSchema.parse(row.id),
          z.string().parse(row.content_hash),
        );
      }
    return RetentionResultSchema.parse({
      schemaVersion: 'retention-result.v1',
      dryRun: request.dryRun,
      ids,
    });
  }
}

export const StoredMarketBarSchema = storedRevisionSchema(MarketBarSchema);
export const StoredNewsDocumentSchema = storedRevisionSchema(NewsDocumentSchema);
