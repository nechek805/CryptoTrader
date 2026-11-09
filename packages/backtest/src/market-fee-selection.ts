import { MarketFeesSchema, MarketMatrixSchema } from '@crypto/contracts';
import type { MarketMatrix } from '@crypto/contracts';

/** Select complete recorded scenarios: fee-sensitive eligibility/sizing are already replayed. */
export function selectMarketFees(input: unknown, feesInput: unknown): MarketMatrix {
  const matrix = MarketMatrixSchema.parse(input),
    fees = MarketFeesSchema.parse(feesInput),
    variants = matrix.feeVariants;
  if (!variants) throw new Error('Run both fee scenarios before switching saved results');
  const rows = matrix.rows.map((row) => {
    const standard = variants.STANDARD.find((r) => r.asset === row.asset),
      zero = variants.ZERO.find((r) => r.asset === row.asset);
    if (!standard || !zero) throw new Error('Incomplete fee scenario markets');
    const selected = (['V1', 'V2', 'V3'] as const).map((strategy) => ({
      strategy,
      source: fees[strategy] ? standard : zero,
    }));
    const failed = selected.find((s) => s.source.status === 'FAILED');
    if (failed) return { ...failed.source, cells: [], status: 'FAILED' as const };
    const first = selected[0]!.source;
    for (const { source } of selected)
      if (source.datasetId !== first.datasetId || source.candles !== first.candles)
        throw new Error('Fee scenarios must share one market snapshot');
    const cells = selected.map(({ strategy, source }) => {
      const cell = source.cells.find((c) => c.strategy === strategy);
      if (!cell) throw new Error('Incomplete fee scenario strategies');
      return cell;
    });
    return { ...first, cells };
  });
  const count = Object.values(fees).filter(Boolean).length;
  return MarketMatrixSchema.parse({
    ...matrix,
    rows,
    fees,
    feeMode: count === 3 ? 'STANDARD' : count === 0 ? 'ZERO' : 'MIXED',
  });
}
