import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
  PaperConfigSchema,
  PaperEventSchema,
  StreamConfigSchema,
  StreamSequenceSchema,
  utcNanoseconds,
} from '@crypto/contracts';
import type { PaperEvent, UtcTimestamp } from '@crypto/contracts';
import { canonicalHash, deterministicId, fromEpoch } from '@crypto/core';
import {
  BinancePublicStream,
  parseStreamJson,
  runMarketStream,
  streamNow,
} from './public-stream.js';
import { DepthStreamState } from './stream-state.js';

const TradePayload = z.object({
  e: z.literal('trade'),
  E: StreamSequenceSchema,
  s: z.enum(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']),
  t: StreamSequenceSchema,
  p: z.string(),
  q: z.string(),
  T: StreamSequenceSchema,
  m: z.boolean(),
});
/** Binance public raw-trade grammar. Retains event and trade clocks separately; no account channel. */
export function decodePublicPaperTrade(
  raw: string,
  symbol: string,
  sourceId: string,
  receivedAt: UtcTimestamp,
  metadataHash: string,
): PaperEvent {
  const p = TradePayload.parse(parseStreamJson(raw));
  if (p.s !== symbol) throw new Error('Public trade symbol mismatch');
  return PaperEventSchema.parse({
    kind: 'TRADE',
    id: deterministicId('public-trade-receipt', { rawHash: canonicalHash(raw), receivedAt }),
    at: receivedAt,
    observedAt: receivedAt,
    providerAt: fromEpoch(BigInt(p.T), 'milliseconds'),
    providerEventAt: fromEpoch(BigInt(p.E), 'milliseconds'),
    sourceId,
    providerEventId: `trade:${p.t}`,
    symbol: `${p.s.slice(0, -4)}/USDT`,
    price: p.p,
    quantity: p.q,
    aggressor: p.m ? 'SELL' : 'BUY',
    rawHash: canonicalHash(raw),
    metadataHash,
  });
}

/** Market-only allowlisted sockets plus the existing sequenced, clock-checked depth transport.
 * Each session has bounded reconnect attempts; source failure is observable and never synthesizes prices.
 */
export async function* publicPaperFeed(
  configInput: unknown,
  signal: AbortSignal,
  interest: () => { activeOrders: boolean; limitOrders: boolean } = () => ({
    activeOrders: true,
    limitOrders: true,
  }),
): AsyncGenerator<PaperEvent> {
  const config = PaperConfigSchema.parse(configInput),
    interval =
      config.recordingPolicy === 'TRIAL_IDLE_120S_ACTIVE_100MS_RELEVANT_TRADES_V1'
        ? 120000000000n
        : 30000000000n,
    instrument = config.instruments[0]!,
    symbol = instrument.symbol.replace('/', ''),
    streamConfig = StreamConfigSchema.parse({
      schemaVersion: 'market-stream-config.v1',
      provider: 'binance-public',
      symbol,
    });
  if (
    config.origin !== 'PUBLIC_READ_ONLY' ||
    config.instruments.length !== 1 ||
    !config.source.approved ||
    config.source.adapterVersion !== 'binance-public-paper.v1'
  )
    throw new Error('Public paper feed is not eligible');
  const safety = (
    code: 'MARKET_OUTAGE' | 'TRADE_OUTAGE' | 'TRADE_RESTORED' | 'QUARANTINED_FEED' | 'CLOCK_SKEW',
  ): PaperEvent => {
    const at = streamNow();
    return PaperEventSchema.parse({
      id: deterministicId('public-feed-health', { code, at }),
      kind: 'SAFETY',
      at,
      code,
      sourceId: config.source.id,
      rawHash: null,
    });
  };
  let failures = 0;
  while (!signal.aborted && streamNow() < config.endAt) {
    if (streamNow() < config.startAt || streamNow() >= config.source.validUntil)
      throw new Error('Public feed outside frozen eligibility');
    const queue: PaperEvent[] = [],
      state = new DepthStreamState(streamConfig),
      socket = new WebSocket(`wss://data-stream.binance.vision/ws/${symbol.toLowerCase()}@trade`);
    let overflow = false,
      closed = false;
    const close = () => {
      if (socket.readyState < 2) socket.close();
    };
    signal.addEventListener('abort', close, { once: true });
    socket.addEventListener('message', (e) => {
      if (!interest().limitOrders) return;
      if (queue.length >= 512) {
        overflow = true;
        close();
        return;
      }
      try {
        if (typeof e.data !== 'string') throw new Error('Non-text public packet');
        queue.push(
          decodePublicPaperTrade(
            e.data,
            symbol,
            config.source.id,
            streamNow(),
            instrument.metadataHash,
          ),
        );
      } catch {
        queue.push(safety('QUARANTINED_FEED'));
        close();
      }
    });
    socket.addEventListener('close', () => {
      closed = true;
    });
    socket.addEventListener('error', () => {
      closed = true;
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error('Trade connection timeout'));
          }, 3000),
          opened = () => {
            cleanup();
            resolve();
          },
          failed = () => {
            cleanup();
            reject(new Error('Trade connection failed'));
          },
          cleanup = () => {
            clearTimeout(timer);
            socket.removeEventListener('open', opened);
            socket.removeEventListener('error', failed);
            signal.removeEventListener('abort', failed);
          };
        socket.addEventListener('open', opened, { once: true });
        socket.addEventListener('error', failed, { once: true });
        signal.addEventListener('abort', failed, { once: true });
        if (signal.aborted) failed();
      });
      yield safety('TRADE_RESTORED');
      let lastQuote = '',
        healthy = false,
        lastEmitted = 0n,
        lastTick = 0n;
      for await (const step of runMarketStream(
        streamConfig,
        new BinancePublicStream(streamConfig),
        60000,
      )) {
        if (signal.aborted || streamNow() >= config.endAt) break;
        const view = state.consume(step),
          now = step.processedAt;
        // All yielded records use processing availability, preserving earlier source receipt/provider clocks.
        for (const pending of queue.splice(0))
          yield PaperEventSchema.parse({ ...pending, at: now > pending.at ? now : pending.at });
        if (overflow || closed) {
          yield safety('TRADE_OUTAGE');
          break;
        }
        if (view.usable && view.observedAt && view.occurredAt && view.bids[0] && view.asks[0]) {
          const id = `${view.connection}/${view.sequence}/${view.observedAt}`;
          if (
            id !== lastQuote &&
            (interest().activeOrders || utcNanoseconds(now) - lastEmitted >= interval)
          ) {
            lastQuote = id;
            lastEmitted = utcNanoseconds(now);
            healthy = true;
            yield PaperEventSchema.parse({
              kind: 'QUOTE',
              id: deterministicId('public-book-receipt', { id, now }),
              at: now,
              observedAt: view.observedAt,
              providerAt: view.occurredAt,
              providerEventAt: view.occurredAt,
              sourceId: config.source.id,
              providerEventId: `depth:${id}`,
              symbol: instrument.symbol,
              bid: view.bids[0][0],
              bidQuantity: view.bids[0][1],
              ask: view.asks[0][0],
              askQuantity: view.asks[0][1],
              rawHash: canonicalHash(step),
              metadataHash: instrument.metadataHash,
            });
          }
        } else if (healthy) {
          healthy = false;
          yield safety(view.status === 'CLOCK_UNRELIABLE' ? 'CLOCK_SKEW' : 'MARKET_OUTAGE');
        }
        // A receipt clock regression is never repaired by fabricating provider time.
        if (view.observedAt && utcNanoseconds(now) < utcNanoseconds(view.observedAt)) {
          yield safety('CLOCK_SKEW');
          break;
        }
        if (utcNanoseconds(now) - lastTick >= interval) {
          lastTick = utcNanoseconds(now);
          yield PaperEventSchema.parse({
            kind: 'TICK',
            id: deterministicId('public-paper-tick', { now }),
            at: now,
          });
        }
      }
      failures = closed || overflow ? failures + 1 : 0;
      yield safety('MARKET_OUTAGE');
    } catch {
      if (!signal.aborted) {
        yield safety('MARKET_OUTAGE');
        failures++;
      }
    } finally {
      close();
      signal.removeEventListener('abort', close);
    }
    if (failures >= 3 || signal.aborted) return;
    await delay(Math.min(4000, 250 * 2 ** failures), undefined, { signal }).catch(() => {});
  }
}
