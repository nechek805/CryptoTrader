import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, lstat, rename, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { z } from 'zod';
import {
  MARKET_ASSETS,
  MarketAssetSchema,
  MarketCaptureSchema,
  MarketInstrumentSchema,
  MarketHistorySchema,
  HashSchema,
  PositiveDecimalSchema,
  NonNegativeDecimalSchema,
  BtcHourSchema,
} from '@crypto/contracts';
import type { MarketAsset, MarketHistory } from '@crypto/contracts';
import { canonicalHash, canonicalJson } from '@crypto/core';
import { decodeBtcBatch } from './btc-history.js';

const HOST = 'https://data-api.binance.vision',
  HOUR = 3600000;
export const marketByteHash = (body: string | Uint8Array) =>
  HashSchema.parse(`sha256:${createHash('sha256').update(body).digest('hex')}`);
export async function marketPublicGet(path: string, fetcher: typeof fetch = fetch) {
  const url = new URL(path, HOST);
  if (
    url.origin !== HOST ||
    url.username ||
    url.password ||
    !['/api/v3/exchangeInfo', '/api/v3/klines'].includes(url.pathname)
  )
    throw new Error('Market research URL rejected');
  const r = await fetcher(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
    headers: { accept: 'application/json' },
  });
  if (!r.ok || !r.body) throw new Error(`Public market data unavailable (${r.status})`);
  const reader = r.body.getReader() as ReadableStreamDefaultReader<Uint8Array>,
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.length;
      if (size > 2000000) throw new Error('Market response limit');
      chunks.push(item.value);
    }
  } finally {
    await reader.cancel();
  }
  const body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  return MarketCaptureSchema.parse({
    url: url.toString(),
    body,
    receivedAt: new Date().toISOString(),
    hash: marketByteHash(body),
  });
}
export async function downloadMarketMetadata(fetcher: typeof fetch = fetch) {
  return marketPublicGet(
    '/api/v3/exchangeInfo?symbols=' +
      encodeURIComponent(JSON.stringify(MARKET_ASSETS.map((a) => a + 'USDT'))),
    fetcher,
  );
}
export function marketInstrument(capture: unknown, assetInput: unknown) {
  const c = MarketCaptureSchema.parse(capture),
    asset = MarketAssetSchema.parse(assetInput),
    url = new URL(c.url);
  if (
    url.origin !== HOST ||
    url.pathname !== '/api/v3/exchangeInfo' ||
    marketByteHash(c.body) !== c.hash
  )
    throw new Error('Instrument provenance mismatch');
  const data = z
      .object({
        symbols: z
          .array(
            z.object({
              symbol: z.string(),
              baseAsset: z.string(),
              quoteAsset: z.string(),
              status: z.string(),
              isSpotTradingAllowed: z.boolean(),
              filters: z.array(z.record(z.string(), z.unknown())),
            }),
          )
          .max(20),
      })
      .parse(JSON.parse(c.body) as unknown),
    s = data.symbols.find((s) => s.symbol === asset + 'USDT');
  if (
    !s ||
    s.baseAsset !== asset ||
    s.quoteAsset !== 'USDT' ||
    s.status !== 'TRADING' ||
    !s.isSpotTradingAllowed
  )
    throw new Error('Requested public spot instrument is unavailable');
  const price = z
    .object({ tickSize: PositiveDecimalSchema })
    .parse(s.filters.find((f) => f.filterType === 'PRICE_FILTER'));
  const lot = z
    .object({
      stepSize: PositiveDecimalSchema,
      minQty: PositiveDecimalSchema,
      maxQty: PositiveDecimalSchema,
    })
    .parse(s.filters.find((f) => f.filterType === 'LOT_SIZE'));
  const notional = z
    .object({ minNotional: NonNegativeDecimalSchema })
    .parse(s.filters.find((f) => f.filterType === 'NOTIONAL' || f.filterType === 'MIN_NOTIONAL'));
  return MarketInstrumentSchema.parse({
    asset,
    symbol: s.symbol,
    quote: 'USDT',
    filters: {
      priceTick: price.tickSize,
      quantityStep: lot.stepSize,
      minQty: lot.minQty,
      maxQty: lot.maxQty,
      minNotional: notional.minNotional,
    },
    metadata: c,
    filterAssumption: 'CURRENT_FILTERS_APPLIED_RETROSPECTIVELY',
  });
}
export function validateMarketHistory(input: unknown) {
  const d = MarketHistorySchema.parse(input);
  if (
    d.from % HOUR ||
    d.to % HOUR ||
    d.to <= d.from ||
    d.bars.length !== (d.to - d.from) / HOUR ||
    Date.parse(d.capturedAt) < d.to
  )
    throw new Error('Incomplete or unfinished market history');
  if (d.bars.some((b, i) => b.at !== d.from + i * HOUR))
    throw new Error('Missing or duplicate hourly market candles');
  if (d.referenceBtcDatasetId && d.instrument.asset !== 'BTC')
    throw new Error('Only BTC can reference the original BTC snapshot');
  return d;
}
export function verifyMarketHistory(input: unknown) {
  const d = validateMarketHistory(input),
    instrument = marketInstrument(d.instrument.metadata, d.instrument.asset);
  if (canonicalHash(instrument) !== canonicalHash(d.instrument))
    throw new Error('Instrument filters differ from captured metadata');
  const bars = [];
  for (const c of d.captures) {
    const u = new URL(c.url);
    if (
      u.origin !== HOST ||
      u.pathname !== '/api/v3/klines' ||
      u.searchParams.get('symbol') !== d.instrument.symbol ||
      u.searchParams.get('interval') !== '1h' ||
      marketByteHash(c.body) !== c.hash ||
      Date.parse(c.receivedAt) < d.to ||
      Date.parse(c.receivedAt) > Date.parse(d.capturedAt)
    )
      throw new Error('Market candle provenance mismatch');
    bars.push(...decodeBtcBatch(c.body));
  }
  if (
    canonicalHash(bars) !== canonicalHash(d.bars) ||
    Date.parse(d.instrument.metadata.receivedAt) > Date.parse(d.capturedAt) ||
    Date.parse(d.instrument.metadata.receivedAt) < d.to
  )
    throw new Error('Market raw replay mismatch');
  return d;
}
export async function downloadMarketHistory(
  asset: MarketAsset,
  from: number,
  to: number,
  metadata: unknown,
  progress: (s: string) => void = () => {},
  fetcher: typeof fetch = fetch,
) {
  const instrument = marketInstrument(metadata, asset),
    captures: MarketHistory['captures'] = [],
    bars: MarketHistory['bars'] = [];
  if (from % HOUR || to % HOUR || to <= from || (to - from) / HOUR > 6000 || to > Date.now())
    throw new Error('Invalid fixed market history range');
  for (let at = from; at < to;) {
    if (captures.length >= 8) throw new Error('Market pagination budget');
    progress(`${asset}: downloading ${bars.length}/${(to - from) / HOUR} hourly candles`);
    const c = await marketPublicGet(
        `/api/v3/klines?symbol=${instrument.symbol}&interval=1h&startTime=${at}&endTime=${to - 1}&limit=1000`,
        fetcher,
      ),
      batch = decodeBtcBatch(c.body);
    if (batch[0]!.at !== at || batch.some((b, i) => b.at !== at + i * HOUR || b.at >= to))
      throw new Error('Provider market history has gaps or extra candles');
    captures.push(c);
    bars.push(...batch);
    at = batch.at(-1)!.at + HOUR;
  }
  return verifyMarketHistory({
    version: 'market-history.v1',
    origin: 'PUBLIC_HISTORICAL',
    instrument,
    interval: '1h',
    from,
    to,
    capturedAt: new Date().toISOString(),
    historicalAvailability: 'UNKNOWN',
    captures,
    bars,
  });
}
async function bounded(path: string) {
  const s = await lstat(path);
  if (!s.isFile() || s.size > 32000000) throw new Error('Market artifact size/type rejected');
  return readFile(path);
}
const db = () =>
  DuckDBInstance.create(':memory:', {
    threads: '1',
    autoload_known_extensions: 'false',
    autoinstall_known_extensions: 'false',
  });
