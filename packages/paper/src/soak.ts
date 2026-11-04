import { PaperEventSchema } from '@crypto/contracts';
import type { PaperEvent } from '@crypto/contracts';
import { canonicalHash, fromEpoch } from '@crypto/core';
import { makeDecisionRecord } from '@crypto/risk';
import { paperFixture, syntheticPaperQuote } from './fixture.js';

/** A 24-hour virtual clock, not a claim that a real provider or service was observed for a day. */
export function paperSoakFixture(codeVersion = 'synthetic:paper-soak.v1') {
  const f = paperFixture(codeVersion),
    at = (s: number) => fromEpoch(1767225600n + BigInt(s), 'seconds'),
    news = {
      id: 'synthetic:news-heartbeat',
      licenseReviewHash: canonicalHash('synthetic:news-license'),
      validUntil: at(2678400),
      heartbeatTtlSeconds: 3600,
    },
    config = {
      ...f.config,
      newsSources: [news],
      runManifestHash: canonicalHash({
        origin: 'SYNTHETIC',
        recipe: 'paper-soak.v1',
        config: f.config,
        news,
      }),
    },
    events: PaperEvent[] = [],
    push = (e: unknown) => events.push(PaperEventSchema.parse(e)),
    safety = (s: number, code: string, source = config.source.id) =>
      push({
        kind: 'SAFETY',
        id: `synthetic:safety:${s}:${code}`,
        at: at(s),
        code,
        sourceId: source,
        rawHash: null,
      }),
    heartbeat = (s: number) =>
      push({
        kind: 'HEARTBEAT',
        id: `synthetic:news-heartbeat:${s}`,
        at: at(s),
        sourceId: news.id,
        licenseReviewHash: news.licenseReviewHash,
        healthy: true,
      });
  heartbeat(60);
  events.push(
    ...f.events.map((e) =>
      e.kind === 'PROPOSE'
        ? {
            ...e,
            decision: makeDecisionRecord(
              e.decision.policy,
              { ...e.decision.request, runManifestHash: config.runManifestHash },
              codeVersion,
            ),
          }
        : e,
    ),
  );
  safety(90, 'MARKET_OUTAGE');
  push(syntheticPaperQuote(180, '70', '70.01'));
  push(syntheticPaperQuote(181, '65', '65.01'));
  for (let s = 240; s < 86400; s += 60) {
    if (s === 14400) safety(s, 'MARKET_OUTAGE');
    if (s === 28800) safety(s, 'NEWS_OUTAGE', news.id);
    if (s === 36000) safety(s, 'NEWS_RESTORED', news.id);
    if (s % 3600 === 0 && (s < 28800 || s >= 36000)) heartbeat(s);
    if (s === 43200) {
      const q = syntheticPaperQuote(s);
      push({ ...q, providerAt: at(s + 120) });
    } else if (s >= 14400 && s < 21600)
      push({ kind: 'TICK', id: `synthetic:outage-tick:${s}`, at: at(s) });
    else push(syntheticPaperQuote(s, '99.99', '100'));
    if (s === 72000) safety(s, 'QUARANTINED_FEED');
    if (s === 82800) safety(s, 'LICENSE_CHANGED');
  }
  push({ kind: 'RECONCILE', id: 'synthetic:day-reconcile', at: at(86400) });
  push({
    kind: 'CONTROL',
    action: 'STOP',
    actor: 'synthetic:operator',
    reason: 'End of 24-hour synthetic soak',
    id: 'synthetic:day-stop',
    at: at(86400),
  });
  return { config, events };
}
