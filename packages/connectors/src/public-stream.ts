import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
  StreamSequenceSchema,
  StreamConfigSchema,
  StreamInputSchema,
  StreamLevelSchema,
} from '@crypto/contracts';
import type { StreamConfig, StreamInput, StreamStep, UtcTimestamp } from '@crypto/contracts';
import { fromEpoch, utc } from '@crypto/core';

export const streamNow = (): UtcTimestamp => utc(new Date().toISOString());
export class StreamTransportError extends Error {
  constructor(
    readonly reason: 'RATE_LIMIT' | 'ACCESS_DENIED' | 'NETWORK' | 'MALFORMED',
    readonly retryAfterMs: number | null = null,
  ) {
    super(reason);
  }
}
export interface MarketStream {
  open(
    connection: number,
    receive: (input: StreamInput) => void,
    signal: AbortSignal,
  ): Promise<() => void>;
  clock(connection: number, signal: AbortSignal): Promise<StreamInput>;
  snapshot(connection: number, signal: AbortSignal): Promise<StreamInput>;
}

/** Preserve original JSON integer tokens before JavaScript can round sequence identifiers. */
export function parseStreamJson(raw: string): unknown {
  if (Buffer.byteLength(raw) > 262144) throw new StreamTransportError('MALFORMED');
  return JSON.parse(raw, (_key: string, value: unknown, context?: { source?: string }) => {
    if (typeof value === 'number') {
      if (!context?.source || !/^(0|[1-9]\d*)$/.test(context.source))
        throw new StreamTransportError('MALFORMED');
      return context.source;
    }
    return value;
  }) as unknown;
}
const depth = z.object({
  e: z.literal('depthUpdate'),
  E: StreamSequenceSchema,
  s: z.string(),
  U: StreamSequenceSchema,
  u: StreamSequenceSchema,
  b: z.array(StreamLevelSchema).max(1000),
  a: z.array(StreamLevelSchema).max(1000),
});
export function decodeBinanceDepth(
  raw: string,
  symbol: StreamConfig['symbol'],
  connection: number,
  observedAt: UtcTimestamp,
): StreamInput {
  const data = depth.parse(parseStreamJson(raw));
  if (data.s !== symbol) throw new StreamTransportError('MALFORMED');
  return StreamInputSchema.parse({
    kind: 'DELTA',
    connection,
    observedAt,
    occurredAt: fromEpoch(BigInt(data.E), 'milliseconds'),
    first: data.U,
    last: data.u,
    bids: data.b,
    asks: data.a,
    raw,
  });
}

export function retryAfterMs(value: string | null, nowMs: number): number {
  if (value === null) return 60000;
  const milliseconds = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - nowMs;
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return 60000;
  // A larger cooldown cannot be honored within a bounded session: halt instead.
  if (milliseconds > 86400000) throw new StreamTransportError('ACCESS_DENIED');
  return Math.ceil(milliseconds);
}

