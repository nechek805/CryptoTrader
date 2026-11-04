import {
  ExperimentProtocolSchema,
  PaperConfigSchema,
  PaperEventSchema,
  TrialAnnotationSchema,
} from '@crypto/contracts';
import type { PaperEvent, TrialAnnotation } from '@crypto/contracts';
import { canonicalHash, fromEpoch } from '@crypto/core';
import {
  PaperBroker,
  paperFixtureConfig,
  syntheticPaperQuote,
  syntheticPaperProposal,
  replayPaper,
} from '@crypto/paper';
import { evaluationFixturePlan } from './fixture.js';
import { makeDecisionRecord } from '@crypto/risk';
import {
  experimentPaperConfig,
  freezeExperiment,
  trialArtifact,
  unboundTrialHash,
} from './experiment-protocol.js';

export const trialFixtureAt = (seconds: number) =>
  fromEpoch(1767225600n + BigInt(seconds), 'seconds');
const decisionDays = [0, 4, 10, 15];
export function experimentProtocolFixture(codeVersion = 'synthetic:thirty-day-study.v1') {
  const base = paperFixtureConfig(codeVersion),
    frozenAt = trialFixtureAt(0),
    endAt = trialFixtureAt(30 * 86400),
    newsHash = canonicalHash('synthetic:trial-news-rights'),
    paper = PaperConfigSchema.parse({
      ...base.config,
      runManifestHash: unboundTrialHash,
      endAt,
      recordingPolicy: 'TRIAL_IDLE_120S_ACTIVE_100MS_RELEVANT_TRADES_V1',
      instruments: ['BTC', 'ETH', 'SOL'].map((asset) => ({
        ...base.config.instruments[0],
        symbol: `${asset}/USDT`,
        base: asset,
        metadataHash: canonicalHash({ origin: 'SYNTHETIC', asset, metadata: 'trial.v1' }),
      })),
      newsSources: [
        {
          id: 'synthetic:trial-news',
          licenseReviewHash: newsHash,
          validUntil: trialFixtureAt(31 * 86400),
          heartbeatTtlSeconds: 3600,
        },
      ],
    }),
    models = (['BASELINE', 'NEWS_ONLY', 'MARKET_ONLY', 'FUSION'] as const).map((portfolio) => ({
      portfolio,
      strategyId: `synthetic:${portfolio}`,
      artifact: trialArtifact({
        id: `synthetic:model:${portfolio}`,
        version: 'synthetic-rule.v1',
        origin: 'SYNTHETIC',
        knownAt: frozenAt,
        trainingCutoff: null,
        content: {
          origin: 'SYNTHETIC',
          rule: portfolio === 'BASELINE' ? 'CASH_HOLD' : 'SCRIPTED_ACCOUNTING_NOT_PREDICTIVE',
          inputPolicy:
            portfolio === 'NEWS_ONLY'
              ? 'NEWS_ONLY'
              : portfolio === 'MARKET_ONLY'
                ? 'MARKET_ONLY'
                : portfolio === 'FUSION'
                  ? 'FROZEN_FUSION'
                  : 'NONE',
        },
      }),
    })),
    providers = (
      [
        {
          id: paper.source.id,
          kind: 'MARKET',
          adapterVersion: paper.source.adapterVersion,
          reviewHash: paper.source.licenseReviewHash,
          validUntil: paper.source.validUntil,
        },
        {
          id: paper.newsSources[0]!.id,
          kind: 'NEWS',
          adapterVersion: 'synthetic-news-heartbeat.v1',
          reviewHash: newsHash,
          validUntil: paper.newsSources[0]!.validUntil,
        },
      ] as const
    ).map((s) => {
      const adapterHash = canonicalHash({ origin: 'SYNTHETIC', adapter: s.adapterVersion });
      return {
        ...s,
        adapterHash,
        reviewedAt: frozenAt,
        approved: true,
        rights: 'LOCALLY_AUTHORED_SYNTHETIC',
        evidence: trialArtifact({
          id: `${s.id}/review`,
          version: 'synthetic-review.v1',
          origin: 'SYNTHETIC',
          knownAt: frozenAt,
          trainingCutoff: null,
          content: {
            origin: 'SYNTHETIC',
            adapterHash,
            licenseReviewHash: s.reviewHash,
            permission: 'Locally authored fictional acceptance data only',
          },
        }),
      };
    });
  return ExperimentProtocolSchema.parse({
    schemaVersion: 'experiment-protocol.v1',
    execution: 'SIMULATED',
    origin: 'SYNTHETIC',
    name: 'synthetic-30-day-operational-exercise',
    frozenAt,
    codeVersion,
    paper,
    riskPolicy: base.policy,
    models,
    providers,
    evaluation: {
      ...evaluationFixturePlan(),
      frozenAt,
      generatedAt: trialFixtureAt(30 * 86400 + 1),
      opportunityGrid: decisionDays.map((day) => ({
        at: trialFixtureAt(day * 86400 + 61),
        symbol: 'BTC/USDT',
      })),
      marketObservationCadenceSeconds: 3600,
    },
    newsPolicy: {
      independentOrigins: 2,
      dependenciesCountAsOne: true,
      confirmationClock: 'LATEST_REQUIRED_AVAILABLE_AT',
      delayedTreatment: 'HOLD_AT_SLOT_NEVER_BACKDATE',
      corrections: 'APPEND_NEW_KNOWLEDGE',
    },
    schedule: {
      heartbeatSeconds: 3600,
      sourceAuditSeconds: 3600,
      reconcile: 'UTC_DAILY',
      weeklyQaDays: 7,
      maxClockLagSeconds: 30,
    },
    failureCriteria: {
      minimumCoverage: '0.95',
      knownLookAheadBugs: 0,
      duplicateLedgerBugs: 0,
      hardRiskBreaches: 0,
      stopOnIntegrityFailure: true,
    },
    baselinePolicy: 'CASH',
    fillModel: 'OBSERVED_QUOTES_AND_TRADE_THROUGH_ASSUMED_QUEUE_V1',
    spreadPolicy: 'OBSERVED_BID_ASK_NO_FIXED_SPREAD_INVENTION',
    changePolicy: 'ANY_CODE_OR_PARAMETER_CHANGE_NEW_EXPERIMENT_ID',
  });
}
/** Thirty virtual days run quickly; this is never presented as thirty elapsed forward days. */
export function experimentExercise(codeVersion = 'synthetic:thirty-day-study.v1', restart = true) {
  const manifest = freezeExperiment(experimentProtocolFixture(codeVersion)),
    config = experimentPaperConfig(manifest);
  let broker = new PaperBroker(config);
  const events: PaperEvent[] = [],
    annotations: TrialAnnotation[] = [],
    consume = (e: unknown) => {
      const parsed = PaperEventSchema.parse(e);
      broker.consume(parsed);
      events.push(parsed);
    },
    note = (
      kind: TrialAnnotation['kind'],
      seconds: number,
      reference: unknown,
      extra: Partial<TrialAnnotation> = {},
    ) =>
      annotations.push(
        TrialAnnotationSchema.parse({
          schemaVersion: 'trial-annotation.v1',
          id: `synthetic:${kind}:${seconds}`,
          at: trialFixtureAt(seconds),
          kind,
          sourceId: null,
          referenceHash: canonicalHash(reference),
          evidence: reference,
          intervalStart: null,
          intervalEnd: null,
          affectedCandidateIds: [],
          outcome: 'RECORDED',
          ...extra,
        }),
      ),
    quote = (seconds: number, asset: string, bid = '99.99', ask = '100', quantity = '10000') => {
      const q = syntheticPaperQuote(seconds, bid, ask, quantity),
        instrument = config.instruments.find((i) => i.base === asset)!;
      if (q.kind !== 'QUOTE') throw new Error('Fixture quote kind');
      return PaperEventSchema.parse({
        ...q,
        id: `${q.id}:${asset}`,
        providerEventId: `${q.providerEventId}:${asset}`,
        symbol: instrument.symbol,
        metadataHash: instrument.metadataHash,
        rawHash: canonicalHash({ origin: 'SYNTHETIC', seconds, asset, bid, ask, quantity }),
      });
    },
    news = (seconds: number, healthy = true) =>
      consume({
        kind: 'HEARTBEAT',
        id: `synthetic:news:${seconds}:${healthy}`,
        at: trialFixtureAt(seconds),
        sourceId: config.newsSources[0]!.id,
        licenseReviewHash: config.newsSources[0]!.licenseReviewHash,
        healthy,
      });
  note('SESSION_START', 0, manifest.hash);
  for (let day = 0; day < 30; day++) {
    const t = day * 86400;
    for (let hour = 0; hour < 24; hour++) {
      const s = t + hour * 3600,
        marketOut = day === 6 && hour >= 2 && hour < 5,
        newsOut = day === 4 && hour >= 1 && hour < 6;
      if (marketOut)
        consume({
          kind: 'SAFETY',
          id: `synthetic:market-out:${s}`,
          at: trialFixtureAt(s),
          code: 'MARKET_OUTAGE',
          sourceId: config.source.id,
          rawHash: null,
        });
      else for (const asset of ['BTC', 'ETH', 'SOL']) consume(quote(s, asset));
      if (newsOut)
        consume({
          kind: 'SAFETY',
          id: `synthetic:news-out:${s}`,
          at: trialFixtureAt(s),
          code: 'NEWS_OUTAGE',
          sourceId: config.newsSources[0]!.id,
          rawHash: null,
        });
      else {
        if (day === 4 && hour === 6)
          consume({
            kind: 'SAFETY',
            id: 'synthetic:news-restored',
            at: trialFixtureAt(s),
            code: 'NEWS_RESTORED',
            sourceId: config.newsSources[0]!.id,
            rawHash: null,
          });
        news(s);
      }
      if (day === 14 && hour === 12 && restart) {
        const prefix = broker.report();
        broker = new PaperBroker(config);
        for (const e of events) broker.consume(e);
        if (canonicalHash(prefix) !== canonicalHash(broker.report()))
          throw new Error('Fixture restart mismatch');
        note('RESTART', s, prefix.logHead, {
          outcome: 'RECOVERED_FROM_COMMITTED_PREFIX',
          intervalStart: trialFixtureAt(s - 300),
          intervalEnd: trialFixtureAt(s),
        });
      }
      if (hour !== 0) continue;
      consume(quote(t + 60, 'BTC'));
      consume({ kind: 'TICK', id: `synthetic:decision-clock:${day}`, at: trialFixtureAt(t + 61) });
      for (const arm of decisionDays.includes(day)
        ? (['BASELINE', 'NEWS_ONLY', 'MARKET_ONLY', 'FUSION'] as const)
        : []) {
        const proposal = syntheticPaperProposal(broker, arm, t + 61);
        if (proposal.kind === 'PROPOSE' && (arm === 'NEWS_ONLY' || arm === 'FUSION')) {
          const late = day === 4,
            request = proposal.decision.request;
          if (late)
            proposal.decision = makeDecisionRecord(
              manifest.protocol.riskPolicy,
              {
                ...request,
                risk: {
                  ...request.risk,
                  candidate: { ...request.risk.candidate, side: 'HOLD' },
                  positionPolicy: null,
                },
              },
              codeVersion,
            );
          note(
            'CORROBORATION_DELAY',
            t + 61,
            {
              origin: 'SYNTHETIC',
              confirmation: late ? 'NOT_KNOWN_AT_SLOT' : 'KNOWN_AT_SLOT',
              candidate: proposal.decision.request.risk.candidate.id,
            },
            {
              id: `synthetic:corroboration:${arm}:${day}`,
              sourceId: config.newsSources[0]!.id,
              affectedCandidateIds: [proposal.decision.request.risk.candidate.id],
              outcome: late ? 'HOLD' : 'RECORDED',
            },
          );
        }
        consume(proposal);
      }
      consume(quote(t + 62, 'BTC', '99.99', '100', '0.4'));
      consume(quote(t + 63, 'BTC'));
      const losing = day % 3 === 0,
        volatile = day === 10;
      consume(
        quote(
          t + 120,
          'BTC',
          volatile ? '70' : losing ? '90' : '120',
          volatile ? '70.01' : losing ? '90.01' : '120.01',
        ),
      );
      consume(
        quote(
          t + 121,
          'BTC',
          volatile ? '65' : losing ? '89' : '119',
          volatile ? '65.01' : losing ? '89.01' : '119.01',
        ),
      );
      if (day === 8) {
        const duplicate = quote(t + 180, 'BTC');
        consume(duplicate);
        consume(duplicate);
        note('DUPLICATE_SOURCE', t + 180, duplicate, {
          sourceId: config.source.id,
          outcome: 'DUPLICATE_NOT_INDEPENDENT',
        });
      }
      if (day === 12)
        note(
          'NEWS_CORRECTION',
          t + 300,
          {
            origin: 'SYNTHETIC',
            originalAt: trialFixtureAt(t + 10),
            knownAt: trialFixtureAt(t + 300),
            correction: 'Retained later knowledge; no backdating',
          },
          { sourceId: config.newsSources[0]!.id },
        );
      if (day === 18) {
        consume({
          kind: 'CONTROL',
          id: 'synthetic:manual-pause',
          at: trialFixtureAt(t + 600),
          action: 'PAUSE',
          actor: 'synthetic:operator',
          reason: 'Synthetic integrity review',
        });
        consume({
          kind: 'CONTROL',
          id: 'synthetic:manual-resume',
          at: trialFixtureAt(t + 900),
          action: 'RESUME',
          actor: 'synthetic:operator',
          reason: 'Synthetic review completed',
        });
      }
    }
    consume({
      kind: 'RECONCILE',
      id: `synthetic:daily-reconcile:${day}`,
      at: trialFixtureAt(t + 86399),
    });
  }
  for (const asset of ['BTC', 'ETH', 'SOL']) consume(quote(30 * 86400, asset));
  news(30 * 86400);
  consume({
    kind: 'CONTROL',
    id: 'synthetic:trial-complete',
    at: config.endAt,
    action: 'STOP',
    actor: 'synthetic:operator',
    reason: 'End of thirty virtual days; not elapsed wall time',
  });
  return {
    schemaVersion: 'trial-run.v1' as const,
    manifest,
    paper: replayPaper(config, events),
    annotations,
    wallClockStartedAt: null,
    wallClockFinishedAt: null,
  };
}
