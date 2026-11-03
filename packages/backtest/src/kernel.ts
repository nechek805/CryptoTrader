import {
  ReplayArtifactSchema,
  ReplayStateSchema,
  ReplayStrategyDescriptorSchema,
  ReplayStepSchema,
  SignalCandidateSchema,
  utcNanoseconds,
} from '@crypto/contracts';
import type { ReplayArtifact, ReplayState, MarketBar, NewsDocument } from '@crypto/contracts';
import {
  canonicalHash,
  canonicalJson,
  deepFreeze,
  deterministicId,
  SyntheticClock,
  SeededRandom,
  fromEpoch,
} from '@crypto/core';
import { createReplayContext, ReplayAccessError } from './context.js';
import { scheduleReplayEvents, replayEventMeta } from './scheduler.js';
import { createNoTradeControl } from './strategy.js';
import type { StrategyFactory } from './strategy.js';

const noCostsHash = canonicalHash({
    schemaVersion: 'replay-execution-assumptions.v1',
    execution: 'DISABLED',
    costModel: 'UNMODELED',
    fills: 'NONE',
  }),
  zeroHash = canonicalHash({ schemaVersion: 'replay-log-genesis.v1' }),
  seconds = { seconds: 1, minutes: 60, hours: 3600, days: 86400 };
