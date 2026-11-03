import { Decimal } from 'decimal.js';
import {
  MarketStrategyConfigSchema,
  MarketStrategySourceSchema,
  MarketStrategyStateSchema,
  MarketDecisionSchema,
  utcNanoseconds,
} from '@crypto/contracts';
import type {
  MarketStrategyConfig,
  MarketStrategySource,
  MarketStrategyState,
  MarketDecision,
  MarketBar,
  TechnicalFeatureRow,
  TechnicalFeatureValue,
  ReplayEvent,
  ReplayStrategyDescriptor,
  UtcTimestamp,
} from '@crypto/contracts';
import { canonicalHash, deepFreeze } from '@crypto/core';
import { MarketEligibility } from './eligibility.js';
const D = Decimal.clone({ precision: 256, rounding: Decimal.ROUND_HALF_EVEN });
/** Deliberately excludes all news and execution/account methods. */
export interface MarketOnlyContext {
  readonly clock: Readonly<{ now: () => UtcTimestamp }>;
  bar(query: unknown): MarketBar;
  bars(query: unknown): readonly MarketBar[];
  features(query: unknown): TechnicalFeatureRow;
}
export interface MarketStrategy {
  readonly descriptor: ReplayStrategyDescriptor;
  initialState(): unknown;
  onEvent(event: Readonly<ReplayEvent>, context: MarketOnlyContext, state: unknown): unknown;
}
export const marketStrategyId = (kind: MarketStrategyConfig['kind']) =>
  ({
    CASH: 'market:cash',
    BUY_AND_HOLD: 'market:buy-and-hold',
    MA_CROSSOVER: 'market:ma-crossover',
    BREAKOUT: 'market:breakout',
    ZSCORE_REVERSION: 'market:zscore-reversion',
    SYMMETRIC_MA_FIXTURE: 'synthetic:market-symmetric-ma',
  })[kind];
