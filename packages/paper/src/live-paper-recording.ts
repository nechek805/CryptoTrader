import { z } from 'zod';
import {
  LiveRunSchema,
  LiveSourceSchema,
  LiveExchangeSchema,
  LiveAssetSchema,
  LiveControlSchema,
} from '@crypto/contracts';
import type { LiveRun } from '@crypto/contracts';
import { canonicalHash } from '@crypto/core';
import { parseLiveBook, parseLiveBars, parseLiveInstrument } from '@crypto/connectors';
import { stepLiveRun } from './live-paper-engine.js';
import type { LiveMarket } from './live-paper-engine.js';
export interface LiveRecordingReader {
  read(id?: string): Promise<LiveRun | null>;
  eventPage(
    id: string,
    after: number,
    ceiling: number,
  ): Promise<{ revision: number; previous_hash: string; hash: string; data: unknown }[]>;
  readSources(ids: string[]): Promise<unknown[]>;
}
/** Re-executes recorded inputs only; never fetches a new exchange price or submits an order. */
export async function verifyLiveRecording(reader: LiveRecordingReader, runId?: string) {
  const expected = await reader.read(runId);
  if (!expected) throw new Error('No live paper run exists');
  let replay: LiveRun | null = null,
    after = -1,
    head = '',
    closed = 0;
  const cache = new Map<string, NonNullable<LiveMarket[keyof LiveMarket]>>();
  for (;;) {
    const rows = await reader.eventPage(expected.id, after, expected.revision);
    if (!rows.length) break;
    for (const row of rows) {
      if (row.revision !== after + 1 || row.previous_hash !== head)
        throw new Error('Recorded sequence or hash chain mismatch');
      const payload = z
          .object({
            at: z.number(),
            event: z.record(z.string(), z.unknown()),
            stateHash: z.string(),
          })
          .parse(row.data),
        event = payload.event;
      if (
        canonicalHash({ runId: expected.id, revision: row.revision, previous: head, payload }) !==
        row.hash
      )
        throw new Error('Recorded event hash mismatch');
      if (event.kind === 'START') {
        if (replay || row.revision !== 0) throw new Error('Repeated recording start');
        replay = LiveRunSchema.parse(event.state);
      } else {
        if (!replay) throw new Error('Recording has no initial state');
        if (event.kind === 'CONTROL') {
          const { action } = LiveControlSchema.parse({ action: event.action });
          replay.heartbeatAt = payload.at;
          replay.status =
            action === 'PAUSE' ? 'PAUSED' : action === 'RESUME' ? 'RUNNING' : 'STOPPING';
          replay.pending = {};
        } else if (event.kind === 'TICK') {
          const refs = z
            .array(
              z.strictObject({
                exchange: LiveExchangeSchema.nullable(),
                asset: LiveAssetSchema.nullable(),
                book: z.string().nullable(),
                bars: z.string().nullable(),
                instrument: z.string().nullable(),
              }),
            )
            .max(10)
            .parse(event.markets);
          const ids = [
            ...new Set(
              refs.flatMap((r) =>
                [r.book, r.bars, r.instrument].filter((id): id is string => !!id),
              ),
            ),
          ];
          const missing = ids.filter((id) => !cache.has(id));
          const sources = new Map(
            (await reader.readSources(missing)).map((v) => {
              const s = LiveSourceSchema.parse(v);
              if (canonicalHash(s.raw) !== s.rawHash)
                throw new Error('Recorded source content hash mismatch');
              return [s.id, s];
            }),
          );
          const markets = refs.map((ref) => {
            const result: LiveMarket = { book: null, bars: null, instrument: null };
            for (const kind of ['book', 'bars', 'instrument'] as const) {
              const id = ref[kind];
              if (!id) continue;
              if (!ref.exchange || !ref.asset) throw new Error('Missing exchange identity');
              let value = cache.get(id);
              if (!value) {
                const source = sources.get(id);
                if (!source) throw new Error('Missing recorded public source');
                const body: unknown = JSON.parse(source.raw);
                value =
                  kind === 'book'
                    ? parseLiveBook(ref.exchange, ref.asset, body, source)
                    : kind === 'bars'
                      ? parseLiveBars(ref.exchange, ref.asset, body, source)
                      : parseLiveInstrument(ref.exchange, ref.asset, body, source);
                cache.set(id, value);
              }
              if (kind === 'book' && 'bids' in value) result.book = value;
              else if (kind === 'bars' && 'bars' in value) result.bars = value;
              else if (kind === 'instrument' && 'tick' in value) result.instrument = value;
              else throw new Error('Recorded source type mismatch');
            }
            return result;
          });
          const result = stepLiveRun(replay, markets, payload.at);
          if (canonicalHash(result.event) !== canonicalHash(event))
            throw new Error('Recorded decision, fill or accounting differs from replay');
          closed += result.positions.filter((p) => p.lifecycle === 'CLOSED').length;
          replay = result.state;
          for (const id of cache.keys()) if (!ids.includes(id)) cache.delete(id);
        } else throw new Error('Unknown recorded paper event');
      }
      replay.revision = row.revision;
      if (canonicalHash({ ...replay, lastEventHash: '' }) !== payload.stateHash)
        throw new Error('Replayed ledger or state hash differs');
      replay.lastEventHash = row.hash;
      head = row.hash;
      after = row.revision;
    }
  }
  if (!replay || after !== expected.revision || canonicalHash(replay) !== canonicalHash(expected))
    throw new Error('Replay does not match the persisted snapshot');
  return {
    version: 'live-paper-verification.v1',
    execution: 'SIMULATED',
    runId: expected.id,
    asOf: expected.heartbeatAt,
    revisions: after + 1,
    closed,
    open: replay.positions.length,
    hash: head,
    accounts: replay.accounts,
    verified: true,
  };
}
