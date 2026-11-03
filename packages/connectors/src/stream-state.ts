import {
  compareDecimal,
  StreamConfigSchema,
  StreamStepSchema,
  StreamViewSchema,
  utcNanoseconds,
  UtcTimestampSchema,
} from '@crypto/contracts';
import type {
  DecimalString,
  StreamConfig,
  StreamInput,
  StreamStep,
  StreamView,
  UtcTimestamp,
} from '@crypto/contracts';
import { addDecimal, decimal, deepFreeze, fromEpoch } from '@crypto/core';

type Delta = Extract<StreamInput, { kind: 'DELTA' }>;
type Level = [DecimalString, DecimalString];
const ns = utcNanoseconds;
const ms = (value: number) => BigInt(value) * 1000000n;
const canonical = (value: DecimalString) => addDecimal(value, decimal('0'));
const sorted = (map: Map<DecimalString, DecimalString>, descending: boolean): Level[] =>
  [...map].sort((a, b) => compareDecimal(a[0], b[0]) * (descending ? -1 : 1));

/** Pure receipt-order reducer; no network, wall clock, hidden time or random state. */
export class DepthStreamState {
  readonly config: StreamConfig;
  connection = 0;
  connected = false;
  needsSnapshot = false;
  #status: StreamView['status'] = 'DISCONNECTED';
  #bids = new Map<DecimalString, DecimalString>();
  #asks = new Map<DecimalString, DecimalString>();
  #bidFloor: DecimalString | null = null;
  #askCeiling: DecimalString | null = null;
  #sequence: bigint | null = null;
  #pending: Delta[] = [];
  #bridged = false;
  #receipt: UtcTimestamp | null = null;
  #occurred: UtcTimestamp | null = null;
  #processed: UtcTimestamp | null = null;
  #lastReceipt: UtcTimestamp | null = null;
  #clock: { offset: bigint; uncertainty: bigint; at: UtcTimestamp } | null = null;
  #terminal = false;

  constructor(config: StreamConfig) {
    this.config = StreamConfigSchema.parse(config);
  }

