import {
  NewsDeliverySchema,
  NewsPollActionSchema,
  NewsPollReportSchema,
  utcNanoseconds,
} from '@crypto/contracts';
import type {
  NewsCapture,
  NewsDelivery,
  NewsPollAction,
  NewsSource,
  UtcTimestamp,
} from '@crypto/contracts';
import type { Clock } from '@crypto/core';
import { canonicalHash, deterministicId, fromEpoch } from '@crypto/core';
import { NewsHttpError, NewsIngestError, parseLiveNewsCapture } from '@crypto/connectors';
import type { LiveNewsReader } from '@crypto/connectors';
import { NewsIngestStore, newsCaptureHash } from './store.js';
import { approvedTextHash, canonicalNewsUrl, newsDuplicateView } from './dedup.js';
import type { NewsPollJournal } from './poll-journal.js';

type Reserved = Extract<NewsPollAction, { kind: 'RESERVED' }>;
type Job = {
  nextAt: UtcTimestamp | null;
  pending: Reserved | null;
  retryCycle: string | null;
  nextAttempt: number;
  dead: boolean;
};
const ns = utcNanoseconds;
const plusMs = (at: UtcTimestamp, ms: number) =>
  fromEpoch(ns(at) + BigInt(ms) * 1000000n, 'nanoseconds');
const maxTime = (...values: UtcTimestamp[]) => values.sort().at(-1)!;

