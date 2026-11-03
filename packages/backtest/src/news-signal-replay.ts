import {
  NewsSignalManifestSchema,
  NewsSignalLogSchema,
  NewsSignalReportSchema,
  NewsFreshnessSchema,
} from '@crypto/contracts';
import type { NewsSignalLog, NewsSignalManifest } from '@crypto/contracts';
import { canonicalHash, deepFreeze } from '@crypto/core';
import { NewsSignalProvider, deriveNewsFreshness } from '@crypto/strategies';
export interface NewsSignalReplaySink {
  snapshot(hash: string, snapshot: unknown): Promise<void>;
  decision(row: NewsSignalLog): Promise<void>;
}
export async function replayNewsSignals(
  input: unknown,
  codeVersion: string,
  sink?: NewsSignalReplaySink,
) {
  const manifest = NewsSignalManifestSchema.parse(input),
    decisions: NewsSignalLog[] = [],
    snapshotHashes = new Set<string>();
  let head = canonicalHash({
      schemaVersion: 'news-signal-log-genesis.v1',
      config: manifest.config,
      codeVersion,
    }),
    providerHash: string | null = null;
  for (const c of manifest.cases) {
    if (
      c.snapshot.input.graphRecords.some(
        (r) =>
          r.action.kind === 'OBSERVE' &&
          (r.action.extraction.input.article.version.document.provenance.origin !== 'FIXTURE' ||
            r.action.extraction.input.source.licensing.policy !== 'SYNTHETIC'),
      ) ||
      c.bars.some(
        (b) => b.provenance.origin !== 'FIXTURE' || !b.qualityFlags.includes('SYNTHETIC'),
      ) ||
      c.sources.some((s) => s.market.sources.some((m) => m.origin !== 'SYNTHETIC'))
    )
      throw new Error('News signal replay requires explicitly synthetic fixtures');
    if (
      c.snapshot.request.generatedAt > manifest.generatedAt ||
      new Set(c.decisionTimes).size !== c.decisionTimes.length ||
      c.decisionTimes.some(
        (t, i) => t > manifest.generatedAt || (i > 0 && t < c.decisionTimes[i - 1]!),
      ) ||
      new Set(c.sources.map((s) => s.series.instrumentId)).size !== c.sources.length
    )
      throw new Error('Invalid frozen news replay clock or source bindings');
    const provider = new NewsSignalProvider(manifest.config, c.snapshot, codeVersion);
    if (providerHash !== null && providerHash !== provider.providerHash)
      throw new Error('Incompatible news provenance policy');
    providerHash = provider.providerHash;
    let state = provider.initialState();
    for (const at of c.decisionTimes) {
      const snapshot = provider.snapshotAt(at),
        snapshotHash = canonicalHash(snapshot);
      if (!snapshotHashes.has(snapshotHash)) {
        if (sink) await sink.snapshot(snapshotHash, snapshot);
        snapshotHashes.add(snapshotHash);
      }
      const eventIds = snapshot.view.events.length
        ? snapshot.view.events.map((e) => e.identity.id).sort()
        : [null];
      for (const eventId of eventIds)
        for (const binding of manifest.config.symbols) {
          if (decisions.length >= 512) throw new Error('News replay decision work budget');
          const source = c.sources.find((s) => s.series.instrumentId === binding.symbol),
            missing = {
              schemaVersion: 'news-freshness-veto.v1',
              policy: 'VETO_ONLY_NO_DIRECTION_OR_PRICE_V1',
              symbol: binding.symbol,
              decisionAt: at,
              status: 'MISSING',
              barId: null,
              closeAt: null,
              availableAt: null,
              sourceIds: [],
              metadataIds: [],
            };
          const freshness = source
              ? deriveNewsFreshness({
                  schemaVersion: 'news-freshness-request.v1',
                  source,
                  bars: c.bars,
                  decisionAt: at,
                  maximumAgeSeconds: manifest.config.maximumMarketAgeSeconds,
                })
              : NewsFreshnessSchema.parse({ ...missing, proofHash: canonicalHash(missing) }),
            result = provider.evaluate(
              {
                schemaVersion: 'news-signal-query.v1',
                eventId,
                symbol: binding.symbol,
                decisionAt: at,
                freshness,
              },
              state,
            );
          state = result.state;
          const body = {
              sequence: decisions.length + 1,
              caseId: c.id,
              snapshotHash,
              decision: result.decision,
              previousHash: head,
            },
            row = NewsSignalLogSchema.parse({ ...body, hash: canonicalHash(body) });
          if (sink) await sink.decision(row);
          decisions.push(row);
          head = row.hash;
        }
    }
  }
  const report = NewsSignalReportSchema.parse({
    schemaVersion: 'news-signal-report.v1',
    execution: 'DISABLED',
    mode: 'POINT_IN_TIME_FIXTURE_REPLAY',
    codeVersion,
    manifest,
    manifestHash: canonicalHash(manifest),
    providerHash,
    snapshotHashes: [...snapshotHashes].sort(),
    decisions,
    logHead: head,
    counts: {
      long: decisions.filter((d) => d.decision.candidate.side === 'LONG').length,
      short: decisions.filter((d) => d.decision.candidate.side === 'SHORT').length,
      hold: decisions.filter((d) => d.decision.candidate.side === 'HOLD').length,
    },
    warnings: [
      'Conditional rule opinions are not factual verification, calibrated probabilities, expected returns, stops, orders or evidence of profitability.',
      'Only a separate timestamp/source-eligibility receipt can veto admission. Prices, returns, technical indicators and market strategies never enter news-direction rules.',
      'Declared independent/official source roles can be wrong. Reprints share origin credit; support grades count representative affirmative roots, never article copies or factual probabilities.',
      'Severity is a reported-amount policy proxy; declared expectation mismatch is not market surprise. Novelty is limited to the observed corpus.',
      'Event expiry is anchored to first-known time. Reposts cannot reset it or re-arm an already emitted opinion; fresh independent evidence or recorded corrections may change later decisions.',
      'Snapshots and candidate IDs bind only the known prefix. Future confirmations, denials and corrections cannot change earlier replayed decisions.',
      'All default incidents, articles, source roles, asset mappings, quantities, clocks and prices are SYNTHETIC. Fixture ground truth is audit-only and never read by the producer.',
      'These are deterministic decision-time event-snapshot replays, not the raw-article replay kernel, a PnL backtest, statistical news-edge model or live execution.',
    ],
  });
  deepFreeze(report);
  return report;
}
export function newsSignalMarkdown(r: Awaited<ReturnType<typeof replayNewsSignals>>) {
  return `# Conservative news-only candidates\n\nExecution DISABLED; point-in-time fixture replay. Conditional rules, no factual/return probabilities, stops, orders or PnL.\n\nManifest ${r.manifestHash}; provider ${r.providerHash}; journal ${r.logHead}.\n\nLONG ${r.counts.long}; SHORT ${r.counts.short}; HOLD ${r.counts.hold}.\n\n| Case | Decision UTC | Symbol | Candidate | Roots | Support | Severity proxy | Abstention | Snapshot |\n| --- | --- | --- | --- | ---: | --- | --- | --- | --- |\n${r.decisions.map((r) => `| ${r.caseId} | ${r.decision.candidate.decisionAt} | ${r.decision.candidate.symbol} | ${r.decision.candidate.side} | ${r.decision.opinion.independentOrigins} | ${r.decision.opinion.supportGrade} | ${r.decision.opinion.severity} | ${r.decision.abstentionReasons.join(', ')} | ${r.snapshotHash} |`).join('\n')}\n\n${r.warnings.map((w) => `- ${w}`).join('\n')}\n`;
}
export type NewsReplayManifest = NewsSignalManifest;