const max = <T extends string>(a: T, b: T) => (a > b ? a : b);
/** Structural producer port; the exported constructor remains compatible with earlier callers. */
export interface MarketSignalProvider {
  readonly descriptor: ReplayStrategyDescriptor;
  initialState(): unknown;
  strategy(): MarketStrategy;
}
class RuleMarketSignalProvider implements MarketSignalProvider {
  readonly config: MarketStrategyConfig;
  readonly source: MarketStrategySource;
  readonly providerHash: string;
  readonly featureFingerprint: string;
  readonly descriptor: ReplayStrategyDescriptor;
  readonly #eligibility: MarketEligibility;
  constructor(config: unknown, source: unknown) {
    this.config = MarketStrategyConfigSchema.parse(config);
    this.source = MarketStrategySourceSchema.parse(source);
    if (this.source.series.marketType !== 'SPOT')
      throw new Error('Market baselines require spot source semantics');
    if (
      this.config.kind === 'SYMMETRIC_MA_FIXTURE' &&
      !this.source.market.sources.every((s) => s.origin === 'SYNTHETIC')
    )
      throw new Error('Symmetric diagnostic requires synthetic source metadata');
    const { market: _, ...binding } = this.source;
    void _;
    this.descriptor = {
      id: marketStrategyId(this.config.kind),
      version: '1',
      portfolio: this.source.portfolio,
      config: JSON.parse(
        JSON.stringify({ provider: this.config, source: binding }),
      ) as ReplayStrategyDescriptor['config'],
    };
    this.providerHash = canonicalHash(this.descriptor);
    this.featureFingerprint = canonicalHash({
      algorithm: 'technical-features.v1',
      policy: 'market-baselines.v1',
      provider: this.config,
    });
    this.#eligibility = new MarketEligibility(this.source);
    deepFreeze(this.config);
    deepFreeze(this.source);
    deepFreeze(this.descriptor);
  }
  initialState(): MarketStrategyState {
    return MarketStrategyStateSchema.parse({
      schemaVersion: 'market-strategy-state.v1',
      providerHash: this.providerHash,
      position: 'FLAT',
      lastCloseAt: null,
      previousRelation: null,
      heldBars: 0,
      cooldown: 0,
      lastDecision: null,
    });
  }
  evaluate(event: Readonly<ReplayEvent>, context: MarketOnlyContext, stateInput: unknown) {
    const state = MarketStrategyStateSchema.parse(stateInput);
    if (state.providerHash !== this.providerHash)
      throw new Error('Market strategy state/config mismatch');
    if (
      event.kind !== 'MARKET_BAR' ||
      event.record.exchange !== this.source.series.exchange ||
      event.record.instrumentId !== this.source.series.instrumentId ||
      event.record.marketType !== this.source.series.marketType
    )
      return { state, decision: null };
    const now = context.clock.now(),
      current = context.bar({ id: event.recordId, asOf: now }),
      cfg = this.config,
      source = this.source;
    if (state.lastCloseAt !== null && current.closeAt <= state.lastCloseAt)
      return { state, decision: null };
    if (
      cfg.kind === 'SYMMETRIC_MA_FIXTURE' &&
      (current.provenance.origin !== 'FIXTURE' || !current.qualityFlags.includes('SYNTHETIC'))
    )
      throw new Error('Symmetric diagnostic requires synthetic bars');
    if (
      utcNanoseconds(now) < utcNanoseconds(source.historyStartCloseAt) ||
      (utcNanoseconds(now) - utcNanoseconds(source.historyStartCloseAt)) /
        (BigInt(source.intervalSeconds) * 1000000000n) >
        127n
    )
      throw new Error('Market history must span at most 128 close slots');
    const next: MarketStrategyState = {
        ...state,
        lastCloseAt: current.closeAt,
        heldBars: state.position === 'FLAT' ? 0 : state.heldBars + 1,
        lastDecision: null,
      },
      metadata = new Set<string>(),
      used = new Map<string, MarketBar>([[current.id, current]]),
      features: MarketDecision['features'] = [];
    let reason = 'READY',
      action: MarketDecision['action'] = 'HOLD',
      relation: number | null = state.previousRelation,
      entry = false,
      exit = false,
      shortEntry = false,
      shortExit = false;
    const currentMeta = this.#eligibility.bar(current, now);
    if (currentMeta) metadata.add(currentMeta.id);
    let valid =
      currentMeta !== null &&
      utcNanoseconds(now) - utcNanoseconds(current.closeAt) <=
        BigInt(cfg.staleAfterSeconds) * 1000000000n;
    if (!valid) reason = 'SOURCE_INELIGIBLE';
    const technical = (periods: {
      smaPeriod?: number;
      emaPeriod?: number;
      breakoutPeriod?: number;
      zScorePeriod?: number;
    }) =>
      context.features({
        schemaVersion: 'technical-feature-query.v1',
        series: source.series,
        intervalSeconds: source.intervalSeconds,
        historyStartCloseAt: source.historyStartCloseAt,
        featureAsOf: now,
        config: {
          schemaVersion: 'technical-feature-config.v1',
          smaPeriod: 1,
          emaPeriod: 1,
          volatilityPeriod: 1,
          atrPeriod: 1,
          relativeVolumePeriod: 1,
          zScorePeriod: 2,
          breakoutPeriod: 2,
          returnHorizonsBars: [1],
          minimumBaseVolume: cfg.minimumBaseVolume,
          lowRelativeVolumeThreshold: '0',
          candleGapThresholdBps: 10000,
          staleAfterSeconds: cfg.staleAfterSeconds,
          ...periods,
        },
      });
    const selected: TechnicalFeatureValue[] = [];
    const use = (row: TechnicalFeatureRow, id: string, name: string, formula: unknown) => {
      if (row.currentBarId !== current.id) valid = false;
      const f = row.features.find((f) => f.featureId === id)!;
      selected.push(f);
      features.push({
        name,
        value: f.value,
        status: f.status,
        definitionHash: canonicalHash({ algorithm: 'technical-features.v1', id, formula }),
      });
      return f.status === 'READY' && f.value !== null ? new D(f.value) : null;
    };
    if (valid) {
      if (cfg.kind === 'CASH') reason = 'ALWAYS_NEUTRAL';
      else if (cfg.kind === 'BUY_AND_HOLD') {
        entry = state.position === 'FLAT' && state.lastDecision?.reason !== 'BUY_AND_HOLD_ACTIVE';
        reason = 'BUY_AND_HOLD_ACTIVE';
      } else if (cfg.kind === 'MA_CROSSOVER' || cfg.kind === 'SYMMETRIC_MA_FIXTURE') {
        const id = cfg.average === 'SMA' ? 'sma' : 'ema',
          fast = use(
            technical({ smaPeriod: cfg.fastPeriod, emaPeriod: cfg.fastPeriod }),
            id,
            'fast_average',
            { period: cfg.fastPeriod },
          ),
          slow = use(
            technical({ smaPeriod: cfg.slowPeriod, emaPeriod: cfg.slowPeriod }),
            id,
            'slow_average',
            { period: cfg.slowPeriod },
          );
        if (fast === null || slow === null) {
          valid = false;
          reason = 'MISSING_FEATURE';
          relation = null;
        } else {
          relation = fast.cmp(slow);
          entry = relation > 0 && (state.previousRelation === null || state.previousRelation <= 0);
          exit = relation < 0;
          shortEntry =
            relation < 0 && (state.previousRelation === null || state.previousRelation >= 0);
          shortExit = relation > 0;
        }
      } else if (cfg.kind === 'BREAKOUT') {
        const row = technical({ breakoutPeriod: cfg.lookbackBars }),
          upper = use(row, 'breakout_upper', 'prior_upper', { period: cfg.lookbackBars }),
          lower = use(
            cfg.exitLookbackBars === cfg.lookbackBars
              ? row
              : technical({ breakoutPeriod: cfg.exitLookbackBars }),
            'breakout_lower',
            'prior_exit_lower',
            { period: cfg.exitLookbackBars },
          );
        if (upper === null || lower === null) {
          valid = false;
          reason = 'MISSING_FEATURE';
        } else {
          entry = new D(current.close).gt(
            upper.mul(new D(1).plus(new D(cfg.entryBufferBps).div(10000))),
          );
          exit = new D(current.close).lt(lower);
        }
      } else {
        const z = use(
          technical({ zScorePeriod: cfg.lookbackBars }),
          'z_score',
          'prior_window_zscore',
          { period: cfg.lookbackBars },
        );
        if (z === null) {
          valid = false;
          reason = 'MISSING_FEATURE';
        } else {
          entry = z.lte(new D(cfg.entryThreshold).neg());
          exit = z.gte(new D(cfg.exitThreshold).neg());
        }
      }
      if (selected.length) {
        const history = context.bars({
            series: source.series,
            intervalSeconds: source.intervalSeconds,
            fromCloseAt: source.historyStartCloseAt,
            toCloseAt: current.closeAt,
            asOf: now,
          }),
          byId = new Map(history.map((b) => [b.id, b]));
        for (const id of new Set(selected.flatMap((f) => f.inputBarIds))) {
          const b = byId.get(id),
            m = b ? this.#eligibility.bar(b, now) : null;
          if (b) used.set(id, b);
          if (!b || !m) {
            valid = false;
            reason = 'HISTORICAL_INPUT_INELIGIBLE';
          } else metadata.add(m.id);
        }
      }
    }
    const liquid = new D(current.volume).gte(cfg.minimumBaseVolume);
    if (currentMeta !== null) {
      if (
        state.position !== 'FLAT' &&
        cfg.kind !== 'BUY_AND_HOLD' &&
        (next.heldBars >= cfg.maxHoldingBars ||
          (!valid && cfg.onMissing === 'EXIT') ||
          (valid && (state.position === 'LONG' ? exit : shortExit)))
      ) {
        const maxHeld = next.heldBars >= cfg.maxHoldingBars;
        action = state.position === 'LONG' ? 'EXIT_LONG' : 'EXIT_SHORT';
        next.position = 'FLAT';
        next.cooldown = cfg.cooldownBars;
        next.heldBars = 0;
        reason = maxHeld ? 'MAX_HOLD_EXIT' : !valid ? 'MISSING_FEATURE_EXIT' : 'POLICY_EXIT';
        if (cfg.kind === 'SYMMETRIC_MA_FIXTURE') relation = null;
      } else if (state.position === 'FLAT' && state.cooldown > 0) {
        next.cooldown = state.cooldown - 1;
        reason = 'COOLDOWN';
        if (cfg.kind === 'SYMMETRIC_MA_FIXTURE') relation = null;
      } else if (valid && liquid && state.position === 'FLAT') {
        if (entry) {
          action = 'ENTER_LONG';
          next.position = 'LONG';
          next.heldBars = 0;
        } else if (cfg.kind === 'SYMMETRIC_MA_FIXTURE' && shortEntry) {
          action = 'ENTER_SHORT';
          next.position = 'SHORT';
          next.heldBars = 0;
        }
      } else if (valid && !liquid) reason = 'LOW_BASE_VOLUME';
    }
    // An ineligible window must not consume a crossover that was never actionable.
    if (!valid && (cfg.kind === 'MA_CROSSOVER' || cfg.kind === 'SYMMETRIC_MA_FIXTURE'))
      relation = null;
    next.previousRelation = relation;
    let maxAvailable = current.availableAt!,
      maxClose = current.closeAt;
    for (const b of used.values()) {
      maxAvailable = max(maxAvailable, b.availableAt!);
      maxClose = max(maxClose, b.closeAt);
    }
    for (const id of metadata) {
      const m = source.market.instruments.find((m) => m.id === id)!;
      maxAvailable = max(maxAvailable, m.availableAt!);
    }
    const decision = MarketDecisionSchema.parse({
      schemaVersion: 'market-decision.v1',
      featureAsOf: now,
      closeAt: current.closeAt,
      action,
      previous: state.position,
      target: next.position,
      reason,
      inputBarIds: [...used.keys()].sort(),
      inputMetadataIds: [...metadata].sort(),
      maxInputAvailableAt: maxAvailable,
      maxInputCloseAt: maxClose,
      features,
      featureFingerprint: this.featureFingerprint,
    });
    next.lastDecision = decision;
    deepFreeze(next);
    return { state: next, decision };
  }
  strategy(): MarketStrategy {
    return {
      descriptor: this.descriptor,
      initialState: () => this.initialState(),
      onEvent: (event, context, state) => {
        const result = this.evaluate(event, context, state),
          d = result.decision;
        if (!d) return { state: result.state, candidates: [] };
        const side =
          d.action === 'ENTER_LONG' || d.action === 'EXIT_SHORT'
            ? 'LONG'
            : d.action === 'EXIT_LONG' || d.action === 'ENTER_SHORT'
              ? 'SHORT'
              : 'HOLD';
        return {
          state: result.state,
          candidates: [
            {
              symbol: this.source.series.instrumentId,
              side,
              horizon: { value: this.config.signalValiditySeconds, unit: 'seconds' },
              score: {
                status: 'KNOWN',
                value: d.target === 'LONG' ? 1 : d.target === 'SHORT' ? -1 : 0,
              },
              calibration: {
                status: 'MISSING',
                reason: 'Target-state code only; not confidence or a calibrated prediction',
              },
              rationaleIds: d.inputBarIds,
            },
          ],
        };
      },
    };
  }
}
export function createMarketStrategy(config: unknown, source: unknown) {
  return () => new MarketSignalProvider(config, source).strategy();
}
export const MarketSignalProvider = RuleMarketSignalProvider;
