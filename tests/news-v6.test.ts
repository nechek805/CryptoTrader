import { beforeAll, it, expect } from 'vitest';
import { canonicalHash } from '@crypto/core';
import { BtcHourSchema } from '../packages/contracts/src/btc-test.js';
import { NewsV6Model, NewsV6Case } from '../packages/contracts/src/news-research-v6.js';
import type { V6Model } from '../packages/contracts/src/news-research-v6.js';
import {
  buildV6Model,
  selectNewsV6,
  v6ValidationScore,
} from '../packages/backtest/src/news-history-v6.js';
import { rerunLegacyNewsModels } from '../packages/backtest/src/news-history-v4.js';
import { newsHistoryClassify } from '../packages/research/src/news-history-study.js';
import { syntheticV5Study } from './helpers/news-v5.js';
const study = syntheticV5Study();
let model: V6Model;
beforeAll(() => {
  model = buildV6Model(study.events, study.prices, study.plan);
}, 30000);
it('reproduces the complete unchanged V2 model before comparing independent alternatives', () => {
  const old = rerunLegacyNewsModels(study.events, study.prices, study.plan)[1]!;
  expect(model.ablations[0]!.model).toEqual(old);
  expect(model.ablations).toHaveLength(4);
  expect(model.eventsHash).toBe(canonicalHash(study.events));
  expect(model.qualifiedForForwardTest).toBe(false);
}, 30000);
it('changes only the declared factor and keeps the candidate/control universe fixed', () => {
  const [base, u, g, c] = model.ablations;
  expect({ ...u!.model.config, uncertaintyZ: base!.model.config.uncertaintyZ }).toEqual(
    base!.model.config,
  );
  expect(g!.model.config).toEqual(base!.model.config);
  expect(
    g!.model.rules.map(({ side, ...r }) => {
      void side;
      return r;
    }),
  ).toEqual(
    base!.model.rules.map(({ side, ...r }) => {
      void side;
      return r;
    }),
  );
  expect(c!.model.candidates.map((x) => x.config)).toEqual(
    base!.model.candidates.map((x) => x.config),
  );
  expect(c!.model.candidates).toHaveLength(36);
  expect(c!.model.candidates.map((x) => [x.validationPnl, x.validationTrades])).toEqual(
    base!.model.candidates.map((x) => [x.validationPnl, x.validationTrades]),
  );
  expect(model.ablations.map((a) => a.changedFields.length)).toEqual([0, 1, 1, 1]);
});
it('never combines variants or selects using final prices, events or outcomes', () => {
  const original = selectNewsV6(study.events, study.prices, study.plan);
  const changed = {
    ...study.prices,
    bars: study.prices.bars.map((b) =>
      b.at >= study.plan.validationEnd
        ? BtcHourSchema.parse({ ...b, open: '1000', high: '1200', low: '800', close: '900' })
        : b,
    ),
  };
  expect(
    selectNewsV6(
      study.events.filter((e) => e.publishedAt < study.plan.validationEnd),
      changed,
      study.plan,
    ),
  ).toEqual(original);
  const candidates = model.ablations
    .filter((a) => a.validationScore > 0)
    .sort((a, b) => b.validationScore - a.validationScore);
  expect(model.selectedCase).toBe(candidates[0]?.id ?? 'CASH');
}, 30000);
it('preserves separate Fed easing, tightening and other categories', () => {
  expect(
    [
      'FOMC lowers the federal funds target range',
      'FOMC raises the federal funds target range',
      'FOMC maintains the federal funds target range',
    ].map((t) => newsHistoryClassify('federal-reserve', t).group),
  ).toEqual(['MONETARY_POLICY:EASING', 'MONETARY_POLICY:TIGHTENING', 'MONETARY_POLICY']);
  const events = study.events.map((e) => ({
    ...e,
    group: e.group === 'SYNTHETIC_LONG' ? 'MONETARY_POLICY:EASING' : 'MONETARY_POLICY',
  }));
  const fit = selectNewsV6(events, study.prices, study.plan);
  expect(fit.cases[0]!.fit.rules.find((r) => r.group === 'MONETARY_POLICY:EASING')!.side).toBe(
    'LONG',
  );
  expect(fit.cases[0]!.fit.rules.find((r) => r.group === 'MONETARY_POLICY')!.side).toBe('SHORT');
}, 30000);
it('keeps fees and short financing, and reports bounded chronological diagnostics with separate accounts', () => {
  for (const a of model.ablations) {
    const test = a.model.evaluations[2]!;
    if (test.trades.length) {
      expect(Number(test.fees)).toBeGreaterThan(0);
      expect(Number(test.financing)).toBeGreaterThan(0);
    }
    expect(a.validationWindows[0]!.from).toBe(study.plan.trainEnd);
    expect(a.validationWindows[2]!.to).toBe(study.plan.validationEnd);
    for (let i = 0; i < 3; i++) {
      const w = a.validationWindows[i]!;
      expect(w.trades.every((t) => t.entryAt >= w.from && t.exitAt < w.to)).toBe(true);
      if (i) expect(w.from).toBe(a.validationWindows[i - 1]!.to);
    }
  }
});
it('rejects combining changes or altering the selected account in the public contract', () => {
  expect(() =>
    NewsV6Case.parse({
      ...model.ablations[1],
      changedFields: ['uncertaintyZ', 'categoryValidationGate'],
    }),
  ).toThrow('one changed rule');
  expect(() =>
    NewsV6Model.parse({ ...model, config: { ...model.config, horizonHours: 168 } }),
  ).toThrow('Selected V6 account');
});
it('accepts equivalent account records after PostgreSQL jsonb reorders their keys', () => {
  const reordered = {
    ...model,
    evaluations: model.evaluations.map((e) => ({
      ...e,
      skipped: Object.fromEntries(Object.entries(e.skipped).reverse()),
    })),
  };
  expect(NewsV6Model.parse(reordered)).toEqual(model);
});
it('fails exact baseline verification and abstains when evidence cannot cover costs', () => {
  const wrong = { ...model.ablations[0]!.model, modelHash: canonicalHash('synthetic tampering') };
  expect(() => buildV6Model(study.events, study.prices, study.plan, wrong)).toThrow(
    'exact V2 reproduction',
  );
  const flat = {
    ...study.prices,
    bars: study.prices.bars.map((b) =>
      BtcHourSchema.parse({ ...b, open: '100', high: '100.1', low: '99.9', close: '100' }),
    ),
  };
  const result = selectNewsV6(study.events, flat, study.plan);
  expect(result.selectedCase).toBe('CASH');
  expect(result.fit.rules).toEqual([]);
}, 30000);
it('uses the declared concentration penalty instead of counting a single winning trade as sufficient evidence', () => {
  const e = model.ablations[0]!.model.evaluations[1]!;
  expect(v6ValidationScore(e)).toBe(
    Number(e.netPnl) -
      2500 * e.maxDrawdown -
      0.5 * Math.max(0, ...e.trades.map((t) => Number(t.netPnl))),
  );
  expect(v6ValidationScore({ ...e, trades: e.trades.slice(0, 2) })).toBe(-1e9);
});
