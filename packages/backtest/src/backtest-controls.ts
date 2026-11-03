import { z } from 'zod';
import { utcNanoseconds } from '@crypto/contracts';
import type { BacktestManifest, ReplayIntent, SpotSimulationRequest } from '@crypto/contracts';
import { fromEpoch } from '@crypto/core';
import { SpotEvidence } from './spot-evidence.js';
import { barIntervalSeconds } from './scheduler.js';
import type { StrategyFactory } from './strategy.js';

export function backtestControl(
  manifest: BacktestManifest,
  policy: SpotSimulationRequest,
  id = manifest.strategy.id,
): StrategyFactory {
  if (
    ![
      'control:no-trade',
      'control:buy-and-hold',
      'synthetic:loss-control',
      'synthetic:future-leak',
    ].includes(id)
  )
    throw new Error('Unregistered backtest strategy');
  const config = id === manifest.strategy.id ? manifest.strategy.config : {},
    sellAfter = z.strictObject({ sellAfterEvents: z.number().int().min(3).max(100) }),
    sellAt = id === 'synthetic:loss-control' ? sellAfter.parse(config).sellAfterEvents : 0;
  if (id !== 'synthetic:loss-control') z.strictObject({}).parse(config);
  if (
    id.startsWith('synthetic:') &&
    (!manifest.input.market.sources.every((s) => s.origin === 'SYNTHETIC') ||
      [...manifest.input.replay.bars, ...manifest.input.replay.news].some(
        (r) => r.provenance.origin !== 'FIXTURE',
      ))
  )
    throw new Error('Diagnostic strategies require synthetic evidence');
  const evidence = new SpotEvidence(
    {
      schemaVersion: 'spot-simulation-input.v1',
      market: manifest.input.market,
      bars: manifest.input.replay.bars,
      commands: [],
    },
    policy,
  );
  return () => ({
    descriptor: { id, version: '1', portfolio: 'BASELINE', config },
    initialState: () => ({ events: 0, bought: false, sold: false }),
    onEvent: (event, context, state) => {
      if (id === 'synthetic:future-leak')
        context.news({ asOf: fromEpoch(utcNanoseconds(context.clock.now()) + 1n, 'nanoseconds') });
      if (
        event.kind !== 'MARKET_BAR' ||
        event.record.instrumentId !== manifest.series.instrumentId ||
        barIntervalSeconds(event.record) !== policy.intervalSeconds ||
        !evidence.bar(policy.instrumentKeys[0]!, event.record)
      )
        return { state, candidates: [] };
      const current = context.bar({ id: event.recordId, asOf: context.clock.now() }),
        events = Number(state.events) + 1;
      let side: ReplayIntent['side'] = 'HOLD',
        bought = state.bought === true,
        sold = state.sold === true;
      if (id !== 'control:no-trade' && !bought) {
        side = 'LONG';
        bought = true;
      } else if (id === 'synthetic:loss-control' && events >= sellAt && !sold) {
        side = 'SHORT';
        sold = true;
      }
      return {
        state: { events, bought, sold },
        candidates: [
          {
            symbol: manifest.series.instrumentId,
            side,
            horizon: { value: 1, unit: 'days' },
            score: {
              status: 'MISSING',
              reason: 'Transparent research control, no calibrated forecast',
            },
            calibration: { status: 'MISSING', reason: 'No predictive model' },
            rationaleIds: [current.id],
          },
        ],
      };
    },
  });
}