/** Fixed public market-data hosts, GET only, no credentials or redirect following. */
export class BinancePublicStream implements MarketStream {
  readonly config: StreamConfig;
  constructor(
    config: StreamConfig,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now = streamNow,
  ) {
    this.config = StreamConfigSchema.parse(config);
    if (this.config.provider !== 'binance-public') throw new Error('Provider mismatch');
  }
  async #get(
    path: string,
    signal: AbortSignal,
  ): Promise<{ raw: string; observedAt: UtcTimestamp }> {
    const response = await this.fetcher(`https://data-api.binance.vision${path}`, {
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 429)
        throw new StreamTransportError(
          'RATE_LIMIT',
          retryAfterMs(response.headers.get('retry-after'), Date.now()),
        );
      if (
        (response.status >= 400 && response.status < 500) ||
        (response.status >= 300 && response.status < 400)
      )
        throw new StreamTransportError('ACCESS_DENIED');
      throw new StreamTransportError('NETWORK');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new StreamTransportError('MALFORMED');
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const bytes: unknown = chunk.value;
        if (!(bytes instanceof Uint8Array)) throw new StreamTransportError('MALFORMED');
        length += bytes.length;
        if (length > 262144) throw new StreamTransportError('MALFORMED');
        chunks.push(bytes);
      }
    } finally {
      await reader.cancel();
    }
    return { raw: Buffer.concat(chunks).toString('utf8'), observedAt: this.now() };
  }
  async clock(connection: number, signal: AbortSignal): Promise<StreamInput> {
    const sentAt = this.now(),
      result = await this.#get('/api/v3/time', signal);
    const data = z.object({ serverTime: StreamSequenceSchema }).parse(parseStreamJson(result.raw));
    return StreamInputSchema.parse({
      kind: 'CLOCK',
      connection,
      ...result,
      sentAt,
      providerAt: fromEpoch(BigInt(data.serverTime), 'milliseconds'),
    });
  }
  async snapshot(connection: number, signal: AbortSignal): Promise<StreamInput> {
    const result = await this.#get(`/api/v3/depth?symbol=${this.config.symbol}&limit=100`, signal);
    const data = z
      .object({
        lastUpdateId: StreamSequenceSchema,
        bids: z.array(StreamLevelSchema).max(100),
        asks: z.array(StreamLevelSchema).max(100),
      })
      .parse(parseStreamJson(result.raw));
    return StreamInputSchema.parse({
      kind: 'SNAPSHOT',
      connection,
      ...result,
      sequence: data.lastUpdateId,
      bids: data.bids,
      asks: data.asks,
    });
  }
  async open(
    connection: number,
    receive: (input: StreamInput) => void,
    signal: AbortSignal,
  ): Promise<() => void> {
    const socket = new WebSocket(
      `wss://data-stream.binance.vision/ws/${this.config.symbol.toLowerCase()}@depth@100ms`,
    );
    const close = () => {
      if (socket.readyState < 2) socket.close();
    };
    const fault = () =>
      receive({
        kind: 'FAULT',
        reason: 'MALFORMED',
        retryAfterMs: null,
        connection,
        observedAt: this.now(),
      });
    socket.addEventListener('message', (event) => {
      try {
        if (typeof event.data !== 'string') return fault();
        receive(decodeBinanceDepth(event.data, this.config.symbol, connection, this.now()));
      } catch {
        fault();
        close();
      }
    });
    socket.addEventListener('close', () => {
      signal.removeEventListener('abort', close);
      receive({ kind: 'DISCONNECTED', connection, observedAt: this.now() });
    });
    socket.addEventListener('error', () => {
      /* The opening promise or close event handles failure. */
    });
    signal.addEventListener('abort', close, { once: true });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          close();
          reject(new StreamTransportError('NETWORK'));
        }, 3000);
        const opened = () => {
          cleanup();
          resolve();
        };
        const failed = () => {
          cleanup();
          reject(new StreamTransportError('NETWORK'));
        };
        const cleanup = () => {
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
      return close;
    } catch (error) {
      close();
      signal.removeEventListener('abort', close);
      throw error;
    }
  }
}

/** Per-session REST budget; no silent shortening of provider cooldowns. */
export class StreamRequestBudget {
  #requests: { at: number; weight: number }[] = [];
  #next = 0;
  #count = 0;
  allow(now: number, weight: number): boolean {
    if (!Number.isFinite(now) || now < 0 || !Number.isInteger(weight) || weight < 1 || weight > 100)
      throw new Error('Invalid request budget input');
    this.#requests = this.#requests.filter((r) => r.at > now - 60000);
    if (
      this.#count >= 12 ||
      now < this.#next ||
      this.#requests.reduce((n, r) => n + r.weight, 0) + weight > 100
    )
      return false;
    this.#count++;
    this.#requests.push({ at: now, weight });
    this.#next = now + 250;
    return true;
  }
  cooldown(now: number, duration: number) {
    if (
      !Number.isFinite(now) ||
      now < 0 ||
      !Number.isInteger(duration) ||
      duration < 0 ||
      duration > 86400000
    )
      throw new Error('Invalid cooldown');
    this.#next = Math.max(this.#next, now + duration);
  }
  get exhausted() {
    return this.#count >= 12;
  }
}

