import { mkdir, lstat, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonicalHash } from '@crypto/core';
import { MarketAssetSchema, MarketCaptureSchema } from '../../contracts/src/market-tests.js';
import { BtcHourSchema } from '../../contracts/src/btc-test.js';
import { HashSchema } from '../../contracts/src/primitives.js';
import type { V3Event, MinuteDiagnostic } from '../../contracts/src/news-research-v3.js';
import type { ResearchPlan } from '../../contracts/src/news-research.js';
import { MARKET_ASSETS } from '../../contracts/src/market-tests.js';
import { marketPublicGet, marketByteHash } from './market-test-history.js';

const MINUTE = 60000,
  HOUR = 3600000;
const Window = z.strictObject({
  version: z.literal('news-minute-window.v1'),
  origin: z.literal('PUBLIC_HISTORICAL'),
  asset: MarketAssetSchema,
  from: z.number().int(),
  to: z.number().int(),
  capture: MarketCaptureSchema,
  bars: z.array(BtcHourSchema).min(1).max(120),
});
export function decodeNewsMinuteBars(body: string, from: number, to: number) {
  const rows = z
    .array(z.array(z.union([z.string(), z.number()])).length(12))
    .min(1)
    .max(120)
    .parse(JSON.parse(body) as unknown);
  const bars = rows.map((r, i) => {
    const at = z.number().int().parse(r[0]);
    if (at !== from + i * MINUTE || r[6] !== at + MINUTE - 1)
      throw new Error('Minute candle gap, unit or close mismatch');
    return BtcHourSchema.parse({
      at,
      open: r[1],
      high: r[2],
      low: r[3],
      close: r[4],
      volume: r[5],
    });
  });
  if (bars.length !== (to - from) / MINUTE) throw new Error('Incomplete minute reaction window');
  return bars;
}
function verifyWindow(input: unknown) {
  const w = Window.parse(input),
    u = new URL(w.capture.url);
  if (
    u.origin !== 'https://data-api.binance.vision' ||
    u.pathname !== '/api/v3/klines' ||
    u.searchParams.get('symbol') !== w.asset + 'USDT' ||
    u.searchParams.get('interval') !== '1m' ||
    Number(u.searchParams.get('startTime')) !== w.from ||
    Number(u.searchParams.get('endTime')) !== w.to - 1 ||
    w.capture.hash !== marketByteHash(w.capture.body) ||
    Date.parse(w.capture.receivedAt) < w.to ||
    canonicalHash(w.bars) !== canonicalHash(decodeNewsMinuteBars(w.capture.body, w.from, w.to))
  )
    throw new Error('Minute window provenance mismatch');
  return w;
}
export function selectNewsMinuteWindows(events: V3Event[], plan: ResearchPlan) {
  const selections: { asset: (typeof MARKET_ASSETS)[number]; event: V3Event }[] = [],
    used = new Set<string>();
  const candidates = events
    .filter(
      (e) =>
        e.publishedAt !== null &&
        e.publishedAt >= plan.from &&
        e.publishedAt + 66 * MINUTE < plan.to &&
        !['HOLD_PERMISSION', 'HOLD_IRRELEVANT', 'HOLD_UNDATED', 'HOLD_DUPLICATE'].includes(e.gate),
    )
    .sort((a, b) => a.publishedAt! - b.publishedAt! || a.id.localeCompare(b.id));
  // Round-robin, selected by time and taxonomy, never by subsequent returns.
  for (let round = 0; round < 3; round++)
    for (const asset of MARKET_ASSETS) {
      const pool = candidates.filter((e) => e.assets.includes(asset) && !used.has(asset + e.id));
      const event =
        pool.find(
          (e) =>
            round === 0 || !selections.some((s) => s.asset === asset && s.event.group === e.group),
        ) ?? pool[0];
      if (event && selections.length < 24) {
        selections.push({ asset, event });
        used.add(asset + event.id);
      }
    }
  return selections;
}
export async function collectNewsMinuteDiagnostics(
  root: string,
  events: V3Event[],
  plan: ResearchPlan,
  progress: (s: string) => Promise<void> = async () => {},
  transport: typeof marketPublicGet = marketPublicGet,
): Promise<MinuteDiagnostic[]> {
  const directory = join(root, 'minute-events');
  await mkdir(directory, { recursive: true });
  const result: MinuteDiagnostic[] = [];
  for (const { asset, event } of selectNewsMinuteWindows(events, plan)) {
    await progress(`${asset}: verifying a separate one-minute news-reaction window`);
    const published = event.publishedAt!,
      from = Math.floor(published / MINUTE) * MINUTE - 5 * MINUTE,
      to = from + 72 * MINUTE;
    const hourlyEntryAt = Math.ceil((published + plan.latencyMs) / HOUR) * HOUR,
      path = join(directory, `${asset}-${from}.json`);
    try {
      let window;
      try {
        const stat = await lstat(path);
        if (!stat.isFile() || stat.size > 2097152) throw new Error('Minute artifact rejected');
        const stored = z
          .object({ hash: HashSchema, window: Window })
          .parse(JSON.parse(await readFile(path, 'utf8')) as unknown);
        window = verifyWindow(stored.window);
        if (canonicalHash(window) !== stored.hash) throw new Error('Minute artifact hash mismatch');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        const capture = await transport(
          `/api/v3/klines?symbol=${asset}USDT&interval=1m&startTime=${from}&endTime=${to - 1}&limit=120`,
        );
        window = verifyWindow({
          version: 'news-minute-window.v1',
          origin: 'PUBLIC_HISTORICAL',
          asset,
          from,
          to,
          capture,
          bars: decodeNewsMinuteBars(capture.body, from, to),
        });
        const temp = path + '.' + randomUUID() + '.tmp';
        await writeFile(temp, JSON.stringify({ hash: canonicalHash(window), window }));
        await rename(temp, path);
      }
      if (window.asset !== asset || window.from !== from || window.to !== to)
        throw new Error('Minute diagnostic identity mismatch');
      const first = Math.ceil((published + plan.latencyMs) / MINUTE) * MINUTE,
        entry = window.bars.find((b) => b.at === first);
      if (!entry) throw new Error('Minute entry is absent');
      const reaction = (minutes: number) => {
        const exit = window.bars.find((b) => b.at === first + (minutes - 1) * MINUTE);
        return exit ? Number(exit.close) / Number(entry.open) - 1 : null;
      };
      result.push({
        asset,
        eventId: event.id,
        status: 'COMPLETE',
        datasetHash: canonicalHash(window),
        firstMinuteEntryAt: first,
        hourlyEntryAt,
        return5m: reaction(5),
        return15m: reaction(15),
        return60m: reaction(60),
        error: null,
      });
    } catch {
      result.push({
        asset,
        eventId: event.id,
        status: 'UNAVAILABLE',
        datasetHash: null,
        firstMinuteEntryAt: null,
        hourlyEntryAt,
        return5m: null,
        return15m: null,
        return60m: null,
        error: 'Public minute window unavailable or failed validation; no fallback data used.',
      });
    }
  }
  return result;
}
