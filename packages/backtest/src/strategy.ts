import type {
  ReplayEvent,
  ReplayState,
  ReplayStrategyDescriptor,
  ReplayIntent,
} from '@crypto/contracts';
import type { ReplayContext } from './context.js';

/** Trusted in-process code. A fresh instance and JSON state are required for each run. */
export interface Strategy {
  readonly descriptor: ReplayStrategyDescriptor;
  initialState(): unknown;
  onEvent(event: Readonly<ReplayEvent>, context: ReplayContext, state: ReplayState): unknown;
}
export type StrategyFactory = () => Strategy;
export const createNoTradeControl: StrategyFactory = () => ({
  descriptor: {
    id: 'control:no-trade',
    version: '1',
    portfolio: 'BASELINE',
    config: { policy: 'HOLD_ON_EVERY_EVENT' },
  },
  initialState: () => ({ events: 0, lastEventId: null }),
  onEvent: (event, context, state) => {
    // The event itself is observed input; no prices, news claims or performance are inferred.
    const symbol = event.kind === 'MARKET_BAR' ? event.record.instrumentId : undefined,
      candidates: ReplayIntent[] =
        symbol === undefined
          ? []
          : [
              {
                symbol,
                side: 'HOLD',
                horizon: { value: 1, unit: 'minutes' },
                score: { status: 'MISSING', reason: 'No-trade control has no forecast' },
                calibration: { status: 'MISSING', reason: 'No predictive model' },
                rationaleIds: [event.recordId],
              },
            ];
    return {
      state: {
        events: Number(state.events) + 1,
        lastEventId: event.id,
        lastDecisionAt: context.clock.now(),
      },
      candidates,
    };
  },
});
