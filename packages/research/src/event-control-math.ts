import { Decimal } from 'decimal.js';
import { DecimalStringSchema, utcNanoseconds } from '@crypto/contracts';
import type { EventStudyPricePath, EventRecovery, EventLag, UtcTimestamp } from '@crypto/contracts';
import { fromEpoch } from '@crypto/core';

export const ControlDecimal = Decimal.clone({ precision: 256, rounding: Decimal.ROUND_HALF_EVEN });
export const metric = (v: Decimal) => DecimalStringSchema.parse(v.toDecimalPlaces(36).toFixed());
export const shift = (at: UtcTimestamp, seconds: number) =>
  fromEpoch(utcNanoseconds(at) + BigInt(seconds) * 1000000000n, 'nanoseconds');
export const elapsed = (from: UtcTimestamp, to: UtcTimestamp) =>
  Number((utcNanoseconds(to) - utcNanoseconds(from)) / 1000000000n);
export function pathReturn(path: EventStudyPricePath) {
  if (path.missingCloseTimes.length || !path.bars.length) return null;
  return new ControlDecimal(path.bars.at(-1)!.close).div(path.bars[0]!.close).minus(1);
}
export function returnPoints(path: EventStudyPricePath) {
  return path.bars.flatMap((bar, i) => {
    const previous = path.bars[i - 1];
    if (!previous || elapsed(previous.closeAt, bar.closeAt) !== path.request.intervalSeconds)
      return [];
    return [
      {
        at: bar.closeAt,
        id: bar.id,
        value: new ControlDecimal(bar.close).div(previous.close).minus(1),
      },
    ];
  });
}
export function pathVolatility(path: EventStudyPricePath) {
  if (path.missingCloseTimes.length) return null;
  const squared = returnPoints(path).map((p) => p.value.plus(1).ln().pow(2));
  return ControlDecimal.sum(new ControlDecimal(0), ...squared).sqrt();
}
function moments(x: Decimal[], y: Decimal[]) {
  const n = x.length,
    mx = ControlDecimal.sum(...x).div(n),
    my = ControlDecimal.sum(...y).div(n);
  let xx = new ControlDecimal(0),
    yy = new ControlDecimal(0),
    xy = new ControlDecimal(0);
  for (let i = 0; i < n; i++) {
    const dx = x[i]!.minus(mx),
      dy = y[i]!.minus(my);
    xx = xx.plus(dx.pow(2));
    yy = yy.plus(dy.pow(2));
    xy = xy.plus(dx.mul(dy));
  }
  return { xx, yy, xy, mx, my };
}
export function fitFactor(asset: EventStudyPricePath, factor: EventStudyPricePath) {
  const a = returnPoints(asset),
    b = returnPoints(factor),
    factorTimes = new Set(b.map((p) => p.at)),
    base = {
      from: asset.request.from,
      to: asset.request.to,
      pairs: a.filter((p) => factorTimes.has(p.at)).length,
      assetBarIds: asset.bars.map((v) => v.id),
      factorBarIds: factor.bars.map((v) => v.id),
    };
  if (
    asset.missingCloseTimes.length ||
    factor.missingCloseTimes.length ||
    a.length < 3 ||
    a.length !== b.length
  )
    return { ...base, status: 'INCOMPLETE' as const, alpha: null, beta: null };
  const m = moments(
    b.map((p) => p.value),
    a.map((p) => p.value),
  );
  if (m.xx.isZero())
    return { ...base, status: 'ZERO_FACTOR_VARIANCE' as const, alpha: null, beta: null };
  const beta = m.xy.div(m.xx);
  return {
    ...base,
    status: 'FITTED' as const,
    alpha: metric(m.my.minus(beta.mul(m.mx))),
    beta: metric(beta),
  };
}
export function lagCorrelation(
  asset: EventStudyPricePath,
  factor: EventStudyPricePath,
  lagBars: number,
  segment: EventLag['segment'],
): EventLag {
  const a = new Map(returnPoints(asset).map((p) => [utcNanoseconds(p.at), p])),
    points = returnPoints(factor).flatMap((x) => {
      const y = a.get(
        utcNanoseconds(x.at) + BigInt(lagBars * factor.request.intervalSeconds) * 1000000000n,
      );
      return y ? [{ x, y }] : [];
    }),
    pairs = points.map(({ x, y }) => ({
      factorBarId: x.id,
      assetBarId: y.id,
      factorAt: x.at,
      assetAt: y.at,
      pairKnownAt: x.at > y.at ? x.at : y.at,
    })),
    base = {
      segment,
      lagBars,
      direction:
        lagBars > 0
          ? ('BTC_LEADS_ASSET' as const)
          : lagBars < 0
            ? ('ASSET_LEADS_BTC' as const)
            : ('CONTEMPORANEOUS' as const),
      pairs,
    };
  if (points.length < 3) return { ...base, status: 'INSUFFICIENT_PAIRS', correlation: null };
  const m = moments(
    points.map((p) => p.x.value),
    points.map((p) => p.y.value),
  );
  if (m.xx.isZero() || m.yy.isZero())
    return { ...base, status: 'ZERO_VARIANCE', correlation: null };
  return {
    ...base,
    status: 'COMPUTED',
    correlation: metric(
      ControlDecimal.max(-1, ControlDecimal.min(1, m.xy.div(m.xx.mul(m.yy).sqrt()))),
    ),
  };
}
export function recovery(path: EventStudyPricePath): EventRecovery {
  const empty = {
      firstBelowAt: null,
      recoveredAt: null,
      recoverySeconds: null,
      observedUntil: null,
      censorAt: null,
      censorReason: null,
    },
    start = path.bars.find((b) => b.closeAt === path.request.from);
  if (!start) return { ...empty, status: 'MISSING_ENTRY' };
  const byTime = new Map(path.bars.map((b) => [b.closeAt, b]));
  let firstBelowAt: UtcTimestamp | null = null,
    last = start.closeAt;
  const count = elapsed(start.closeAt, path.request.to) / path.request.intervalSeconds;
  for (let i = 1; i <= count; i++) {
    const at = shift(start.closeAt, i * path.request.intervalSeconds);
    const b = byTime.get(at);
    if (!b) break;
    last = at;
    if (new ControlDecimal(b.close).lt(start.close)) firstBelowAt ??= at;
    else if (firstBelowAt)
      return {
        ...empty,
        status: 'RECOVERED',
        firstBelowAt,
        recoveredAt: at,
        recoverySeconds: elapsed(start.closeAt, at),
        observedUntil: at,
      };
  }
  const reason =
    last === path.request.to
      ? ('HORIZON_END' as const)
      : shift(last, path.request.intervalSeconds) > path.request.analysisAsOf
        ? ('ANALYSIS_CUTOFF' as const)
        : ('DATA_GAP' as const);
  if (firstBelowAt)
    return {
      ...empty,
      status: 'RIGHT_CENSORED',
      firstBelowAt,
      observedUntil: last,
      censorAt: last,
      censorReason: reason,
    };
  return {
    ...empty,
    status: last === path.request.to ? 'NO_DRAWDOWN' : 'INSUFFICIENT_COVERAGE',
    observedUntil: last,
  };
}
