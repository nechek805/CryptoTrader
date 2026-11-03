import { Decimal } from 'decimal.js';
import { z } from 'zod';
import { DecimalStringSchema, NonNegativeDecimalSchema, utcNanoseconds } from '@crypto/contracts';
import type {
  DatasetPanelArtifact,
  DatasetPanelRow,
  MarketClass,
  MarketMlConfig,
} from '@crypto/contracts';
import { canonicalHash } from '@crypto/core';
const D = Decimal.clone({ precision: 80 });
const labelQuery = z.strictObject({
  value: DecimalStringSchema,
  abstentionReturnBps: NonNegativeDecimalSchema,
});
export function classifyMarketReturn(input: unknown): MarketClass {
  const q = labelQuery.parse(input);
  if (new D(q.abstentionReturnBps).gt(10000)) throw new Error('Label band budget');
  const r = new D(q.value),
    b = new D(q.abstentionReturnBps).div(10000);
  return r.gt(b) ? 'UP' : r.lt(b.neg()) ? 'DOWN' : 'HOLD';
}
export type MlRow = {
  row: DatasetPanelRow;
  values: number[] | null;
  label: MarketClass;
  labelAvailableAt: NonNullable<DatasetPanelRow['labels'][number]['availableAt']>;
};
export function prepareMlRows(
  a: DatasetPanelArtifact,
  rows: readonly DatasetPanelRow[],
  cfg: MarketMlConfig,
) {
  const p = a.request;
  if (
    cfg.fitCutoff >= p.splits.validation.from ||
    cfg.calibrationCutoff >= p.splits.test.from ||
    cfg.generatedAt < a.request.generatedAt ||
    cfg.generatedAt < p.labelsAsOf ||
    !p.horizonsBars.includes(cfg.horizonBars) ||
    cfg.featureColumns.some((c) => !p.columns.includes(c))
  )
    throw new Error('Frozen temporal splits, horizon or feature schema incompatible');
  if (rows.length > 2000 || rows.length * cfg.featureColumns.length * cfg.epochs > 8000000)
    throw new Error('ML fitting work budget');
  const seen = new Set<string>();
  return rows
    .map((row) => {
      if (seen.has(row.id) || row.status !== 'INCLUDED' || row.split === null)
        throw new Error('Duplicate or excluded supervised row');
      seen.add(row.id);
      const phase =
        row.split === 'TRAIN'
          ? p.splits.train
          : row.split === 'VALIDATION'
            ? p.splits.validation
            : p.splits.test;
      const boundary =
        row.split === 'TRAIN'
          ? p.splits.validation.from
          : row.split === 'VALIDATION'
            ? p.splits.test.from
            : null;
      if (
        row.featureAsOf < phase.from ||
        row.featureAsOf >= phase.to ||
        row.maxInputAvailableAt === null ||
        row.maxInputAvailableAt > row.featureAsOf ||
        row.features.some(
          (f) =>
            f.dependency !== 'MARKET' ||
            (f.sourceKind !== 'TECHNICAL' &&
              cfg.featureColumns.includes(f.name as (typeof cfg.featureColumns)[number])) ||
            (f.maxInputAvailableAt !== null && f.maxInputAvailableAt > row.featureAsOf) ||
            (f.maxInputEventAt !== null && f.maxInputEventAt > row.featureAsOf),
        )
      )
        throw new Error('Out-of-sample feature leakage or split mismatch');
      const l = row.labels.find((l) => l.horizonBars === cfg.horizonBars);
      if (
        !l ||
        l.status !== 'READY' ||
        l.value === null ||
        l.endAt === null ||
        l.startCloseAt === null ||
        l.availableAt === null ||
        l.decisionAt === null ||
        l.endAt <= row.featureAsOf ||
        utcNanoseconds(l.endAt) - utcNanoseconds(l.startCloseAt) !==
          BigInt(cfg.horizonBars * p.intervalSeconds) * 1000000000n ||
        l.availableAt > p.labelsAsOf ||
        l.availableAt > cfg.generatedAt
      )
        throw new Error('Missing, non-future or unfrozen supervised label');
      if (boundary !== null && [l.endAt, l.decisionAt, l.availableAt].some((t) => t >= boundary))
        throw new Error('Label support touches held-out split');
      if (
        (row.split === 'TRAIN' && l.availableAt > cfg.fitCutoff) ||
        (row.split === 'VALIDATION' && l.availableAt > cfg.calibrationCutoff)
      )
        throw new Error('Label not known at fitting cutoff');
      if (
        row.split !== 'TRAIN' &&
        utcNanoseconds(row.featureAsOf) <
          utcNanoseconds(phase.from) + BigInt(p.embargoSeconds) * 1000000000n
      )
        throw new Error('Held-out embargo violated');
      const cells = cfg.featureColumns.map((name) => row.features.find((f) => f.name === name)),
        values = cells.some((f) => !f || f.value === null || f.status !== 'READY')
          ? null
          : cells.map((f) => Number(f!.value));
      if (values?.some((v) => !Number.isFinite(v) || Math.abs(v) > 1e12))
        throw new Error('Unsupported numeric feature range');
      return {
        row,
        values,
        label: classifyMarketReturn({
          value: l.value,
          abstentionReturnBps: cfg.abstentionReturnBps,
        }),
        labelAvailableAt: l.availableAt,
      };
    })
    .sort(
      (a, b) =>
        compare(a.row.featureAsOf, b.row.featureAsOf) ||
        compare(a.row.instrumentKey, b.row.instrumentKey) ||
        compare(a.row.id, b.row.id),
    );
}
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export const fittingRowsHash = (rows: readonly MlRow[]) =>
  canonicalHash(
    rows.map((r) => ({
      id: r.row.id,
      featureAsOf: r.row.featureAsOf,
      values: r.values,
      label: r.label,
      labelAvailableAt: r.labelAvailableAt,
    })),
  );
