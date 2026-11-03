import {
  MarketRobustnessPlanSchema,
  MarketRobustnessReportSchema,
  RobustAttemptSchema,
  RobustEvidenceSchema,
  RobustJournalEntrySchema,
  SignalCandidateSchema,
  utcNanoseconds,
} from '@crypto/contracts';
import type {
  MarketRobustnessPlan,
  RobustTrial,
  RobustScenario,
  RobustEvidence,
  RobustAttempt,
  RobustJournalEntry,
  ReplayArtifact,
  BacktestOutcome,
  SignalCandidate,
  MarketRobustnessReport,
} from '@crypto/contracts';
import { canonicalHash, deterministicId, deepFreeze, fromEpoch } from '@crypto/core';
import {
  MarketSignalProvider,
  createMarketMlStrategy,
  validateMarketModel,
} from '@crypto/strategies';
import { marketSource } from './market-backtest.js';
import { executeReplay } from './kernel.js';
import { simulateSpot } from './spot-simulator.js';
import { compileMarketTargets } from './market-sizing-bridge.js';
import { measureBacktest } from './backtest-metrics.js';
import { SpotEvidence } from './spot-evidence.js';
import { D } from './spot-math.js';
import { rankRobustness, selectRobustness } from './robustness-statistics.js';
export function validateRobustnessPlan(input: unknown) {
  const p = MarketRobustnessPlanSchema.parse(input),
    models = new Map(p.models.map((m) => [m.id, validateMarketModel(m)])),
    trialIds = new Set<string>();
  for (const t of p.trials) {
    if (t.parentTrialId !== null && !trialIds.has(t.parentTrialId))
      throw new Error('Trial lineage must name an earlier immutable version');
    trialIds.add(t.id);
    if (
      (t.modelId !== null && !models.has(t.modelId)) ||
      t.provider?.kind === 'SYMMETRIC_MA_FIXTURE'
    )
      throw new Error('Unknown or non-executable producer');
    if (t.change === 'FEATURE_ABLATION') {
      const parent = p.trials.find((v) => v.id === t.parentTrialId),
        model = models.get(t.modelId!),
        base = models.get(parent?.modelId ?? '');
      if (
        !model ||
        !base ||
        model.featureSchema.length >= base.featureSchema.length ||
        model.featureSchema.some(
          (f) =>
            !base.featureSchema.some(
              (b) => b.name === f.name && b.definitionHash === f.definitionHash,
            ),
        ) ||
        model.sourcePanel.id !== base.sourcePanel.id ||
        model.config.horizonBars !== base.config.horizonBars
      )
        throw new Error(
          'Ablation must be a retrained strict feature subset on the same frozen panel/horizon',
        );
    }
  }
  if (
    p.models.some((m) => !p.trials.some((t) => t.modelId === m.id) || m.availableAt > p.declaredAt)
  )
    throw new Error('Unused or unavailable frozen model');
  const reference = p.scenarios[0]!.manifest.backtest;
  for (const s of p.scenarios) {
    const b = s.manifest.backtest,
      policy = b.assumptions.policy;
    if (
      s.asset !== b.series.asset ||
      s.regime !== s.manifest.regime ||
      canonicalHash(b.input) !== b.inputHash ||
      p.declaredAt > policy.startAt ||
      policy.generatedAt > p.generatedAt ||
      policy.intervalSeconds !== reference.assumptions.policy.intervalSeconds ||
      policy.startAt !== reference.assumptions.policy.startAt ||
      policy.endAt !== reference.assumptions.policy.endAt ||
      b.calendar.firstCloseAt !== reference.calendar.firstCloseAt ||
      b.quantity !== reference.quantity ||
      canonicalHash(policy.initialBalances.filter((v) => v.asset === policy.quoteCurrency)) !==
        canonicalHash(
          reference.assumptions.policy.initialBalances.filter(
            (v) => v.asset === reference.assumptions.policy.quoteCurrency,
          ),
        )
    )
      throw new Error('Incompatible frozen scenario/cohort/clock or quantity');
    if (
      s.parentScenarioId !== null &&
      !p.scenarios.some(
        (v) =>
          v.id === s.parentScenarioId &&
          v.asset === s.asset &&
          v.regime === s.regime &&
          v.stress === 'BASE',
      )
    )
      throw new Error('Stress has no matching base scenario');
    if (
      utcNanoseconds(policy.endAt) - utcNanoseconds(s.manifest.historyStartCloseAt) >
      BigInt(policy.intervalSeconds) * 129000000000n
    )
      throw new Error('Robustness history work budget');
    const e = new SpotEvidence(
      {
        schemaVersion: 'spot-simulation-input.v1',
        market: b.input.market,
        bars: b.input.replay.bars,
        commands: [],
      },
      policy,
    );
    if (
      !b.input.replay.bars.some(
        (bar) =>
          bar.availableAt !== null &&
          bar.availableAt >= policy.startAt &&
          bar.availableAt < policy.endAt &&
          e.bar(policy.instrumentKeys[0]!, bar),
      )
    )
      throw new Error('No eligible scenario prices');
  }
  deepFreeze(p);
  return p;
}
export function projectLongOnlyTargets(replay: ReplayArtifact): SignalCandidate[] {
  let previous = 0;
  return replay.candidates.map((c) => {
    const target = c.side === 'LONG' ? 1 : 0,
      side = target === previous ? 'HOLD' : target === 1 ? 'LONG' : 'SHORT';
    previous = target;
    return SignalCandidateSchema.parse({
      ...c,
      id: deterministicId('robust-long-only', {
        original: c.id,
        target,
        policy: 'ABSTAIN_TO_FLAT_V1',
      }),
      side,
      score: { status: 'KNOWN', value: target },
      rationaleIds: [...c.rationaleIds, c.id],
      reproducibility: {
        ...c.reproducibility,
        modelVersion: 'robust-long-only-target.v1',
        configHash: canonicalHash({
          original: c.reproducibility.configHash,
          policy: 'ABSTAIN_TO_FLAT_V1',
        }),
      },
    });
  });
}
function replayFor(p: MarketRobustnessPlan, t: RobustTrial, s: RobustScenario, code: string) {
  const m = s.manifest,
    b = m.backtest,
    policy = b.assumptions.policy,
    source = marketSource(m),
    factory = t.provider
      ? () => new MarketSignalProvider(t.provider, source).strategy()
      : createMarketMlStrategy(
          p.models.find((v) => v.id === t.modelId)!,
          source,
        );
  return executeReplay(
    b.input.replay,
    {
      schemaVersion: 'replay-request.v1',
      startAt: policy.startAt,
      endAt: policy.endAt,
      generatedAt: policy.generatedAt,
      symbols: [b.series.instrumentId],
      randomSeed: policy.randomSeed,
      snapshotEvery: 1,
      maxQueriesPerEvent: 20,
    },
    code,
    factory,
  );
}
function outcomeFor(
  r: ReplayArtifact,
  targets: SignalCandidate[],
  s: RobustScenario,
  code: string,
  role: BacktestOutcome['role'],
): BacktestOutcome {
  const b = s.manifest.backtest,
    p = b.assumptions.policy,
    compiled = compileMarketTargets({ candidates: targets }, b, p, code),
    simulation = simulateSpot(
      {
        schemaVersion: 'spot-simulation-input.v1',
        market: b.input.market,
        bars: b.input.replay.bars,
        commands: compiled.commands,
      },
      p,
      code,
    );
  return { role, replay: r, simulation, ...measureBacktest(simulation, b) };
}
function increments(o: BacktestOutcome, s: RobustScenario) {
  const b = s.manifest.backtest,
    p = b.assumptions.policy,
    times = [];
  for (
    let t = utcNanoseconds(b.calendar.firstCloseAt);
    t < utcNanoseconds(p.endAt);
    t += BigInt(p.intervalSeconds) * 1000000000n
  )
    times.push(fromEpoch(t, 'nanoseconds'));
  times.push(p.endAt);
  let previous: string | null = o.metrics.initialEquity;
  return times.map((at) => {
    const value = o.equity.filter((v) => v.at <= at).at(-1)?.equity ?? null,
      delta =
        value === null || previous === null
          ? null
          : new D(value).minus(previous).div(o.metrics.initialEquity).toNumber();
    previous = value;
    return delta;
  });
}
export interface RobustnessSink {
  journal(entry: RobustJournalEntry): Promise<void>;
  evidence(name: string, evidence: unknown): Promise<void>;
}
class PersistenceError extends Error {}
/** Every planned cell is journaled before execution; all failures remain in the family. */
export async function runMarketRobustness(
  input: unknown,
  codeVersion: string,
  sink?: RobustnessSink,
): Promise<{ report: MarketRobustnessReport; journal: RobustJournalEntry[] }> {
  if (!codeVersion || codeVersion.length > 200)
    throw new Error('Invalid robustness software version');
  const p = validateRobustnessPlan(input),
    planHash = canonicalHash(p),
    journal: RobustJournalEntry[] = [],
    attempts: RobustAttempt[] = [],
    controls = new Map<string, BacktestOutcome[]>(),
    fingerprints = new Map<string, { producerHash: string; featureHash: string }>();
  const emit = async (
    state: RobustJournalEntry['state'],
    trialId: string | null,
    scenarioId: string | null,
    evidenceHash: string | null,
  ) => {
    const body = {
        schemaVersion: 'market-robustness-journal-entry.v1' as const,
        sequence: journal.length + 1,
        planHash,
        trialId,
        scenarioId,
        state,
        evidenceHash,
        previousHash: journal.at(-1)?.hash ?? canonicalHash({ planHash, codeVersion }),
      },
      entry = RobustJournalEntrySchema.parse({ ...body, hash: canonicalHash(body) });
    if (sink) await sink.journal(entry);
    journal.push(entry);
  };
  const persist = async (name: string, value: unknown) => {
    if (sink)
      try {
        await sink.evidence(name, value);
      } catch (error) {
        throw new PersistenceError('Robustness evidence persistence failed', { cause: error });
      }
  };
  for (const t of p.trials) {
    const model = p.models.find((m) => m.id === t.modelId),
      featureHash = model
        ? canonicalHash(model.featureSchema)
        : new MarketSignalProvider(t.provider, marketSource(p.scenarios[0]!.manifest))
            .featureFingerprint;
    fingerprints.set(t.id, {
      producerHash: canonicalHash({ trial: t, modelHash: model ? canonicalHash(model) : null }),
      featureHash,
    });
  }
  await emit('PLANNED', null, null, null);
  for (const t of p.trials) for (const s of p.scenarios) await emit('PLANNED', t.id, s.id, null);
  for (const t of p.trials)
    for (const s of p.scenarios) {
      await emit('STARTED', t.id, s.id, null);
      let attempt: RobustAttempt,
        evidence: RobustEvidence | null = null;
      try {
        let benchmark = controls.get(s.id);
        if (!benchmark) {
          benchmark = [];
          for (const role of ['CASH', 'BUY_AND_HOLD'] as const) {
            const common = { ...s.manifest.provider };
            const config = {
                schemaVersion: 'market-strategy-config.v1',
                kind: role,
                minimumBaseVolume: common.minimumBaseVolume,
                staleAfterSeconds: common.staleAfterSeconds,
                maxHoldingBars: 128,
                cooldownBars: 0,
                onMissing: 'HOLD',
                signalValiditySeconds: 1800,
              },
              controlTrial = {
                ...t,
                id: `control_${role}`,
                modelId: null,
                provider: config,
              } as RobustTrial,
              r = replayFor(p, controlTrial, s, codeVersion);
            benchmark.push(outcomeFor(r, r.candidates, s, codeVersion, role));
          }
          await persist(deterministicId('robust-control', s.id), {
            schemaVersion: 'robust-control-evidence.v1',
            scenarioId: s.id,
            outcomes: benchmark,
          });
          controls.set(s.id, benchmark);
        }
        const r = replayFor(p, t, s, codeVersion),
          targets = t.modelId ? projectLongOnlyTargets(r) : r.candidates,
          outcome = outcomeFor(r, targets, s, codeVersion, 'STRATEGY');
        evidence = RobustEvidenceSchema.parse({
          schemaVersion: 'market-robustness-evidence.v1',
          trialId: t.id,
          scenarioId: s.id,
          originalReplay: r,
          projectedCandidates: targets,
          outcome,
        });
        attempt = RobustAttemptSchema.parse({
          trialId: t.id,
          scenarioId: s.id,
          status: 'COMPLETE',
          reason: 'COMPLETE',
          ...fingerprints.get(t.id)!,
          outcomeHash: canonicalHash(evidence),
          originalCandidatesHash: r.manifest.candidatesHash,
          projectedCandidatesHash: canonicalHash(targets),
          signals: r.candidates.map((c) => ({ at: c.decisionAt, side: c.side })),
          metrics: outcome.metrics,
          cashNetReturn:
            benchmark[0]!.metrics.netReturn === null
              ? null
              : Number(benchmark[0]!.metrics.netReturn),
          buyAndHoldNetReturn:
            benchmark[1]!.metrics.netReturn === null
              ? null
              : Number(benchmark[1]!.metrics.netReturn),
          increments: increments(outcome, s),
          warnings: [
            ...(outcome.metrics.fillCount ? [] : ['NO_FILLS_NO_EXECUTED_EDGE']),
            ...(t.modelId
              ? [
                  'SHORT_OR_ABSTAIN_PROJECTS_TO_FLAT_NO_BORROWING',
                  'ORIGINAL_HORIZON_EXPIRY_IS_NOT_EXTENDED',
                ]
              : []),
          ],
        });
      } catch (error) {
        if (error instanceof PersistenceError) throw error;
        attempt = RobustAttemptSchema.parse({
          trialId: t.id,
          scenarioId: s.id,
          status: 'FAILED',
          reason: 'CAUSAL_OR_EXECUTION_REJECTED',
          ...fingerprints.get(t.id)!,
          outcomeHash: null,
          originalCandidatesHash: null,
          projectedCandidatesHash: null,
          signals: [],
          metrics: null,
          cashNetReturn: null,
          buyAndHoldNetReturn: null,
          increments: [],
          warnings: ['FAILED_ATTEMPT_RETAINED_IN_MULTIPLICITY_FAMILY'],
        });
      }
      if (evidence && attempt.status === 'COMPLETE')
        await persist(
          deterministicId('robust-evidence', { trialId: t.id, scenarioId: s.id }),
          evidence,
        );
      attempts.push(attempt);
      await emit(attempt.status, t.id, s.id, attempt.outcomeHash ?? canonicalHash(attempt));
    }
  const importedCalibrationTrials = p.models.reduce((n, m) => n + m.calibration.trials.length, 0),
    familySize =
      p.priorTrialCount + p.trials.length * p.scenarios.length + importedCalibrationTrials,
    rankings = rankRobustness({
      attempts,
      trialIds: p.trials.map((t) => t.id),
      familySize,
      randomSeed: p.randomSeed,
      policy: p.policy,
    }),
    synthetic = p.scenarios.some(
      (s) =>
        s.manifest.backtest.input.market.sources.some((v) => v.origin === 'SYNTHETIC') ||
        s.manifest.backtest.input.replay.bars.some(
          (b) => b.provenance.origin === 'FIXTURE' || b.qualityFlags.includes('SYNTHETIC'),
        ),
    );
  const instability = p.trials
    .filter((t) => t.parentTrialId !== null)
    .map((t) => {
      const pairs = p.scenarios
        .map(
          (s) =>
            [
              attempts.find((a) => a.trialId === t.id && a.scenarioId === s.id)!,
              attempts.find((a) => a.trialId === t.parentTrialId && a.scenarioId === s.id)!,
            ] as const,
        )
        .filter(([a, b]) => a.status === 'COMPLETE' && b.status === 'COMPLETE');
      let changedSignalEvents = 0,
        comparedSignalEvents = 0;
      for (const [a, b] of pairs)
        for (const v of a.signals) {
          const other = b.signals.find((w) => w.at === v.at);
          if (other) {
            comparedSignalEvents++;
            if (other.side !== v.side) changedSignalEvents++;
          }
        }
      const deltas = pairs.flatMap(([a, b]) =>
        a.metrics?.netReturn !== null && b.metrics?.netReturn !== null
          ? [Math.abs(Number(a.metrics!.netReturn) - Number(b.metrics!.netReturn))]
          : [],
      );
      return {
        trialId: t.id,
        parentTrialId: t.parentTrialId!,
        change: t.change,
        comparableCases: pairs.length,
        signFlipCases: pairs.filter(
          ([a, b]) => Number(a.metrics!.netReturn) * Number(b.metrics!.netReturn) < 0,
        ).length,
        changedSignalEvents,
        comparedSignalEvents,
        maxAbsoluteNetDelta: deltas.length ? Math.max(...deltas) : null,
      };
    });
  const selection = selectRobustness(rankings, p, synthetic, attempts, fingerprints);
  await emit(
    'FINALIZED',
    null,
    null,
    canonicalHash({ attempts, rankings, instability, selection }),
  );
  const report = MarketRobustnessReportSchema.parse({
    schemaVersion: 'market-robustness-report.v1',
    execution: 'SIMULATED',
    liveExecution: 'DISABLED',
    codeVersion,
    plan: p,
    planHash,
    synthetic,
    familySize,
    attemptCount: attempts.length,
    importedCalibrationTrials,
    attempts,
    rankings,
    instability,
    selection,
    journalHead: journal.at(-1)!.hash,
    warnings: [
      'All planned, failed and imported calibration trials contribute to the conservative declared family count; unrecorded external attempts cannot be authenticated.',
      'Ranking is mean net return minus worst sampled drawdown minus downside empirical 5% cell CVaR, not annualized Sharpe or proof of profitability.',
      'Joint circular time blocks reuse the same indices across assets/regimes/stress variants. Marginal intervals and centered-bootstrap p-values are conditional approximations, not population guarantees.',
      'Insufficient blocks, flat returns, unknown marks and limited Monte Carlo resolution prevent promotion. Holm padding counts failed/prior attempts as p=1.',
      'Synthetic evidence never promotes a model; zero selected candidates is valid. Every discarded version is archived with immutable producer/feature fingerprints.',
      'ML long-only target projection preserves original forecast candidates and expiry; two-bar horizons can expire before a conservative full-candle fill.',
      'Scenario cash/buy-and-hold accounts have identical fixed quantity and execution assumptions; immutable control evidence is reused without sharing mutable balances.',
      'This is a disclosed sparse stress design, not a complete historical market, independent sample, all-combinations test or real-money strategy.',
    ],
  });
  deepFreeze(report);
  await persist('robust-handoff', {
    schemaVersion: 'market-robustness-handoff.v1',
    targetModule: '11',
    planHash,
    reportHash: canonicalHash(report),
    requiresNewForwardExperiment: true,
    selected: selection.filter((v) => v.status === 'FORWARD_RESEARCH_CANDIDATE'),
  });
  await persist('robust-archive', {
    schemaVersion: 'market-robustness-archive.v1',
    planHash,
    reportHash: canonicalHash(report),
    archived: selection.filter((v) => v.status === 'ARCHIVED'),
    trials: p.trials.filter((t) =>
      selection.some((v) => v.trialId === t.id && v.status === 'ARCHIVED'),
    ),
    models: p.models.filter((m) =>
      p.trials.some(
        (t) =>
          t.modelId === m.id &&
          selection.some((v) => v.trialId === t.id && v.status === 'ARCHIVED'),
      ),
    ),
  });
  deepFreeze(journal);
  return { report, journal };
}