export async function saveMarketHistory(root: string, input: unknown) {
  const dataset = verifyMarketHistory(input),
    id = canonicalHash(dataset),
    target = join(resolve(root), id.slice(7));
  await mkdir(root, { recursive: true });
  try {
    await lstat(target);
    return loadMarketHistory(root, id);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const stage = await mkdtemp(join(resolve(root), '.stage-')),
    instance = await db(),
    c = await instance.connect();
  try {
    await c.run(
      'CREATE TABLE candles (open_time_ms BIGINT, symbol VARCHAR, open VARCHAR, high VARCHAR, low VARCHAR, close VARCHAR, volume VARCHAR)',
    );
    const appender = await c.createAppender('candles');
    try {
      for (const b of dataset.bars) {
        appender.appendBigInt(BigInt(b.at));
        for (const value of [dataset.instrument.symbol, b.open, b.high, b.low, b.close, b.volume])
          appender.appendVarchar(value);
        appender.endRow();
      }
    } finally {
      appender.closeSync();
    }
    const path = join(stage, 'candles.parquet');
    await c.run(
      `COPY (SELECT * FROM candles ORDER BY open_time_ms) TO '${path.replaceAll("'", "''")}' (FORMAT PARQUET, COMPRESSION UNCOMPRESSED)`,
    );
    await writeFile(
      join(stage, 'dataset.json'),
      canonicalJson({ dataset, parquetHash: marketByteHash(await readFile(path)) }),
      { flag: 'wx' },
    );
    await rename(stage, target);
  } finally {
    c.closeSync();
    instance.closeSync();
  }
  return { id, dataset };
}
export async function loadMarketHistory(root: string, idInput: unknown) {
  const id = HashSchema.parse(idInput),
    dir = join(resolve(root), id.slice(7)),
    raw = z
      .strictObject({ dataset: MarketHistorySchema, parquetHash: HashSchema })
      .parse(JSON.parse((await bounded(join(dir, 'dataset.json'))).toString()) as unknown),
    dataset = verifyMarketHistory(raw.dataset),
    path = join(dir, 'candles.parquet');
  if (canonicalHash(dataset) !== id || marketByteHash(await bounded(path)) !== raw.parquetHash)
    throw new Error('Market artifact integrity mismatch');
  const instance = await db(),
    c = await instance.connect();
  try {
    const result = await c.runAndReadAll(
      'SELECT CAST(open_time_ms AS VARCHAR) AS at,symbol,open,high,low,close,volume FROM read_parquet($path) ORDER BY open_time_ms LIMIT 6001',
      { path: resolve(path) },
    );
    const rows = z
      .array(
        z.object({
          at: z.string().regex(/^\d+$/),
          symbol: z.literal(dataset.instrument.symbol),
          open: PositiveDecimalSchema,
          high: PositiveDecimalSchema,
          low: PositiveDecimalSchema,
          close: PositiveDecimalSchema,
          volume: NonNegativeDecimalSchema,
        }),
      )
      .max(6000)
      .parse(result.getRowObjectsJson());
    const bars = rows.map(({ at, symbol, ...prices }) => {
      void symbol;
      return BtcHourSchema.parse({ at: Number(at), ...prices });
    });
    if (canonicalHash(bars) !== canonicalHash(dataset.bars))
      throw new Error('Market Parquet semantic replay mismatch');
  } finally {
    c.closeSync();
    instance.closeSync();
  }
  return { id, dataset };
}