export class NewsPoller {
  readonly store: NewsIngestStore;
  readonly deliveries: NewsDelivery[] = [];
  #jobs = new Map<string, Job>();
  #reservations: Reserved[] = [];
  #settledAt = new Map<string, UtcTimestamp>();
  #lastAt: UtcTimestamp | null = null;
  constructor(
    readonly journal: NewsPollJournal,
    private readonly reader: LiveNewsReader,
    private readonly clock: Clock,
  ) {
    this.store = new NewsIngestStore(journal.config.registry);
    for (const record of journal.records) this.#apply(record.action);
  }
  #job(sourceId: string): Job {
    let job = this.#jobs.get(sourceId);
    if (!job) {
      job = { nextAt: null, pending: null, retryCycle: null, nextAttempt: 1, dead: false };
      this.#jobs.set(sourceId, job);
    }
    return job;
  }
  #apply(input: NewsPollAction) {
    const action = NewsPollActionSchema.parse(input);
    if (this.#lastAt && action.at < this.#lastAt) throw new Error('Regressed news journal clock');
    this.#lastAt = action.at;
    const source = this.store.registry.source(action.sourceId, action.at),
      job = this.#job(source.id);
    if (action.kind === 'RESERVED') {
      if (
        job.pending ||
        job.dead ||
        action.attempt !== job.nextAttempt ||
        (job.retryCycle !== null && action.cycleId !== job.retryCycle)
      )
        throw new Error('Invalid news reservation');
      job.pending = action;
      this.#reservations.push(action);
      return;
    }
    const reservation = job.pending;
    if (
      !reservation ||
      reservation.cycleId !== action.cycleId ||
      reservation.attempt !== action.attempt
    )
      throw new Error('News result without reservation');
    if (action.kind === 'SUCCEEDED') {
      if (
        action.capture.sourceId !== source.id ||
        action.requestStartedAt < reservation.at ||
        action.capture.observedAt < action.requestStartedAt ||
        action.capture.processedAt > action.at ||
        action.networkLatencyNs !==
          (ns(action.capture.observedAt) - ns(action.requestStartedAt)).toString() ||
        action.processingLatencyNs !==
          (ns(action.capture.processedAt) - ns(action.capture.observedAt)).toString() ||
        action.parsed.feedStatus !== 'PARSED' ||
        this.deliveries.length + action.parsed.items.length > 5000
      )
        throw new Error('Invalid news receipt times or size');
      this.store.ingestParsed(action.capture, action.parsed);
      const docs = this.store.state().documents,
        captureHash = newsCaptureHash(action.capture);
      for (const item of action.parsed.items) {
        const entityId = deterministicId('news-document', {
            sourceId: source.id,
            providerItemId: item.providerItemId,
          }),
          version = docs.filter((d) => d.entityId === entityId).at(-1)!;
        this.deliveries.push(
          NewsDeliverySchema.parse({
            schemaVersion: 'news-delivery.v1',
            id: deterministicId('news-delivery', {
              captureHash,
              providerItemId: item.providerItemId,
            }),
            captureHash,
            sourceId: source.id,
            providerItemId: item.providerItemId,
            entityId,
            versionId: version.versionId,
            originalUrl: item.canonicalUrl,
            canonicalUrl: canonicalNewsUrl(item.canonicalUrl),
            approvedTextHash: approvedTextHash(item),
            observedAt: action.capture.observedAt,
            availableAt: action.capture.processedAt,
            independenceGroup: source.independenceGroup,
            publicationLagNs:
              item.publishedAt === null
                ? null
                : (ns(action.capture.observedAt) - ns(item.publishedAt)).toString(),
          }),
        );
      }
      job.nextAt = maxTime(
        plusMs(action.at, source.polling.minIntervalSeconds * 1000),
        plusMs(
          reservation.at,
          Math.max(source.updateCadenceSeconds, source.polling.minIntervalSeconds) * 1000,
        ),
      );
      job.nextAttempt = 1;
      job.retryCycle = null;
    } else {
      if (
        action.deadLetter !== (action.retryAt === null) ||
        (action.retryAt !== null && action.retryAt <= action.at)
      )
        throw new Error('Invalid news retry');
      job.dead = action.deadLetter;
      job.nextAt = action.retryAt;
      job.nextAttempt = action.attempt + 1;
      job.retryCycle = action.cycleId;
    }
    this.#settledAt.set(`${action.cycleId}:${action.attempt}`, action.at);
    job.pending = null;
  }
  async #record(action: NewsPollAction) {
    await this.journal.append(action);
    this.#apply(action);
  }
  async #failed(
    reservation: Reserved,
    reason: Extract<NewsPollAction, { kind: 'FAILED' }>['reason'],
    retryable: boolean,
    status: number | null = null,
    retryAfterMs = 0,
  ) {
    const now = this.clock.now(),
      source = this.store.registry.source(reservation.sourceId, now);
    const deadLetter = !retryable || reservation.attempt >= this.journal.config.maxAttempts;
    const retryAt = deadLetter
      ? null
      : maxTime(
          plusMs(now, source.polling.minIntervalSeconds * 1000),
          plusMs(
            now,
            Math.min(
              this.journal.config.maxBackoffMs,
              this.journal.config.baseBackoffMs * 2 ** (reservation.attempt - 1),
            ),
          ),
          plusMs(now, retryAfterMs),
        );
    await this.#record({
      kind: 'FAILED',
      sourceId: source.id,
      cycleId: reservation.cycleId,
      attempt: reservation.attempt,
      at: now,
      reason,
      status,
      retryAt,
      deadLetter,
    });
  }
  async recoverInterrupted() {
    for (const job of this.#jobs.values())
      if (job.pending) await this.#failed(job.pending, 'INTERRUPTED', true);
  }
  dueAt(source: NewsSource, now: UtcTimestamp): UtcTimestamp | null {
    const job = this.#job(source.id);
    if (job.dead || job.pending) return null;
    let next = job.nextAt ?? now;
    if (this.#lastAt)
      next = maxTime(next, plusMs(this.#lastAt, this.journal.config.minGlobalIntervalMs));
    const recent = this.#reservations
      .filter((r) => r.sourceId === source.id)
      .map((r) => this.#settledAt.get(`${r.cycleId}:${r.attempt}`) ?? r.at)
      .filter((at) => ns(at) > ns(now) - 86400000000000n);
    if (recent.length >= source.polling.maxRequestsPerDay)
      next = maxTime(
        next,
        plusMs(recent[recent.length - source.polling.maxRequestsPerDay]!, 86400000),
      );
    return next;
  }
  async step(enabledSourceIds: string[], signal?: AbortSignal) {
    await this.recoverInterrupted();
    const now = this.clock.now();
    if (this.#lastAt && now < this.#lastAt) throw new Error('News polling clock regressed');
    for (const sourceId of enabledSourceIds) {
      const gate = this.journal.config.gates.find((g) => g.sourceId === sourceId);
      if (!gate || now < gate.reviewedAt || now >= gate.expiresAt)
        throw new NewsIngestError('POLICY');
      const source = this.store.registry.source(sourceId, now),
        due = this.dueAt(source, now);
      if (!due || due > now) continue;
      const job = this.#job(sourceId),
        reservation: Reserved = {
          kind: 'RESERVED',
          sourceId,
          cycleId: job.retryCycle ?? deterministicId('news-poll-cycle', { sourceId, due }),
          attempt: job.nextAttempt,
          at: now,
        };
      await this.#record(reservation); // Durable quota reservation precedes every network call.
      const requestStartedAt = this.clock.now();
      try {
        const received = await this.reader.read(source, signal),
          parsed = parseLiveNewsCapture(source, received);
        if (parsed.feedStatus !== 'PARSED') {
          await this.#failed(reservation, 'FORMAT', false);
          return true;
        }
        const capture: NewsCapture = { ...received, processedAt: this.clock.now() };
        const retained = source.licensing.permitsRawStorage
          ? capture
          : { ...capture, raw: '', rawRetention: 'HASH_ONLY' as const };
        const previous = this.store.state(),
          preview = new NewsIngestStore(previous.registry);
        for (let i = 0; i < previous.captures.length; i++)
          preview.ingestParsed(previous.captures[i], previous.parseResults[i]);
        preview.ingestParsed(retained, parsed);
        if (this.deliveries.length + parsed.items.length > 5000) throw new NewsIngestError('LIMIT');
        await this.#record({
          kind: 'SUCCEEDED',
          sourceId,
          cycleId: reservation.cycleId,
          attempt: reservation.attempt,
          at: this.clock.now(),
          capture: retained,
          parsed,
          requestStartedAt,
          networkLatencyNs: (ns(capture.observedAt) - ns(requestStartedAt)).toString(),
          processingLatencyNs: (ns(capture.processedAt) - ns(capture.observedAt)).toString(),
        });
      } catch (error) {
        // A durable success cannot be converted into a failure if local publication fails.
        if (this.journal.records.at(-1)?.action.kind !== 'RESERVED') throw error;
        if (error instanceof NewsHttpError)
          await this.#failed(
            reservation,
            error.status === 429 ? 'RATE_LIMIT' : 'HTTP',
            error.retryable,
            error.status,
            error.retryAfterMs ?? 0,
          );
        else if (error instanceof NewsIngestError)
          await this.#failed(
            reservation,
            error.code === 'NETWORK' ? 'NETWORK' : error.code === 'FORMAT' ? 'FORMAT' : 'POLICY',
            error.code === 'NETWORK',
          );
        else await this.#failed(reservation, 'NETWORK', true);
      }
      return true;
    }
    return false;
  }
  report() {
    const now = this.clock.now(),
      state = this.store.state();
    return NewsPollReportSchema.parse({
      schemaVersion: 'news-poll-report.v1',
      execution: 'DISABLED',
      configHash: this.journal.configHash,
      journalHead: this.journal.records.at(-1)?.hash ?? null,
      records: this.journal.records.length,
      captures: state.captures.length,
      versions: state.documents.length,
      deliveries: this.deliveries.length,
      rejectedItems: state.parseResults.reduce((n, p) => n + p.rejected.length, 0),
      uncertainTimestamps: state.parseResults.reduce(
        (n, p) => n + p.items.filter((i) => i.timestampStatus === 'UNCERTAIN').length,
        0,
      ),
      duplicateView: newsDuplicateView(this.deliveries, now),
      jobs: this.journal.config.gates.map((g) => ({
        sourceId: g.sourceId,
        nextAt: this.dueAt(this.store.registry.source(g.sourceId, now), now),
        deadLetter: this.#job(g.sourceId).dead,
      })),
      deadLetters: this.journal.records
        .filter((r) => r.action.kind === 'FAILED' && r.action.deadLetter)
        .map((r) => r.action),
      stateHash: canonicalHash(state),
    });
  }
}
