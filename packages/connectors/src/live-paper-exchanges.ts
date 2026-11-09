import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Decimal } from 'decimal.js';
import { canonicalHash } from '@crypto/core';
import {
  LiveBookSchema,
  LiveInstrumentSchema,
  LiveBarsSchema,
  BtcHourSchema,
} from '@crypto/contracts';
import type { LiveExchange, LiveAsset, LiveSource, LiveBook } from '@crypto/contracts';
const hosts: Record<LiveExchange, string> = {
  BINANCE: 'https://data-api.binance.vision',
  BYBIT: 'https://api.bybit.com',
  OKX: 'https://www.okx.com',
  BITGET: 'https://api.bitget.com',
  MEXC: 'https://api.mexc.com',
};
const record = (v: unknown) => z.record(z.string(), z.unknown()).parse(v);
const list = (v: unknown) => z.array(z.unknown()).parse(v);
const str = (v: unknown) => z.union([z.string(), z.number().finite()]).parse(v).toString();
const ms = (v: unknown) => z.coerce.number().int().positive().parse(v);
const pair = (a: unknown) =>
  list(a)
    .map((v) => {
      const p = list(v);
      return [str(p[0]), str(p[1])] as [string, string];
    })
    .filter((p) => new Decimal(p[1]).gt(0));
