import { describe, it, expect, vi } from 'vitest';
import { LiveRunSchema, LiveQuerySchema } from '@crypto/contracts';
import { stepLiveRun, liveSummaries, liveBookFill, liveSignal } from '@crypto/paper';
import {
  freshLiveBook,
  parseLiveBook,
  parseLiveBars,
  parseLiveInstrument,
  livePath,
  fetchLivePublic,
} from '@crypto/connectors';
import { liveExport } from '../apps/api/src/live-paper.js';
import {
  liveTestRun,
  liveTestMarket,
  liveTestSource,
  LIVE_TEST_TIME as T,
  testProfiles,
} from './helpers/live-paper.js';
function pending(side: 'LONG' | 'SHORT', at = T) {
  return {
    side,
    createdAt: at,
    expiresAt: at + 90000,
    atr: '1',
    stopAtr: '2.5',
    targetAtr: '5',
    volume: '10000',
    decision: { origin: 'SYNTHETIC' },
  };
}
describe('forward paper accounting and causality', () => {
  it('proposes only a newly completed hourly crossover, then fills a later book', () => {
    const { run } = liveTestRun(),
      now = T + 3600000 + 5000,
      m = liveTestMarket(now, 'BINANCE', 'SOL', 300);
    m.bars!.bars = m.bars!.bars.map((b, i) => {
      const close = i === 298 ? 300 : i < 240 ? 100 + i * 0.1 : 124 - (i - 240) * 0.3;
      return {
        ...b,
        at: T - (298 - i) * 3600000,
        open: String(close) as typeof b.open,
        high: String(close + 1) as typeof b.high,
        low: String(close - 1) as typeof b.low,
        close: String(close) as typeof b.close,
      };
    });
    expect(liveSignal(m.bars!.bars, 'SOL', '0.001', testProfiles.SOL)!.side).toBe('LONG');
    const decision = stepLiveRun(run, [m], now);
    expect(decision.state.positions).toHaveLength(0);
    expect(decision.state.pending['BINANCE:SOL']?.side).toBe('LONG');
    const later = { ...m, book: liveTestMarket(now + 1000, 'BINANCE', 'SOL', 300).book };
    expect(stepLiveRun(decision.state, [later], now + 1000).state.positions).toHaveLength(1);
    expect(stepLiveRun(run, [m], now + 100000).state.positions).toHaveLength(0);
    expect(stepLiveRun(run, [m], now + 100000).state.pending).toEqual({});
  });
  it('does not trade the warmup history and waits for a fresh post-decision quote', () => {
    const { run, markets } = liveTestRun();
    expect(stepLiveRun(run, markets, T).state.positions).toHaveLength(0);
    run.pending['BINANCE:SOL'] = pending('LONG');
    expect(stepLiveRun(run, markets, T).state.positions).toHaveLength(0);
    const result = stepLiveRun(run, [liveTestMarket(T + 1000)], T + 1000);
    expect(result.state.positions).toHaveLength(1);
    expect(result.state.accounts[0]!.cash).not.toBe('10000');
    expect(result.state.accounts.slice(1).every((a) => a.cash === '10000')).toBe(true);
  });
  it.each(['LONG', 'SHORT'] as const)(
    'settles a %s round trip and reconciles cash, fees and realized profit',
    (side) => {
      const { run } = liveTestRun();
      run.pending['BINANCE:SOL'] = pending(side);
      const opened = stepLiveRun(run, [liveTestMarket(T + 1000)], T + 1000).state,
        p = opened.positions[0]!;
      opened.status = 'STOPPING';
      const closed = stepLiveRun(
        opened,
        [liveTestMarket(T + 3601000, 'BINANCE', 'SOL', side === 'LONG' ? 110 : 90)],
        T + 3601000,
      );
      const trade = closed.positions[0]!,
        a = closed.state.accounts[0]!;
      expect(trade.lifecycle).toBe('CLOSED');
      expect(trade.status).toBe('WIN');
      expect(closed.state.status).toBe('ENDED');
      expect(Number(a.cash) - 10000).toBeCloseTo(Number(trade.netPnl), 10);
      expect(Number(a.realized)).toBeCloseTo(Number(trade.netPnl), 10);
      expect(Number(trade.netPnl)).toBeCloseTo(
        (Number(trade.fills[1]!.price) - Number(p.entry)) *
          Number(p.quantity) *
          (side === 'LONG' ? 1 : -1) -
          Number(trade.fees) -
          Number(trade.financing),
        9,
      );
      if (side === 'SHORT')
        expect(Number(trade.financing)).toBeCloseTo((Number(p.notional) * 0.1) / 8760, 10);
    },
  );
  it('records a losing stop at the observed worse gap, never the historical stop level', () => {
    const { run } = liveTestRun();
    run.pending['BINANCE:SOL'] = pending('LONG');
    const opened = stepLiveRun(run, [liveTestMarket(T + 1000)], T + 1000).state;
    const result = stepLiveRun(opened, [liveTestMarket(T + 2000, 'BINANCE', 'SOL', 80)], T + 2000),
      p = result.positions[0]!;
    expect(p.status).toBe('LOSS');
    expect(p.exitReason).toBe('STOP');
    expect(Number(p.fills[1]!.price)).toBeLessThan(Number(p.stop));
  });
  it('retains partial close state through serialization and cannot fill the same book twice', () => {
    const { run } = liveTestRun();
    run.pending['BINANCE:SOL'] = pending('SHORT');
    const opened = stepLiveRun(run, [liveTestMarket(T + 1000)], T + 1000).state;
    opened.status = 'STOPPING';
    const market = liveTestMarket(T + 2000, 'BINANCE', 'SOL', 99, '1'),
      partial = stepLiveRun(opened, [market], T + 2000);
    expect(partial.state.positions[0]!.lifecycle).toBe('CLOSING');
    expect(Number(partial.state.positions[0]!.remaining)).toBeGreaterThan(0);
    const restored = LiveRunSchema.parse(JSON.parse(JSON.stringify(partial.state)));
    const same = stepLiveRun(restored, [market], T + 2001);
    expect(same.state.positions[0]!.fills).toHaveLength(2);
    const fresh = liveTestMarket(T + 3000, 'BINANCE', 'SOL', 99),
      resumed = stepLiveRun(restored, [fresh], T + 3000),
      direct = stepLiveRun(partial.state, [fresh], T + 3000);
    expect(resumed).toEqual(direct);
    expect(resumed.state.status).toBe('ENDED');
  });
  it('replays identical opening inputs with deterministic position identities', () => {
    const { run } = liveTestRun();
    run.pending['BINANCE:SOL'] = pending('LONG');
    const m = liveTestMarket(T + 1000);
    expect(stepLiveRun(run, [m], T + 1000)).toEqual(
      stepLiveRun(LiveRunSchema.parse(JSON.parse(JSON.stringify(run))), [m], T + 1000),
    );
  });
  it('halts entries on stale or delayed quotes and never substitutes another venue', () => {
    const { run } = liveTestRun();
    run.pending['BINANCE:SOL'] = pending('LONG');
    expect(
      stepLiveRun(run, [liveTestMarket(T + 1000, 'BYBIT')], T + 1000).state.positions,
    ).toHaveLength(0);
    const m = liveTestMarket(T + 1000);
    m.book!.source.providerAt = T - 30000;
    expect(stepLiveRun(run, [m], T + 1000).state.positions).toHaveLength(0);
    m.book!.source.providerAt = null;
    m.book!.source.requestedAt = T - 10000;
    expect(freshLiveBook(m.book!, T + 1000)).toBe(false);
  });
  it('waits for fresh quotes at the deadline and preserves the open loss estimate', () => {
    const { run } = liveTestRun();
    run.pending['BINANCE:SOL'] = pending('LONG');
    const opened = stepLiveRun(run, [liveTestMarket(T + 1000)], T + 1000).state;
    const expired = stepLiveRun(opened, [], run.deadlineAt + 1);
    expect(expired.state.status).toBe('STOPPING');
    expect(expired.state.positions[0]!.lifecycle).toBe('CLOSING');
    expect(expired.state.endedAt).toBeNull();
    expect(liveSummaries(expired.state, run.deadlineAt + 1, [])[0]!.stale).toBe(true);
    expect(
      stepLiveRun(expired.state, [liveTestMarket(run.deadlineAt + 2000)], run.deadlineAt + 2000)
        .state.status,
    ).toBe('ENDED');
  });
  it('pauses entries while continuing risk exits and expires old proposals', () => {
    const { run } = liveTestRun();
    run.pending['BINANCE:SOL'] = pending('LONG');
    const opened = stepLiveRun(run, [liveTestMarket(T + 1000)], T + 1000).state;
    opened.status = 'PAUSED';
    expect(
      stepLiveRun(opened, [liveTestMarket(T + 2000, 'BINANCE', 'SOL', 70)], T + 2000).positions[0]!
        .status,
    ).toBe('LOSS');
    expect(stepLiveRun(run, [liveTestMarket(T + 100000)], T + 100000).state.positions).toHaveLength(
      0,
    );
    expect(() => stepLiveRun(run, [], T - 1)).toThrow('Clock moved backwards');
  });
  it('caps book participation, rounds to venue lots and counts spread/slippage', () => {
    const m = liveTestMarket(T, 'BINANCE', 'SOL', 100, '1.234');
    const fill = liveBookFill(m.book!, m.instrument!, '2', true, '0.001')!;
    expect(fill.quantity).toBe('0.123');
    expect(Number(fill.price)).toBeGreaterThan(Number(m.book!.asks[0]![0]));
    expect(Number(fill.fee)).toBeCloseTo(Number(fill.notional) * 0.001, 12);
  });
  it('requires 224 hours for V6 and computes indicators using completed input only', () => {
    const m = liveTestMarket();
    expect(liveSignal(m.bars!.bars.slice(-223), 'SOL', '0.001', testProfiles.SOL)).toBeNull();
    const signal = liveSignal(m.bars!.bars, 'SOL', '0.001', testProfiles.SOL)!;
    expect(signal.side).toBeNull();
    expect(signal.metrics.fast).toBe('100');
    expect(signal.metrics.atr).toBe('4');
    expect(signal.metrics.longGate).toBe('TREND_BLOCK');
  });
});
describe('public exchange normalization', () => {
  it.each(['BINANCE', 'BYBIT', 'OKX', 'BITGET', 'MEXC'] as const)(
    'parses %s books with explicit timestamps and sequence identities',
    (exchange) => {
      const prices = { bids: [['99', '4']], asks: [['100', '5']] },
        data =
          exchange === 'BYBIT'
            ? { retCode: 0, result: { b: prices.bids, a: prices.asks, ts: T, seq: 7 } }
            : exchange === 'OKX'
              ? { code: '0', data: [{ ...prices, ts: String(T), seqId: 7 }] }
              : exchange === 'BITGET'
                ? { code: '00000', data: { ...prices, ts: String(T) } }
                : { ...prices, lastUpdateId: 7, timestamp: T };
      const b = parseLiveBook(exchange, 'SOL', data, liveTestSource());
      expect(b.source.providerAt).toBe(exchange === 'BINANCE' ? null : T);
      expect(b.bids[0]![0]).toBe('99');
      expect(livePath(exchange, 'SOL', 'book')).toMatch(/^https:\/\//);
      expect(() => parseLiveBook(exchange, 'SOL', { code: 400 }, liveTestSource())).toThrow();
    },
  );
  it('rejects crossed books, provider failures and gaps; drops unfinished candles', () => {
    expect(() =>
      parseLiveBook(
        'BINANCE',
        'SOL',
        { bids: [['100', '1']], asks: [['99', '1']], lastUpdateId: 1 },
        liveTestSource(),
      ),
    ).toThrow('Crossed');
    const row = (at: number) => [at, '100', '102', '98', '101', '8'];
    const h = Math.floor(T / 3600000) * 3600000;
    expect(
      parseLiveBars('MEXC', 'SOL', [row(h - 3600000), row(h)], liveTestSource(T + 5000)).bars,
    ).toHaveLength(1);
    expect(() =>
      parseLiveBars(
        'BINANCE',
        'SOL',
        [row(h - 10800000), row(h - 3600000)],
        liveTestSource(T + 5000),
      ),
    ).toThrow('Missing');
  });
  it('uses venue metadata and rejects a wrong symbol', () => {
    const data = {
      code: '00000',
      data: [
        {
          symbol: 'SOLUSDT',
          baseCoin: 'SOL',
          quoteCoin: 'USDT',
          status: 'online',
          pricePrecision: '2',
          quantityPrecision: '4',
          minTradeAmount: '0',
          minTradeUSDT: '1',
        },
      ],
    };
    const m = parseLiveInstrument('BITGET', 'SOL', data, liveTestSource());
    expect(m.tick).toBe('0.01');
    expect(m.step).toBe('0.0001');
    expect(() => parseLiveInstrument('BITGET', 'XRP', data, liveTestSource())).toThrow('mismatch');
  });
  it('uses GET-only fixed public hosts and rejects HTTP failures', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 429 }));
    await expect(fetchLivePublic('MEXC', 'XRP', 'book', transport)).rejects.toThrow('429');
    expect(transport.mock.calls[0]![0]).toBe(
      'https://api.mexc.com/api/v3/depth?symbol=XRPUSDT&limit=5',
    );
    expect(transport.mock.calls[0]![1]!.method).toBe('GET');
  });
});
describe('exports and query boundaries', () => {
  it('exports full fill detail in JSON and stable matching flat records in other formats', () => {
    const { run } = liveTestRun();
    run.pending['BINANCE:SOL'] = pending('LONG');
    const p = stepLiveRun(run, [liveTestMarket(T + 1000)], T + 1000).positions[0]!;
    p.exitReason = '=HYPERLINK("evil")';
    const page = { asOf: T, total: 1, page: 1, pageSize: 1, positions: [p] },
      q = LiveQuerySchema.parse({ exchange: 'BINANCE', sort: 'netPnl' });
    expect(liveExport(page, q, 'json')).toContain('"quoteId"');
    expect(liveExport(page, q, 'csv')).toContain("'=HYPERLINK");
    expect(liveExport(page, q, 'tsv')).toContain('\t');
    expect(liveExport(page, q, 'md')).toContain('Simulated');
  });
  it('rejects unbounded pages, SQL sort injection, malformed amounts and inverted dates', () => {
    for (const q of [
      { sort: 'id;DROP TABLE runs' },
      { exchange: 'OTHER' },
      { pageSize: 100000 },
      { minPnl: 'NaN' },
      { from: 10, to: 1 },
    ])
      expect(LiveQuerySchema.safeParse(q).success).toBe(false);
  });
});