function stateValue(input: unknown): ReplayState {
  canonicalJson(input);
  const s = ReplayStateSchema.parse(input);
  deepFreeze(s);
  return s;
}
export function executeReplay(
  input: unknown,
  requestInput: unknown,
  codeVersion: string,
  factory: StrategyFactory = createNoTradeControl,
): ReplayArtifact {
  const scheduled = scheduleReplayEvents(input, requestInput),
    { request } = scheduled;
  if (scheduled.events.length * Math.ceil(scheduled.events.length / request.snapshotEvery) > 250000)
    throw new Error('Replay snapshot work budget');
  const strategy = factory(),
    descriptor = ReplayStrategyDescriptorSchema.parse(strategy.descriptor),
    configHash = canonicalHash(request),
    strategyHash = canonicalHash(descriptor),
    identity = { inputHash: scheduled.inputHash, configHash, strategyHash, codeVersion },
    runId = deterministicId('replay-run', identity),
    rng = new SeededRandom(request.randomSeed),
    clock = new SyntheticClock(
      scheduled.events[0]?.availableAt && scheduled.events[0].availableAt < request.startAt
        ? scheduled.events[0].availableAt
        : request.startAt,
    ),
    bars: MarketBar[] = [],
    news: NewsDocument[] = [],
    log: ReplayArtifact['log'] = [],
    snapshots: ReplayArtifact['snapshots'] = [],
    candidates: ReplayArtifact['candidates'] = [];
  deepFreeze(descriptor);
  let state = stateValue(strategy.initialState()),
    randomDraws = 0,
    head = zeroHash,
    decisionCount = 0,
    totalTraceRecords = 0;
  const snapshot = (sequence: number) => {
    snapshots.push({
      sequence,
      clock: clock.now(),
      state,
      stateHash: canonicalHash(state),
      visibleBarIds: bars.map((b) => b.id),
      visibleNewsIds: news.map((n) => n.id),
      candidatesHash: canonicalHash(candidates),
      randomDraws,
      logHead: head,
    });
  };
  snapshot(0);
  for (const [index, event] of scheduled.events.entries()) {
    clock.advanceTo(event.availableAt);
    if (event.kind === 'MARKET_BAR') bars.push(event.record);
    else news.push(event.record);
    const sequence = index + 1,
      phase: ReplayArtifact['log'][number]['phase'] =
        event.availableAt < request.startAt ? 'WARMUP' : 'DECISION',
      candidateIds: string[] = [],
      access = createReplayContext(bars, news, clock.now(), sequence, request, () => {
        randomDraws++;
        return rng.next();
      });
    if (phase === 'DECISION') {
      decisionCount++;
      let output: ReturnType<typeof ReplayStepSchema.parse>;
      try {
        const raw = strategy.onEvent(event, access.context, state);
        canonicalJson(raw);
        output = ReplayStepSchema.parse(raw);
        access.assertSafe();
      } finally {
        access.close();
      }
      state = stateValue(output.state);
      for (const [intentIndex, intent] of output.candidates.entries()) {
        if (!request.symbols.includes(intent.symbol))
          throw new Error('Replay candidate outside declared symbols');
        if (intent.rationaleIds.some((id) => id !== event.recordId && !access.known.has(id)))
          throw new ReplayAccessError('REPLAY_RATIONALE_NOT_VISIBLE');
        const decisionAt = clock.now(),
          body = {
            ...intent,
            schemaVersion: 'signal-candidate.v1',
            strategyId: descriptor.id,
            version: descriptor.version,
            portfolio: descriptor.portfolio,
            decisionAt,
            dataCutoff: decisionAt,
            validUntil: fromEpoch(
              utcNanoseconds(decisionAt) +
                BigInt(intent.horizon.value) * BigInt(seconds[intent.horizon.unit]) * 1000000000n,
              'nanoseconds',
            ),
            reproducibility: {
              datasetHashes: [scheduled.inputHash],
              configHash,
              codeVersion,
              modelVersion: `${descriptor.id}:${descriptor.version}`,
              randomSeed: request.randomSeed,
              randomAlgorithm: 'mulberry32.v1',
              clockSemantics: 'utc-nanoseconds.v1',
              generatedAt: request.generatedAt,
              feeAssumptionsHash: noCostsHash,
            },
          },
          candidate = SignalCandidateSchema.parse({
            ...body,
            id: deterministicId('replay-candidate', { runId, sequence, intentIndex, intent }),
          });
        candidates.push(candidate);
        candidateIds.push(candidate.id);
        if (candidates.length > 10000) throw new Error('Replay candidate work budget');
      }
    } else access.close();
    totalTraceRecords += access.traces.reduce((n, t) => n + t.recordIds.length, 0);
    if (totalTraceRecords > 250000) throw new Error('Replay trace work budget');
    const body = {
        sequence,
        phase,
        event: replayEventMeta(event),
        queries: access.traces,
        candidateIds,
        stateHash: canonicalHash(state),
        randomDraws,
        previousHash: head,
      },
      entry = { ...body, hash: canonicalHash(body) };
    head = entry.hash;
    log.push(entry);
    if (sequence % request.snapshotEvery === 0) snapshot(sequence);
  }
  if (snapshots.at(-1)!.sequence !== scheduled.events.length) snapshot(scheduled.events.length);
  const artifact = ReplayArtifactSchema.parse({
    schemaVersion: 'replay-artifact.v1',
    input: scheduled.input,
    request,
    strategy: descriptor,
    manifest: {
      schemaVersion: 'replay-manifest.v1',
      runId,
      execution: 'DISABLED',
      kernelVersion: 'replay-kernel.v1',
      clockSemantics: 'utc-nanoseconds.v1',
      ordering: 'AVAILABLE_AT_KIND_RECORD_ID_V1_PREFIX_VISIBILITY',
      ...identity,
      randomSeed: request.randomSeed,
      randomAlgorithm: 'mulberry32.v1',
      feeAssumptionsHash: noCostsHash,
      executionAssumptions: 'NO_EXECUTION_NO_COST_MODEL',
      generatedAt: request.generatedAt,
      eventOrderHash: canonicalHash(scheduled.events.map(replayEventMeta)),
      logHash: canonicalHash(log),
      candidatesHash: canonicalHash(candidates),
      finalStateHash: canonicalHash(state),
      snapshotsHash: canonicalHash(snapshots),
      eventCount: log.length,
      decisionCount,
      candidateCount: candidates.length,
      exclusions: scheduled.exclusions,
    },
    log,
    snapshots,
    candidates,
    finalState: state,
  });
  deepFreeze(artifact);
  return artifact;
}
export function validateReplayArtifact(
  input: unknown,
  factory: StrategyFactory = createNoTradeControl,
) {
  const a = ReplayArtifactSchema.parse(input),
    expected = executeReplay(a.input, a.request, a.manifest.codeVersion, factory);
  if (canonicalHash(a) !== canonicalHash(expected))
    throw new Error('Replay artifact integrity mismatch');
  deepFreeze(a);
  return a;
}