export function livePath(
  exchange: LiveExchange,
  asset: LiveAsset,
  kind: 'book' | 'bars' | 'instrument',
) {
  const symbol = asset + 'USDT';
  const paths: Record<LiveExchange, Record<typeof kind, string>> = {
    BINANCE: {
      book: `/api/v3/depth?symbol=${symbol}&limit=5`,
      bars: `/api/v3/klines?symbol=${symbol}&interval=1h&limit=300`,
      instrument: `/api/v3/exchangeInfo?symbol=${symbol}`,
    },
    BYBIT: {
      book: `/v5/market/orderbook?category=spot&symbol=${symbol}&limit=5`,
      bars: `/v5/market/kline?category=spot&symbol=${symbol}&interval=60&limit=300`,
      instrument: `/v5/market/instruments-info?category=spot&symbol=${symbol}`,
    },
    OKX: {
      book: `/api/v5/market/books?instId=${asset}-USDT&sz=5`,
      bars: `/api/v5/market/candles?instId=${asset}-USDT&bar=1H&limit=300`,
      instrument: `/api/v5/public/instruments?instType=SPOT&instId=${asset}-USDT`,
    },
    BITGET: {
      book: `/api/v2/spot/market/orderbook?symbol=${symbol}&type=step0&limit=5`,
      bars: `/api/v2/spot/market/candles?symbol=${symbol}&granularity=1h&limit=300`,
      instrument: `/api/v2/spot/public/symbols?symbol=${symbol}`,
    },
    MEXC: {
      book: `/api/v3/depth?symbol=${symbol}&limit=5`,
      bars: `/api/v3/klines?symbol=${symbol}&interval=60m&limit=300`,
      instrument: `/api/v3/exchangeInfo?symbol=${symbol}`,
    },
  };
  return hosts[exchange] + paths[exchange][kind];
}
function payload(exchange: LiveExchange, input: unknown) {
  const raw = record(input);
  if (exchange === 'BYBIT') {
    if (raw.retCode !== 0) throw new Error('Bybit public response rejected');
    return record(raw.result);
  }
  if (exchange === 'OKX') {
    if (raw.code !== '0') throw new Error('OKX public response rejected');
  }
  if (exchange === 'BITGET') {
    if (raw.code !== '00000') throw new Error('Bitget public response rejected');
  }
  if (exchange === 'MEXC' && 'code' in raw) throw new Error('MEXC public response rejected');
  return raw;
}
export function parseLiveBook(
  exchange: LiveExchange,
  asset: LiveAsset,
  input: unknown,
  source: LiveSource,
) {
  const raw = payload(exchange, input);
  const b =
    exchange === 'OKX' ? record(list(raw.data)[0]) : exchange === 'BITGET' ? record(raw.data) : raw;
  const provider = exchange === 'BINANCE' ? null : ms(b.ts ?? b.timestamp);
  const book = LiveBookSchema.parse({
    exchange,
    asset,
    source: {
      ...source,
      providerAt: provider,
      sequence: str(b.seq ?? b.seqId ?? b.lastUpdateId ?? b.ts),
    },
    bids: pair(b.bids ?? b.b),
    asks: pair(b.asks ?? b.a),
  });
  if (new Decimal(book.bids[0]![0]).gte(book.asks[0]![0]))
    throw new Error('Crossed public book rejected');
  for (const [levels, sign] of [
    [book.bids, -1],
    [book.asks, 1],
  ] as const)
    if (levels.some((p, i) => i > 0 && new Decimal(p[0]).cmp(levels[i - 1]![0]) !== sign))
      throw new Error('Unordered public book');
  return book;
}
export function parseLiveBars(
  exchange: LiveExchange,
  asset: LiveAsset,
  input: unknown,
  source: LiveSource,
) {
  let rows: unknown[];
  if (exchange === 'BINANCE' || exchange === 'MEXC') rows = list(input);
  else {
    const p = payload(exchange, input);
    rows = list(exchange === 'BYBIT' ? p.list : p.data);
  }
  const bars = rows
    .filter((v) => exchange !== 'OKX' || list(v)[8] === '1')
    .map((v) => {
      const p = list(v);
      return BtcHourSchema.parse({
        at: ms(p[0]),
        open: str(p[1]),
        high: str(p[2]),
        low: str(p[3]),
        close: str(p[4]),
        volume: str(p[5]),
      });
    })
    .filter((b) => b.at % 3600000 === 0 && b.at + 3600000 + 3000 <= source.receivedAt)
    .sort((a, b) => a.at - b.at);
  if (
    new Set(bars.map((b) => b.at)).size !== bars.length ||
    bars.some((b, i) => i > 0 && b.at !== bars[i - 1]!.at + 3600000)
  )
    throw new Error('Missing or duplicate completed hourly candles');
  return LiveBarsSchema.parse({ exchange, asset, source, bars });
}
export function parseLiveInstrument(
  exchange: LiveExchange,
  asset: LiveAsset,
  input: unknown,
  source: LiveSource,
) {
  const raw = payload(exchange, input);
  const rows = list(
    exchange === 'BYBIT'
      ? raw.list
      : exchange === 'OKX' || exchange === 'BITGET'
        ? raw.data
        : raw.symbols,
  );
  const b = record(rows[0]);
  if (
    (b.symbol ?? b.instId) !== (exchange === 'OKX' ? asset + '-USDT' : asset + 'USDT') ||
    (b.baseAsset ?? b.baseCoin ?? b.baseCcy) !== asset ||
    (b.quoteAsset ?? b.quoteCoin ?? b.quoteCcy) !== 'USDT'
  )
    throw new Error('Instrument mismatch');
  if (!['TRADING', 'Trading', 'live', 'online', '1'].includes(str(b.status ?? b.state)))
    throw new Error('Instrument unavailable');
  let tick: string, step: string, minQty: string, minNotional: string;
  const precision = (n: unknown) =>
    new Decimal(10).pow(-z.coerce.number().int().min(0).max(18).parse(n)).toFixed();
  if (exchange === 'BINANCE') {
    const filters = list(b.filters).map(record),
      f = (key: string) => {
        const row = filters.find((r) => r.filterType === key);
        if (!row) throw new Error('Missing exchange filter');
        return row;
      };
    tick = str(f('PRICE_FILTER').tickSize);
    step = str(f('LOT_SIZE').stepSize);
    minQty = str(f('LOT_SIZE').minQty);
    minNotional = str(
      filters.find((f) => f.filterType === 'NOTIONAL' || f.filterType === 'MIN_NOTIONAL')
        ?.minNotional,
    );
  } else if (exchange === 'BYBIT') {
    const lot = record(b.lotSizeFilter);
    tick = str(record(b.priceFilter).tickSize);
    step = str(lot.basePrecision);
    minQty = str(lot.minOrderQty);
    minNotional = str(lot.minOrderAmt);
  } else if (exchange === 'OKX') {
    tick = str(b.tickSz);
    step = str(b.lotSz);
    minQty = str(b.minSz);
    minNotional = '5';
  } else if (exchange === 'BITGET') {
    tick = precision(b.pricePrecision);
    step = precision(b.quantityPrecision);
    minQty = Decimal.max(str(b.minTradeAmount), step).toFixed();
    minNotional = str(b.minTradeUSDT);
  } else {
    tick = precision(b.quotePrecision);
    step = precision(b.baseAssetPrecision);
    minQty = Decimal.max(step, str(b.baseSizePrecision)).toFixed();
    minNotional = str(b.quoteAmountPrecisionMarket ?? b.quoteAmountPrecision);
  }
  return LiveInstrumentSchema.parse({ exchange, asset, tick, step, minQty, minNotional, source });
}
export async function fetchLivePublic(
  exchange: LiveExchange,
  asset: LiveAsset,
  kind: 'book' | 'bars' | 'instrument',
  transport: typeof fetch = fetch,
) {
  const requestedAt = Date.now(),
    url = livePath(exchange, asset, kind);
  const response = await transport(url, {
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
    headers: { accept: 'application/json' },
  });
  if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 2000000)
    throw new Error(`Public ${kind} HTTP ${response.status}`);
  let raw = '';
  if (!response.body) throw new Error('Empty public response');
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = z.instanceof(Uint8Array).parse(next.value);
      bytes += chunk.byteLength;
      if (bytes > 2000000) throw new Error('Public response too large');
      raw += decoder.decode(chunk, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    await reader.cancel();
  }
  const receivedAt = Date.now();
  const source: LiveSource = {
    id: randomUUID(),
    url,
    requestedAt,
    receivedAt,
    providerAt: null,
    sequence: '',
    rawHash: canonicalHash(raw),
    raw,
  };
  const input: unknown = JSON.parse(raw);
  return kind === 'book'
    ? parseLiveBook(exchange, asset, input, source)
    : kind === 'bars'
      ? parseLiveBars(exchange, asset, input, source)
      : parseLiveInstrument(exchange, asset, input, source);
}
export function freshLiveBook(book: LiveBook, now: number) {
  const s = book.source;
  return (
    s.receivedAt <= now &&
    now - s.receivedAt <= 15000 &&
    s.receivedAt >= s.requestedAt &&
    s.receivedAt - s.requestedAt <= 3000 &&
    (s.providerAt === null ||
      (s.providerAt <= s.receivedAt + 2000 && s.receivedAt - s.providerAt <= 15000))
  );
}
