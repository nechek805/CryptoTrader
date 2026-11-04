import { z } from 'zod';
import {
  ForwardExperimentManifestSchema,
  PaperEventSchema,
  TrialRunSchema,
  TrialAnnotationSchema,
  UtcTimestampSchema,
  utcNanoseconds,
} from '@crypto/contracts';
import type { ForwardExperimentManifest, PaperEvent, TrialAnnotation } from '@crypto/contracts';
import { canonicalHash, deepFreeze } from '@crypto/core';
import type { TrialRun } from '@crypto/contracts';
import { PaperBroker, verifyPaperReport } from '@crypto/paper';
import { validateNewsEventSnapshot } from '@crypto/news';
import { verifyExperimentManifest, experimentPaperConfig } from './experiment-protocol.js';

/** All entry paths, including queued producer requests, pass this boundary. */
export function guardExperimentEvent(
  input: unknown,
  eventInput: unknown,
  broker?: PaperBroker,
  newsInput?: unknown,
) {
  const m = ForwardExperimentManifestSchema.parse(input),
    e = PaperEventSchema.parse(eventInput),
    p = m.protocol;
  if (e.at < p.paper.startAt || e.at > p.paper.endAt)
    throw new Error('Event outside frozen calendar');
  if (p.origin === 'PUBLIC_READ_ONLY' && e.kind === 'HEARTBEAT' && e.observedAt === undefined)
    throw new Error('Forward heartbeat requires its original observation clock');
  if (e.kind !== 'PROPOSE') return e;
  const d = e.decision,
    c = d.request.risk.candidate,
    model = p.models.find((v) => v.portfolio === c.portfolio);
  if (
    !model ||
    c.strategyId !== model.strategyId ||
    c.reproducibility.modelVersion !== model.artifact.version ||
    c.reproducibility.codeVersion !== p.codeVersion ||
    d.request.runManifestHash !== m.hash ||
    d.configHash !== canonicalHash(p.riskPolicy) ||
    c.decisionAt > e.at ||
    utcNanoseconds(e.at) - utcNanoseconds(c.decisionAt) >
      BigInt(p.schedule.maxClockLagSeconds) * 1000000000n ||
    c.dataCutoff > e.at ||
    !p.evaluation.opportunityGrid.some((g) => g.at === c.decisionAt && g.symbol === c.symbol) ||
    (p.origin === 'PUBLIC_READ_ONLY' && d.request.evidence.some((v) => v.origin !== 'RESEARCH')) ||
    (c.portfolio === 'BASELINE' && c.side !== 'HOLD')
  )
    throw new Error('Unregistered, time-invalid or cross-origin trial candidate');
  if (
    p.origin === 'PUBLIC_READ_ONLY' &&
    c.side !== 'HOLD' &&
    (c.portfolio === 'NEWS_ONLY' || c.portfolio === 'FUSION')
  ) {
    const snapshot = validateNewsEventSnapshot(newsInput);
    if (
      canonicalHash(snapshot) !== d.request.sourceSnapshotHash ||
      snapshot.request.decisionAt > c.decisionAt ||
      !snapshot.view.events.some(
        (event) =>
          c.rationaleIds.includes(event.identity.id) &&
          event.replayEligible &&
          event.availableAt !== null &&
          event.availableAt <= c.decisionAt &&
          event.independence.independentAffirmativeOrigins >= p.newsPolicy.independentOrigins &&
          event.independence.groups
            .filter((g) => g.affirmative)
            .every((g) =>
              g.sourceIds.every((id) => p.providers.some((s) => s.kind === 'NEWS' && s.id === id)),
            ) &&
          ['CORROBORATED', 'OFFICIALLY_STATED'].includes(event.status),
      )
    )
      throw new Error('No temporally eligible independent news confirmation');
  }
  if (broker?.hasConflictingDecision(c)) throw new Error('Duplicate trial opportunity');
  return e;
}
const verifiedRuns = new WeakSet<object>();
export function verifyTrialRun(input: unknown): TrialRun {
  if (typeof input === 'object' && input !== null && verifiedRuns.has(input))
    return input as TrialRun;
  const r = TrialRunSchema.parse(input),
    m = verifyExperimentManifest(r.manifest),
    paper = verifyPaperReport(r.paper);
  if (canonicalHash(paper.config) !== canonicalHash(experimentPaperConfig(m)))
    throw new Error('Trial paper manifest mismatch');
  const b = new PaperBroker(paper.config);
  for (const l of paper.log) {
    const hash = l.event.kind === 'PROPOSE' ? l.event.decision.request.sourceSnapshotHash : null;
    const snapshot = hash ? r.newsSnapshots.find((s) => canonicalHash(s) === hash) : undefined;
    guardExperimentEvent(m, l.event, b, snapshot);
    b.consume(l.event);
  }
  const ids = new Set<string>();
  let last = m.protocol.paper.startAt;
  for (const a of r.annotations) {
    if (a.evidence !== null && canonicalHash(a.evidence) !== a.referenceHash)
      throw new Error('Trial annotation evidence integrity');
    if (
      ids.has(a.id) ||
      a.at < last ||
      a.at < paper.config.startAt ||
      a.at > paper.now ||
      (a.intervalStart !== null &&
        (a.intervalEnd === null || a.intervalStart > a.intervalEnd || a.intervalEnd > a.at))
    )
      throw new Error('Invalid trial annotation history');
    for (const id of a.affectedCandidateIds)
      if (!paper.decisions.some((d) => d.request.risk.candidate.id === id))
        throw new Error('Unbound trial annotation candidate');
    if (
      a.kind === 'CORROBORATION_DELAY' &&
      a.affectedCandidateIds.some(
        (id) =>
          !paper.decisions.some(
            (d) =>
              d.request.risk.candidate.id === id &&
              ['NEWS_ONLY', 'FUSION'].includes(d.request.risk.candidate.portfolio) &&
              (a.outcome !== 'HOLD' || d.request.risk.candidate.side === 'HOLD'),
          ),
      )
    )
      throw new Error('Corroboration delay outcome mismatch');
    ids.add(a.id);
    last = a.at;
  }
  if (
    r.wallClockStartedAt !== null &&
    r.wallClockFinishedAt !== null &&
    r.wallClockFinishedAt < r.wallClockStartedAt
  )
    throw new Error('Trial wall clock regression');
  if (
    m.protocol.origin === 'PUBLIC_READ_ONLY' &&
    (!r.wallClockStartedAt ||
      r.wallClockStartedAt < m.protocol.paper.startAt ||
      utcNanoseconds(r.wallClockStartedAt) - utcNanoseconds(m.protocol.paper.startAt) >
        BigInt(m.protocol.schedule.maxClockLagSeconds) * 1000000000n ||
      (r.wallClockFinishedAt !== null && r.wallClockFinishedAt < paper.now))
  )
    throw new Error('Forward study cannot contain future observations');
  const result = { ...r, paper, manifest: m };
  deepFreeze(result);
  verifiedRuns.add(result);
  return result;
}
export function trialAnnotationHead(annotations: TrialAnnotation[]) {
  let head = canonicalHash('trial-annotations-genesis.v1');
  for (const value of annotations)
    head = canonicalHash({ previousHash: head, value: TrialAnnotationSchema.parse(value) });
  return head;
}
export function guardForwardReceipt(
  event: PaperEvent,
  nowInput: unknown,
  m: ForwardExperimentManifest,
) {
  const now = UtcTimestampSchema.parse(nowInput);
  if (
    event.at > now ||
    utcNanoseconds(now) - utcNanoseconds(event.at) >
      BigInt(m.protocol.schedule.maxClockLagSeconds) * 1000000000n
  )
    throw new Error('Future or backdated forward receipt');
  if (
    event.kind === 'PROPOSE' &&
    event.decision.request.risk.candidate.reproducibility.generatedAt > now
  )
    throw new Error('Future producer timestamp');
}
export const TrialSourceBindingSchema = z.strictObject({
  sourceId: z.string(),
  adapterHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  adapterVersion: z.string(),
});

/** Processing can follow receipt; source/provider clocks never move forward with it. */
export function processTrialReceipt(
  input: unknown,
  nowInput: string,
  m: ForwardExperimentManifest,
) {
  const e = PaperEventSchema.parse(input),
    now = UtcTimestampSchema.parse(nowInput);
  guardForwardReceipt(e, now, m);
  return PaperEventSchema.parse({
    ...e,
    at: now,
    ...(e.kind === 'HEARTBEAT' ? { observedAt: e.observedAt ?? e.at } : {}),
    ...(e.kind === 'CONTROL' ? { requestedAt: e.requestedAt ?? e.at } : {}),
  });
}
