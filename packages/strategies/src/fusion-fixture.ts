import { FusionRunInputSchema, SignalCandidateSchema } from '@crypto/contracts';
import { canonicalHash, deterministicId } from '@crypto/core';

/** Invented candidate handoffs, not historical signals, fills, returns or model validation. */
export function fusionFixture(codeVersion = 'synthetic:fusion-fixture.v1') {
  const dataHash = canonicalHash({ origin: 'SYNTHETIC', fixture: 'fusion.v1' }),
    feeHash = canonicalHash({ origin: 'SYNTHETIC', makerRate: '0.001', takerRate: '0.001' }),
    executionHash = canonicalHash({ mode: 'DISABLED', assumedLatencyMs: 500 }),
    trainingHash = canonicalHash({ origin: 'SYNTHETIC', cohort: 'TRAIN' }),
    plan = {
      schemaVersion: 'fusion-plan.v1',
      origin: 'SYNTHETIC',
      codeVersion,
      generatedAt: '2026-02-02T00:10:00Z',
      randomSeed: 42,
      baselinePolicy: 'CASH',
      policy: {
        schemaVersion: 'fusion-policy.v1',
        algorithmVersion: 'conservative-fusion.v1',
        kind: 'AGREEMENT_ONLY',
        frozenAt: '2026-02-01T00:00:00Z',
        selection: {
          phase: 'TRAIN',
          startAt: '2026-01-01T00:00:00Z',
          endAt: '2026-01-25T00:00:00Z',
          availableAt: '2026-01-26T00:00:00Z',
          datasetHash: trainingHash,
          reportHash: canonicalHash({
            origin: 'SYNTHETIC',
            selectedOn: 'TRAIN',
            policy: 'AGREEMENT_ONLY',
          }),
        },
        newsWeight: '0.5',
        minimumWeightedScore: '0.25',
      },
      common: {
        initialCapital: '10000',
        currency: 'USDT',
        datasetHashes: [dataHash],
        feeAssumptionsHash: feeHash,
        executionAssumptionsHash: executionHash,
      },
      producers: {
        BASELINE: {
          id: 'synthetic:cash',
          version: '1',
          configHash: canonicalHash({ origin: 'SYNTHETIC', policy: 'CASH' }),
        },
        NEWS_ONLY: {
          id: 'synthetic:news',
          version: '1',
          configHash: canonicalHash({ origin: 'SYNTHETIC', policy: 'NEWS' }),
        },
        MARKET_ONLY: {
          id: 'synthetic:market',
          version: '1',
          configHash: canonicalHash({ origin: 'SYNTHETIC', policy: 'MARKET' }),
        },
      },
      opportunities: [1, 2, 3].map((i) => ({
        id: `synthetic:fusion-window:${i}`,
        symbol: 'BTC/USDT',
        decisionAt: `2026-02-02T00:0${i}:00Z`,
        dataCutoff: `2026-02-02T00:0${i}:00Z`,
        validUntil: `2026-02-02T00:0${i + 1}:00Z`,
        horizon: { value: 60, unit: 'seconds' },
        snapshotHash: canonicalHash({ origin: 'SYNTHETIC', dataHash, prefix: i }),
      })),
    };
  const windows = plan.opportunities.map((w, i) => ({
    opportunityId: w.id,
    submissions: Object.fromEntries(
      (['BASELINE', 'NEWS_ONLY', 'MARKET_ONLY'] as const).map((arm) => {
        const descriptor = plan.producers[arm],
          evidence = {
            id: `synthetic:evidence:${arm}:${i}`,
            contentHash: canonicalHash({ arm, i, origin: 'SYNTHETIC' }),
            availableAt: w.dataCutoff,
            availabilityBasis: 'OBSERVED',
            researchUse: 'ELIGIBLE',
            origin: 'SYNTHETIC',
          },
          side =
            arm === 'BASELINE'
              ? 'HOLD'
              : i === 0 && arm === 'MARKET_ONLY'
                ? 'SHORT'
                : i === 2 && arm === 'NEWS_ONLY'
                  ? 'HOLD'
                  : 'LONG',
          body = {
            schemaVersion: 'signal-candidate.v1',
            strategyId: descriptor.id,
            version: descriptor.version,
            portfolio: arm,
            symbol: w.symbol,
            decisionAt: w.decisionAt,
            dataCutoff: w.dataCutoff,
            horizon: w.horizon,
            side,
            score: { status: 'MISSING', reason: 'Synthetic rule handoff' },
            calibration: { status: 'MISSING', reason: 'Synthetic rule is uncalibrated' },
            rationaleIds: [evidence.id],
            validUntil: w.validUntil,
            reproducibility: {
              datasetHashes: [dataHash],
              configHash: descriptor.configHash,
              codeVersion: plan.codeVersion,
              modelVersion: 'synthetic-rule.v1',
              randomSeed: 42,
              randomAlgorithm: 'mulberry32.v1',
              clockSemantics: 'utc-nanoseconds.v1',
              generatedAt: w.decisionAt,
              feeAssumptionsHash: feeHash,
            },
          },
          c = SignalCandidateSchema.parse({
            ...body,
            id: deterministicId('synthetic-fusion-signal', body),
          });
        return [
          arm,
          {
            snapshotHash: w.snapshotHash,
            executionAssumptionsHash: executionHash,
            candidates: i === 1 ? [c, c] : [c],
            evidence: [evidence],
            calibration: null,
          },
        ];
      }),
    ),
  }));
  return FusionRunInputSchema.parse({ schemaVersion: 'fusion-run-input.v1', plan, windows });
}