import { DepthStreamState } from './stream-state.js';
export async function* runMarketStream(
  configValue: StreamConfig,
  transport: MarketStream,
  durationMs = 5000,
): AsyncGenerator<StreamStep> {
  const config = StreamConfigSchema.parse(configValue);
  if (!Number.isInteger(durationMs) || durationMs < 100 || durationMs > 60000)
    throw new Error('Duration must be 100..60000 ms');
  const state = new DepthStreamState(config),
    budget = new StreamRequestBudget(),
    controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), durationMs);
  let close: (() => void) | undefined,
    connection = 0,
    retries = 0,
    reopenAt = 0,
    clockDue = 0,
    overflow = false,
    lastPacket = 0;
  const queue: StreamInput[] = [];
  const receive = (input: StreamInput) => {
    if (controller.signal.aborted) return;
    if (input.kind === 'DELTA' && input.connection === connection) lastPacket = performance.now();
    if (queue.length >= 512) overflow = true;
    else queue.push(input);
  };
  const local = (kind: 'CONNECTED' | 'DISCONNECTED' | 'TICK' | 'STOPPED'): StreamInput => ({
    kind,
    connection,
    observedAt: streamNow(),
  });
  const step = (input: StreamInput): StreamStep => ({
    schemaVersion: 'market-stream-step.v1',
    input,
    processedAt: streamNow(),
  });
  try {
    while (!controller.signal.aborted) {
      if (overflow) {
        // Preserve already received packets before recording the loss marker.
        for (const input of queue.splice(0)) {
          const event = step(input);
          state.consume(event);
          yield event;
        }
        const event = step({
          kind: 'FAULT',
          reason: 'OVERFLOW',
          retryAfterMs: null,
          connection,
          observedAt: streamNow(),
        });
        yield event;
        break;
      }
      const pending = queue.shift();
      if (pending) {
        const event = step(pending),
          view = state.consume(event);
        if (pending.kind === 'CLOCK' && view.clockOffsetNs === null)
          clockDue = performance.now() + 1000;
        yield event;
        if (view.status === 'FAULT') {
          if (
            pending.kind === 'FAULT' &&
            ['MALFORMED', 'ACCESS_DENIED', 'EXHAUSTED', 'OVERFLOW'].includes(pending.reason)
          )
            break;
        }
        continue;
      }
      if (!state.connected && performance.now() >= reopenAt) {
        if (connection > 0) {
          if (retries >= 3) {
            yield step({
              kind: 'FAULT',
              reason: 'EXHAUSTED',
              retryAfterMs: null,
              connection,
              observedAt: streamNow(),
            });
            break;
          }
          retries++;
          const wait = Math.min(4000, 250 * 2 ** (retries - 1));
          const event = step({
            kind: 'RETRY',
            attempt: retries,
            delayMs: wait,
            connection,
            observedAt: streamNow(),
          });
          state.consume(event);
          yield event;
          reopenAt = performance.now() + wait;
          await delay(wait, undefined, { signal: controller.signal });
        }
        close?.();
        connection++;
        clockDue = 0;
        try {
          close = await transport.open(connection, receive, controller.signal);
          lastPacket = performance.now();
          receive(local('CONNECTED'));
        } catch {
          receive(local('DISCONNECTED'));
        }
        continue;
      }
      const now = performance.now(),
        needClock = now >= clockDue;
      if (state.connected && now - lastPacket >= config.heartbeatAfterMs) {
        receive({
          kind: 'FAULT',
          reason: 'HEARTBEAT_TIMEOUT',
          retryAfterMs: null,
          connection,
          observedAt: streamNow(),
        });
        receive(local('DISCONNECTED'));
        close?.();
        continue;
      }
      if (state.connected && (needClock || state.needsSnapshot)) {
        if (budget.exhausted) {
          yield step({
            kind: 'FAULT',
            reason: 'EXHAUSTED',
            retryAfterMs: null,
            connection,
            observedAt: streamNow(),
          });
          break;
        }
        if (budget.allow(now, needClock ? 1 : 5)) {
          try {
            const input = needClock
              ? await transport.clock(connection, controller.signal)
              : await transport.snapshot(connection, controller.signal);
            receive(input);
            if (needClock) clockDue = performance.now() + 10000;
          } catch (error) {
            if (controller.signal.aborted) break;
            const failure =
              error instanceof StreamTransportError
                ? error
                : new StreamTransportError(
                    error instanceof z.ZodError || error instanceof SyntaxError
                      ? 'MALFORMED'
                      : 'NETWORK',
                  );
            receive({
              kind: 'FAULT',
              reason: failure.reason,
              retryAfterMs: failure.retryAfterMs,
              connection,
              observedAt: streamNow(),
            });
            if (failure.reason === 'RATE_LIMIT')
              budget.cooldown(performance.now(), failure.retryAfterMs ?? 60000);
            else if (failure.reason === 'NETWORK') {
              close?.();
              receive(local('DISCONNECTED'));
            }
          }
          continue;
        }
      }
      const event = step(local('TICK'));
      state.consume(event);
      yield event;
      await delay(100, undefined, { signal: controller.signal });
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
    close?.();
  }
  // A duration stop can interrupt REST while packets are already queued. Retain their
  // original receipt order; processing now cannot backdate their availability.
  for (const input of queue.splice(0)) yield step(input);
  yield step(local('STOPPED'));
}