  #clear() {
    this.#bids.clear();
    this.#asks.clear();
    this.#sequence = null;
    this.#bidFloor = null;
    this.#askCeiling = null;
    this.#bridged = false;
    this.#receipt = null;
    this.#occurred = null;
  }

  #levels(map: Map<DecimalString, DecimalString>, values: Level[], snapshot: boolean) {
    const seen = new Set<string>();
    for (const [p, q] of values) {
      const price = canonical(p),
        quantity = canonical(q);
      if (seen.has(price) || (snapshot && quantity === '0')) throw new Error('Invalid levels');
      seen.add(price);
      if (quantity === '0') map.delete(price);
      else map.set(price, quantity);
    }
    if (map.size > 1000) throw new Error('Book capacity');
  }

  #apply(delta: Delta) {
    if (this.#sequence === null || BigInt(delta.last) <= this.#sequence) return;
    if (BigInt(delta.first) > this.#sequence + 1n) {
      this.#pending.push(delta);
      this.#status = 'GAP';
      this.needsSnapshot = true;
      this.#bridged = false;
      return;
    }
    this.#levels(this.#bids, delta.bids, false);
    this.#levels(this.#asks, delta.asks, false);
    this.#sequence = BigInt(delta.last);
    this.#receipt = delta.observedAt;
    this.#occurred = delta.occurredAt;
    this.#bridged = true;
    this.#status = 'READY';
  }

  consume(value: StreamStep): StreamView {
    const step = StreamStepSchema.parse(value),
      input = step.input;
    const regressed =
      (this.#processed !== null && step.processedAt < this.#processed) ||
      (this.#lastReceipt !== null && input.observedAt < this.#lastReceipt) ||
      input.observedAt > step.processedAt;
    this.#processed = step.processedAt;
    this.#lastReceipt = input.observedAt;
    if (regressed) {
      this.#terminal = true;
      this.#status = 'FAULT';
      this.connected = false;
    }
    if (
      !this.#terminal &&
      input.kind === 'FAULT' &&
      input.connection >= this.connection &&
      ['ACCESS_DENIED', 'OVERFLOW', 'EXHAUSTED', 'MALFORMED'].includes(input.reason)
    ) {
      this.connection = input.connection;
      this.#terminal = true;
      this.connected = false;
      this.needsSnapshot = false;
      this.#status = 'FAULT';
    }
    if (!this.#terminal) {
      if (input.kind === 'STOPPED') {
        this.#terminal = true;
        this.connected = false;
        this.#status = 'STOPPED';
        this.needsSnapshot = false;
      } else if (input.kind === 'DISCONNECTED' && input.connection > this.connection) {
        this.connection = input.connection;
        this.connected = false;
        this.#status = 'DISCONNECTED';
        this.needsSnapshot = false;
      } else if (input.kind === 'CONNECTED' && input.connection > this.connection) {
        this.connection = input.connection;
        this.connected = true;
        this.#clear();
        this.#pending = [];
        this.#clock = null;
        this.needsSnapshot = true;
        this.#status = 'SYNCING';
      } else if (input.connection === this.connection) {
        try {
          if (input.kind === 'DISCONNECTED') {
            this.connected = false;
            this.#status = 'DISCONNECTED';
            this.needsSnapshot = false;
          } else if (input.kind === 'FAULT') {
            this.#status = 'FAULT';
            this.#bridged = false;
            this.needsSnapshot = this.connected;
            if (['ACCESS_DENIED', 'OVERFLOW', 'EXHAUSTED', 'MALFORMED'].includes(input.reason)) {
              this.#terminal = true;
              this.connected = false;
              this.needsSnapshot = false;
            }
          } else if (this.connected && input.kind === 'CLOCK') {
            const rtt = ns(input.observedAt) - ns(input.sentAt);
            const offset = ns(input.providerAt) - (ns(input.sentAt) + ns(input.observedAt)) / 2n;
            this.#clock =
              rtt >= 0n && rtt <= ms(1000) && offset >= -ms(5000) && offset <= ms(5000)
                ? { offset, uncertainty: rtt / 2n + ms(1), at: input.observedAt }
                : null;
          } else if (this.connected && input.kind === 'SNAPSHOT') {
            // Never expose a REST snapshot alone: wait for a bridging WebSocket event.
            this.#clear();
            this.#sequence = BigInt(input.sequence);
            this.#levels(this.#bids, input.bids, true);
            this.#levels(this.#asks, input.asks, true);
            this.#bidFloor = sorted(this.#bids, true).at(-1)?.[0] ?? null;
            this.#askCeiling = sorted(this.#asks, false).at(-1)?.[0] ?? null;
            const pending = this.#pending;
            this.#pending = [];
            this.needsSnapshot = false;
            this.#status = 'SYNCING';
            for (const delta of pending) {
              if (this.needsSnapshot) this.#pending.push(delta);
              else this.#apply(delta);
            }
          } else if (this.connected && input.kind === 'DELTA') {
            if (this.#sequence === null || this.needsSnapshot) this.#pending.push(input);
            else this.#apply(input);
            if (this.#pending.length > 256) throw new Error('Pending capacity');
          }
        } catch {
          this.#clear();
          this.#pending = [];
          this.#status = 'INVALID_BOOK';
          this.needsSnapshot = this.connected;
        }
      }
    }
    return this.#view(step.processedAt);
  }

  #view(at: UtcTimestamp): StreamView {
    const bids = sorted(this.#bids, true),
      asks = sorted(this.#asks, false);
    let status = this.#status,
      expiry: bigint | null = null;
    if (this.connected && this.#bridged && !this.needsSnapshot) {
      const bid = bids[0]?.[0],
        ask = asks[0]?.[0];
      if (
        !bid ||
        !ask ||
        !this.#bidFloor ||
        !this.#askCeiling ||
        compareDecimal(bid, ask) >= 0 ||
        compareDecimal(bid, this.#bidFloor) < 0 ||
        compareDecimal(ask, this.#askCeiling) > 0
      ) {
        status = 'INVALID_BOOK';
        this.needsSnapshot = true;
        this.#bridged = false;
      } else if (!this.#clock || ns(at) >= ns(this.#clock.at) + ms(this.config.clockTtlMs))
        status = 'CLOCK_UNRELIABLE';
      else if (this.#receipt && this.#occurred) {
        const deadlines = [
          ns(this.#receipt) + ms(this.config.staleAfterMs),
          ns(this.#clock.at) + ms(this.config.clockTtlMs),
          ns(this.#occurred) -
            this.#clock.offset -
            this.#clock.uncertainty +
            ms(this.config.staleAfterMs),
        ];
        expiry = deadlines.reduce((a, b) => (a < b ? a : b));
        status =
          ns(this.#occurred) - this.#clock.offset > ns(this.#receipt) + this.#clock.uncertainty
            ? 'CLOCK_UNRELIABLE'
            : ns(at) >= expiry
              ? 'STALE'
              : 'READY';
      }
    }
    const view = StreamViewSchema.parse({
      schemaVersion: 'market-stream-view.v1',
      provider: this.config.provider,
      symbol: this.config.symbol,
      origin: this.config.provider === 'synthetic' ? 'SYNTHETIC' : 'PUBLIC_READ_ONLY',
      sourceVersion: 'depth-stream.v1/ms',
      quality: 'ORDER_BOOK',
      depthLimited: true,
      execution: 'DISABLED',
      connection: this.connection,
      status,
      usable: status === 'READY',
      sequence: this.#sequence?.toString() ?? null,
      observedAt: this.#receipt,
      occurredAt: this.#occurred,
      availableAt: at,
      validUntil: expiry !== null && expiry >= 0n ? fromEpoch(expiry, 'nanoseconds') : null,
      clockOffsetNs: this.#clock?.offset.toString() ?? null,
      clockUncertaintyNs: this.#clock?.uncertainty.toString() ?? null,
      bids: bids.slice(0, 5),
      asks: asks.slice(0, 5),
    });
    deepFreeze(view);
    return view;
  }
}

/** A historical READY view expires even if the caller never consumes another tick. */
export function isStreamUsableAt(value: StreamView, at: UtcTimestamp): boolean {
  const view = StreamViewSchema.parse(value);
  const decisionAt = UtcTimestampSchema.parse(at);
  return (
    view.usable &&
    view.status === 'READY' &&
    view.quality === 'ORDER_BOOK' &&
    view.validUntil !== null &&
    decisionAt >= view.availableAt &&
    decisionAt < view.validUntil
  );
}
