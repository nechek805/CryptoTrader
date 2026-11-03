import { StreamConfigSchema, StreamStepSchema } from '@crypto/contracts';
import type { StreamConfig, StreamInput, StreamStep } from '@crypto/contracts';
import { fromEpoch } from '@crypto/core';

export const syntheticStreamConfig: StreamConfig = StreamConfigSchema.parse({
  schemaVersion: 'market-stream-config.v1',
  provider: 'synthetic',
  symbol: 'BTCUSDT',
});
/** Fixed synthetic receipts, including gap, recovery, duplicate, stale and disconnect. */
export function syntheticStreamSteps(): StreamStep[] {
  const time = (ms: number) => fromEpoch(1767225600000n + BigInt(ms), 'milliseconds');
  const step = (offset: number, input: Omit<StreamInput, 'observedAt'>): StreamStep =>
    StreamStepSchema.parse({
      schemaVersion: 'market-stream-step.v1',
      input: { ...input, observedAt: time(offset) },
      processedAt: time(offset),
    });
  // Inputs are validated at this boundary; strings here remain human-readable fixture literals.
  const delta = (at: number, first: string, last = first) =>
    step(at, {
      kind: 'DELTA',
      connection: 1,
      first,
      last,
      occurredAt: time(at),
      bids: [['100', '2']],
      asks: [],
      raw: `synthetic delta ${first}:${last}`,
    } as Omit<StreamInput, 'observedAt'>);
  const snapshot = (at: number, sequence: string) =>
    step(at, {
      kind: 'SNAPSHOT',
      connection: 1,
      sequence,
      bids: [
        ['100', '1'],
        ['99', '3'],
      ],
      asks: [
        ['101', '1'],
        ['102', '2'],
      ],
      raw: `synthetic snapshot ${sequence}`,
    } as Omit<StreamInput, 'observedAt'>);
  return [
    step(0, { kind: 'CONNECTED', connection: 1 }),
    step(10, {
      kind: 'CLOCK',
      connection: 1,
      sentAt: time(0),
      providerAt: time(5),
      raw: 'synthetic clock',
    } as Omit<StreamInput, 'observedAt'>),
    delta(20, '101'),
    snapshot(30, '100'),
    delta(40, '103'),
    delta(50, '102'),
    snapshot(60, '102'),
    delta(70, '103'),
    step(2200, { kind: 'TICK', connection: 1 }),
    step(2300, { kind: 'DISCONNECTED', connection: 1 }),
    step(2400, { kind: 'CONNECTED', connection: 2 }),
    step(2500, { kind: 'STOPPED', connection: 2 }),
  ];
}
