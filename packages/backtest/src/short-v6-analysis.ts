import { z } from 'zod';
import {
  DirectionReportSchema,
  ShortV6ReportSchema,
  ShortV6TradeSchema,
  ShortV6ChangeSchema,
  MarketHistorySchema,
} from '@crypto/contracts';
import { D, amount } from './spot-math.js';
import { canonicalHash } from '@crypto/core';
const Report = z.union([DirectionReportSchema, ShortV6ReportSchema]);
export function analyseShortV6Trades(input: unknown, dataInput: unknown) {
  const r = Report.parse(input),
    data = MarketHistorySchema.parse(dataInput),
    rows: z.infer<typeof ShortV6TradeSchema>[] = [];
  if (r.datasetId !== canonicalHash(data) || r.asset !== data.instrument.asset)
    throw new Error('Short diagnosis history mismatch');
  let entry: (typeof r.trades)[number] | null = null;
  for (const fill of r.trades) {
    if (fill.kind === 'OPEN') {
      entry = fill;
      continue;
    }
    if (!entry || entry.quantity !== fill.quantity || entry.direction !== fill.direction)
      throw new Error('Unmatched V6 diagnosis trade');
    if (entry.direction === 'SHORT') {
      const signal = r.decisions[entry.index - 1]!,
        atr = new D(signal.atr!),
        trend = new D(signal.trend!),
        earlier = amount(
          data.bars
            .slice(entry.index - 224, entry.index - 24)
            .reduce((sum, b) => sum.plus(b.close), new D(0))
            .div(200)
            .toDecimalPlaces(12),
        ),
        before = data.bars.slice(entry.index, fill.index),
        low = before.length ? D.min(...before.map((b) => new D(b.low))) : new D(entry.price);
      rows.push(
        ShortV6TradeSchema.parse({
          entryIndex: entry.index,
          exitIndex: fill.index,
          entryAt: entry.at,
          net: fill.net!,
          fees: amount(new D(entry.fee).plus(fill.fee)),
          financing: fill.financing,
          slippage: amount(new D(entry.slippage).plus(fill.slippage)),
          reason: fill.reason,
          slopeAtr: amount(new D(earlier).minus(trend).div(atr).toDecimalPlaces(12)),
          distanceAtr: amount(
            trend
              .minus(data.bars[entry.index - 1]!.close)
              .div(atr)
              .toDecimalPlaces(12),
          ),
          mfeBeforeExitAtr: amount(new D(entry.price).minus(low).div(atr).toDecimalPlaces(12)),
        }),
      );
    }
    entry = null;
  }
  return rows;
}
export function shortV6Diagnosis(input: unknown, data: unknown) {
  const r = DirectionReportSchema.parse(input),
    rows = analyseShortV6Trades(r, data),
    wins = rows.filter((t) => new D(t.net).gt(0)),
    losses = rows.filter((t) => new D(t.net).lte(0)),
    stops = rows.filter((t) => t.reason.includes('STOP')),
    giveback = losses.filter((t) => new D(t.mfeBeforeExitAtr).gte(2.5)),
    cost = (key: 'fees' | 'financing' | 'slippage') =>
      amount(rows.reduce((s, t) => s.plus(t[key]), new D(0)));
  return [
    `${r.asset} V5 short-only: ${r.summary.netPnl} USDT net; ${rows.length} closed trades, ${wins.length} wins and ${losses.length} losses.`,
    `${stops.length} stop exits. ${giveback.length} losing trades had at least 2.5 entry ATR of favorable excursion on candles before their exit candle. These are descriptive excursions, not guaranteed executable profit.`,
    `Trading fees ${cost('fees')}, borrowing ${cost('financing')}, adverse slippage ${cost('slippage')} USDT. Net already includes all three costs; slippage is embedded in fills.`,
    r.asset === 'SOL'
      ? 'SOL inherits long-oriented targets and lacks an entry-quality candle gate. V6 tests stronger falling-MA200 slopes and shorter short targets; it keeps the successful long-side rules fixed.'
      : 'XRP short losses include repeated entries close to MA200 and extended entries far below it. V6 tests a bounded distance from MA200 and short-specific targets, keeping the V5 candle-quality and impulse filters.',
    'Candidate selection ranks only earlier short-only net profit with fees on, at least two closed trades and hourly drawdown no greater than 2%. Later checks and combined results never rank candidates. All history was already seen; this is exploratory repeated research.',
  ];
}
export function compareShortV6Trades(aInput: unknown, bInput: unknown) {
  const a = DirectionReportSchema.parse(aInput),
    b = ShortV6ReportSchema.parse(bInput);
  if (
    a.datasetId !== b.datasetId ||
    a.asset !== b.asset ||
    a.plan.mode !== b.plan.mode ||
    a.plan.feeMode !== b.plan.feeMode
  )
    throw new Error('Trade comparison requires matching history, coin, mode and costs');
  const pairs = (r: typeof a | typeof b) => {
    type Trade = (typeof r.trades)[number];
    let entry: Trade | null = null;
    const rows = new Map<string, { entry: Trade; exit: Trade }>();
    for (const t of r.trades) {
      if (t.kind === 'OPEN') entry = t;
      else {
        if (!entry) throw new Error('Unmatched comparison fill');
        rows.set(`${entry.direction}/${entry.index}`, { entry, exit: t });
        entry = null;
      }
    }
    return rows;
  };
  const old = pairs(a),
    next = pairs(b);
  return [...new Set([...old.keys(), ...next.keys()])]
    .map((key) => {
      const x = old.get(key),
        y = next.get(key),
        entry = (x ?? y)!.entry;
      return ShortV6ChangeSchema.parse({
        direction: entry.direction,
        entryIndex: entry.index,
        entryAt: entry.at,
        v5Net: x?.exit.net ?? null,
        v6Net: y?.exit.net ?? null,
        delta: amount(new D(y?.exit.net ?? 0).minus(x?.exit.net ?? 0)),
        v5Exit: x?.exit.index ?? null,
        v6Exit: y?.exit.index ?? null,
      });
    })
    .sort((x, y) => x.entryIndex - y.entryIndex);
}
