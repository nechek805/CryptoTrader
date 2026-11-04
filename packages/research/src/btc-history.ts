import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, lstat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { z } from 'zod';
import {
  BtcDatasetSchema,
  BtcHourSchema,
  HashSchema,
  NonNegativeDecimalSchema,
} from '@crypto/contracts';
import type { BtcDataset, BtcHour } from '@crypto/contracts';
import { canonicalHash, canonicalJson } from '@crypto/core';

const HOUR = 3600000,
  HOST = 'https://data-api.binance.vision';
const hash = (s: string | Uint8Array) =>
  HashSchema.parse(`sha256:${createHash('sha256').update(s).digest('hex')}`);
const Row = z.tuple([
  z.number().int(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.number().int(),
  NonNegativeDecimalSchema,
  z.number().int().nonnegative(),
  NonNegativeDecimalSchema,
  NonNegativeDecimalSchema,
  z.string(),
]);
export function sixMonthWindow(now: number) {
  const to = Math.floor(now / HOUR) * HOUR,
    end = new Date(to),
    start = new Date(to);
  start.setUTCDate(1);
  start.setUTCMonth(start.getUTCMonth() - 6);
  const lastDay = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0),
  ).getUTCDate();
  start.setUTCDate(Math.min(end.getUTCDate(), lastDay));
  return { from: start.getTime(), to };
}
export function decodeBtcBatch(body: string) {
  const rows = z
    .array(Row)
    .min(1)
    .max(1000)
    .parse(JSON.parse(body) as unknown);
  return rows.map((r) => {
    if (r[0] % HOUR || r[6] !== r[0] + HOUR - 1)
      throw new Error('Unexpected candle timestamp units or close');
    return BtcHourSchema.parse({
      at: r[0],
      open: r[1],
      high: r[2],
      low: r[3],
      close: r[4],
      volume: r[5],
    });
  });
}
async function publicGet(path: string, fetcher: typeof fetch) {
  const url = new URL(path, HOST);
  if (url.origin !== HOST || !['/api/v3/time', '/api/v3/klines'].includes(url.pathname))
    throw new Error('Public history URL rejected');
  const response = await fetcher(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
    headers: { accept: 'application/json' },
  });
  if (!response.ok || !response.body)
    throw new Error(`Public history unavailable (${response.status})`);
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2000000) throw new Error('Public history response too large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks).toString('utf8');
}
export async function downloadBtcHistory(
  progress: (text: string) => void = () => {},
  fetcher: typeof fetch = fetch,
) {
  const server = z
    .strictObject({ serverTime: z.number().int().positive() })
    .parse(JSON.parse(await publicGet('/api/v3/time', fetcher)) as unknown);
  if (Math.abs(server.serverTime - Date.now()) > 300000)
    throw new Error('Provider and local clocks disagree');
  const { from, to } = sixMonthWindow(server.serverTime),
    bars: BtcHour[] = [],
    captures: BtcDataset['captures'] = [];
  for (let at = from; at < to;) {
    if (captures.length >= 8) throw new Error('History pagination budget exceeded');
    progress(`Downloading hourly candles: ${bars.length} / ${(to - from) / HOUR}`);
    const url = `${HOST}/api/v3/klines?symbol=BTCUSDT&interval=1h&startTime=${at}&endTime=${to - 1}&limit=1000`;
    const body = await publicGet(url, fetcher),
      receivedAt = new Date().toISOString(),
      batch = decodeBtcBatch(body);
    if (batch[0]!.at !== at || batch.some((b, i) => b.at !== at + i * HOUR || b.at >= to))
      throw new Error('Missing, duplicated or out-of-range provider candles');
    captures.push({ url, receivedAt, body, hash: hash(body) });
    bars.push(...batch);
    at = batch.at(-1)!.at + HOUR;
  }
  return BtcDatasetSchema.parse({
    version: 'btc-history.v1',
    origin: 'PUBLIC_HISTORICAL',
    symbol: 'BTCUSDT',
    interval: '1h',
    from,
    to,
    capturedAt: new Date().toISOString(),
    historicalAvailability: 'UNKNOWN',
    captures,
    bars,
  });
}
export function verifyBtcDataset(input: unknown) {
  const d = BtcDatasetSchema.parse(input),
    rows: BtcHour[] = [];
  for (const c of d.captures) {
    const u = new URL(c.url);
    if (
      u.origin !== HOST ||
      u.pathname !== '/api/v3/klines' ||
      u.searchParams.get('symbol') !== 'BTCUSDT' ||
      u.searchParams.get('interval') !== '1h' ||
      c.hash !== hash(c.body) ||
      Date.parse(c.receivedAt) < d.to ||
      Date.parse(c.receivedAt) > Date.parse(d.capturedAt)
    )
      throw new Error('History provenance mismatch');
    rows.push(...decodeBtcBatch(c.body));
  }
  if (
    canonicalHash(rows) !== canonicalHash(d.bars) ||
    d.bars.length !== (d.to - d.from) / HOUR ||
    d.bars.some((b, i) => b.at !== d.from + i * HOUR)
  )
    throw new Error('History raw replay mismatch');
  return d;
}
async function bounded(path: string) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > 32000000) throw new Error('Invalid history file');
  return readFile(path);
}
export async function storeBtcDataset(root: string, input: unknown) {
  const dataset = verifyBtcDataset(input),
    id = canonicalHash(dataset),
    directory = join(resolve(root), id.slice(7));
  await mkdir(root, { recursive: true });
  try {
    await lstat(directory);
    return { id, dataset: (await loadBtcDataset(root, id)).dataset };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const stage = await import('node:fs/promises').then((fs) =>
    fs.mkdtemp(join(resolve(root), '.stage-')),
  );
  const instance = await DuckDBInstance.create(':memory:', {
    threads: '1',
    autoload_known_extensions: 'false',
    autoinstall_known_extensions: 'false',
  });
  const connection = await instance.connect();
  try {
    await connection.run(
      'CREATE TABLE candles (open_time_ms BIGINT, open VARCHAR, high VARCHAR, low VARCHAR, close VARCHAR, volume VARCHAR)',
    );
    const appender = await connection.createAppender('candles');
    try {
      for (const b of dataset.bars) {
        appender.appendBigInt(BigInt(b.at));
        for (const v of [b.open, b.high, b.low, b.close, b.volume]) appender.appendVarchar(v);
        appender.endRow();
      }
    } finally {
      appender.closeSync();
    }
    const parquet = join(stage, 'candles.parquet');
    await connection.run(
      `COPY (SELECT * FROM candles ORDER BY open_time_ms) TO '${parquet.replaceAll("'", "''")}' (FORMAT PARQUET, COMPRESSION UNCOMPRESSED)`,
    );
    const parquetHash = hash(await readFile(parquet));
    await writeFile(join(stage, 'dataset.json'), canonicalJson({ dataset, parquetHash }), {
      flag: 'wx',
    });
    await rename(stage, directory);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
  return { id, dataset };
}
export async function loadBtcDataset(root: string, idInput: string) {
  const id = HashSchema.parse(idInput),
    directory = join(resolve(root), id.slice(7));
  const parsed = z
    .strictObject({ dataset: BtcDatasetSchema, parquetHash: HashSchema })
    .parse(JSON.parse((await bounded(join(directory, 'dataset.json'))).toString()) as unknown);
  const dataset = verifyBtcDataset(parsed.dataset);
  if (
    canonicalHash(dataset) !== id ||
    hash(await bounded(join(directory, 'candles.parquet'))) !== parsed.parquetHash
  )
    throw new Error('History artifact integrity mismatch');
  return { id, dataset };
}
export async function latestBtcDataset(root: string) {
  await mkdir(root, { recursive: true });
  const names = (await readdir(root)).filter((n) => /^[a-f0-9]{64}$/.test(n)).slice(0, 100);
  const all = await Promise.all(names.map((n) => loadBtcDataset(root, `sha256:${n}`)));
  return all.sort((a, b) => b.dataset.capturedAt.localeCompare(a.dataset.capturedAt))[0] ?? null;
}
