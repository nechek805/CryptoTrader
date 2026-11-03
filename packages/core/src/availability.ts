import { TemporalRecordSchema, UtcTimestampSchema } from '@crypto/contracts';
import type { TemporalRecord, UtcTimestamp } from '@crypto/contracts';
import type { z } from 'zod';
import { canonicalJson } from './canonical.js';

export type DeepReadonly<T> = T extends readonly (infer V)[]
  ? readonly DeepReadonly<V>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

export function deepFreeze<T>(value: T): DeepReadonly<T> {
  const seen = new WeakSet<object>();
  function freeze(item: unknown): void {
    if (item && typeof item === 'object' && !seen.has(item)) {
      seen.add(item);
      for (const nested of Object.values(item)) freeze(nested);
      Object.freeze(item);
    }
  }
  freeze(value);
  return value as DeepReadonly<T>;
}

export function isAvailableAt(record: TemporalRecord, decisionAt: UtcTimestamp): boolean {
  const parsed = TemporalRecordSchema.parse(record);
  const decision = UtcTimestampSchema.parse(decisionAt);
  return (
    parsed.researchUse === 'ELIGIBLE' &&
    parsed.availableAt !== null &&
    parsed.availableAt <= decision
  );
}

export type DecisionView<T> = Readonly<{
  decisionAt: UtcTimestamp;
  records: readonly DeepReadonly<T>[];
}>;

/** Validate first, clone to detach caller-owned objects, then expose only eligible snapshots. */
export function decisionView<T extends TemporalRecord>(
  schema: z.ZodType<T>,
  records: readonly unknown[],
  decisionAt: UtcTimestamp,
): DecisionView<T> {
  const decision = UtcTimestampSchema.parse(decisionAt);
  const validated = records.map((record) => {
    const detached: unknown = JSON.parse(canonicalJson(record));
    return schema.parse(detached);
  });
  const eligible = validated.filter((record) => isAvailableAt(record, decision));
  return Object.freeze({
    decisionAt: decision,
    records: Object.freeze(eligible.map((record) => deepFreeze(record))),
  });
}
