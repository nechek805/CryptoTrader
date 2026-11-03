import { ReplayInputSchema, ReplayRequestSchema } from '@crypto/contracts';
import type { ReplayEvent, ReplayInput, ReplayArtifact } from '@crypto/contracts';
import { canonicalHash, deepFreeze, deterministicId } from '@crypto/core';

const units = { seconds: 1, minutes: 60, hours: 3600, days: 86400 };
export const barSeriesKey = (b: { exchange: string; instrumentId: string; marketType: string }) =>
  `${b.exchange}|${b.instrumentId}|${b.marketType}`;
export const barIntervalSeconds = (b: ReplayInput['bars'][number]) =>
  b.interval.value * units[b.interval.unit];
export const barCloseKey = (b: ReplayInput['bars'][number]) =>
  `${barSeriesKey(b)}|${barIntervalSeconds(b)}|${b.closeAt}`;
export const newsKey = (n: ReplayInput['news'][number]) => `${n.sourceId}|${n.canonicalUrl}`;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Input order has no semantic meaning; availability, kind, then original record ID do. */
export function scheduleReplayEvents(input: unknown, requestInput: unknown) {
  const parsed = ReplayInputSchema.parse(input),
    request = ReplayRequestSchema.parse(requestInput),
    events: ReplayEvent[] = [],
    exclusions: ReplayArtifact['manifest']['exclusions'] = [],
    ids = new Set<string>(),
    versions = new Set<string>();
  parsed.bars.sort((a, b) => compare(a.id, b.id));
  parsed.news.sort((a, b) => compare(a.id, b.id));
  const add = (
    kind: 'MARKET_BAR' | 'NEWS_DOCUMENT',
    record: ReplayInput['bars'][number] | ReplayInput['news'][number],
  ) => {
    const identity = record.id;
    if (ids.has(identity)) throw new Error('Duplicate replay record identity');
    ids.add(identity);
    const version =
      kind === 'MARKET_BAR'
        ? `${barCloseKey(record as ReplayInput['bars'][number])}|${record.availableAt}`
        : `${newsKey(record as ReplayInput['news'][number])}|${record.availableAt}`;
    if (versions.has(`${kind}|${version}`)) throw new Error('Ambiguous replay source revision');
    versions.add(`${kind}|${version}`);
    if (record.provenance.origin === 'FIXTURE' && !record.qualityFlags.includes('SYNTHETIC'))
      throw new Error('Replay fixtures must be labelled synthetic');
    const reason =
      record.researchUse !== 'ELIGIBLE'
        ? 'DESCRIPTIVE_ONLY'
        : record.availableAt === null
          ? 'UNKNOWN_AVAILABILITY'
          : record.availableAt >= request.endAt
            ? 'OUTSIDE_PERIOD'
            : kind === 'MARKET_BAR' &&
                !request.symbols.includes((record as ReplayInput['bars'][number]).instrumentId)
              ? 'OUTSIDE_COHORT'
              : null;
    if (reason) {
      exclusions.push({ kind, recordId: record.id, reason });
      return;
    }
    const meta = {
      id: deterministicId('replay-event', { kind, recordId: record.id }),
      kind,
      recordId: record.id,
      availableAt: record.availableAt!,
      eventAt:
        kind === 'MARKET_BAR'
          ? (record as ReplayInput['bars'][number]).closeAt
          : (record as ReplayInput['news'][number]).firstObservedAt,
      payloadHash: canonicalHash(record),
    };
    events.push(
      kind === 'MARKET_BAR'
        ? { ...meta, kind, record: record as ReplayInput['bars'][number] }
        : { ...meta, kind, record: record as ReplayInput['news'][number] },
    );
  };
  parsed.bars.forEach((b) => add('MARKET_BAR', b));
  parsed.news.forEach((n) => add('NEWS_DOCUMENT', n));
  events.sort(
    (a, b) =>
      compare(a.availableAt, b.availableAt) ||
      compare(a.kind, b.kind) ||
      compare(a.recordId, b.recordId),
  );
  deepFreeze(parsed);
  deepFreeze(request);
  deepFreeze(events);
  deepFreeze(exclusions);
  return { input: parsed, request, events, exclusions, inputHash: canonicalHash(parsed) };
}
export function replayEventMeta(event: ReplayEvent) {
  const { record: _, ...meta } = event;
  void _;
  return meta;
}
