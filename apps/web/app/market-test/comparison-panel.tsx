'use client';
import type { BtcAnyComparison, BtcAttributionSchema } from '@crypto/contracts';
import type { z } from 'zod';

export type BtcSelection = 'ORIGINAL' | 'REVISED' | 'THIRD';
const money = (v: string) =>
  Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (v: string) => `${(Number(v) * 100).toFixed(2)}%`;
const date = (v: string) => new Date(v).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
function Attribution({ title, a }: { title: string; a: z.infer<typeof BtcAttributionSchema> }) {
  return (
    <details>
      <summary>{title}</summary>
      <p>
        Net change before fees, at the same simulated fill prices: {money(a.beforeFees)} USDT. Total
        recorded fees and adverse slippage: {money(a.totalFriction)} USDT, already included in net
        results. Adding back both recorded costs gives {money(a.beforeFeesAndSlippage)} USDT; this
        is attribution of the same fills, not a zero-cost replay.
      </p>
      <p>
        {a.shortHoldCount} trades held for 12 hours or less returned {money(a.shortHoldNet)} USDT
        net.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Exit reason</th>
              <th>Trades</th>
              <th>Net USDT</th>
            </tr>
          </thead>
          <tbody>
            {a.groups.map((g) => (
              <tr key={g.reason}>
                <td>{g.reason}</td>
                <td>{g.count}</td>
                <td>{money(g.net)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        Closed net: {money(a.closedNet)} USDT. Open-position contribution including entry fees:{' '}
        {money(a.openContribution)} USDT.
      </p>
    </details>
  );
}

export default function BtcComparisonPanel({
  id,
  c,
  busy,
  onSelect,
}: {
  id: string;
  c: BtcAnyComparison;
  busy: boolean;
  onSelect: (strategy: BtcSelection) => void;
}) {
  const arms = [
    { key: 'ORIGINAL' as const, label: 'Original v1', value: c.original },
    { key: 'REVISED' as const, label: 'Revision v2', value: c.revised },
    ...(c.version === 'btc-comparison.v2'
      ? [{ key: 'THIRD' as const, label: 'Revision v3', value: c.third }]
      : []),
  ];
  type Arm = typeof c.original;
  const metrics: { label: string; format: (a: Arm) => string }[] = [
    { label: 'Final equity', format: (a) => money(a.summary.finalEquity) + ' USDT' },
    { label: 'Net P&L after costs', format: (a) => money(a.summary.netPnl) + ' USDT' },
    { label: 'Maximum hourly drawdown', format: (a) => pct(a.summary.maxDrawdown) },
    { label: 'Fees', format: (a) => money(a.summary.fees) + ' USDT' },
    { label: 'Recorded adverse slippage', format: (a) => money(a.summary.slippage) + ' USDT' },
    {
      label: 'Closed trades / wins',
      format: (a) => `${a.summary.closedTrades} / ${a.summary.wins}`,
    },
    {
      label: 'Closed-trade profit factor',
      format: (a) => (a.profitFactor === null ? 'N/A' : money(a.profitFactor)),
    },
    { label: 'BTC held at hourly closes', format: (a) => pct(a.exposureFraction) },
  ];
  return (
    <section className="panel btc-section">
      <div className="btc-section-head">
        <div>
          <div className="eyebrow">SAME BTC SNAPSHOT / IMMUTABLE STRATEGY VERSIONS</div>
          <h2>
            {c.version === 'btc-comparison.v2' ? 'Compare v1, v2 and v3' : 'Compare v1 and v2'}
          </h2>
          <p>
            Each starts with 10,000 virtual USDT and identical risk caps, fees, slippage and exit
            rules. v2 adds trend and cost filters.{' '}
            {c.version === 'btc-comparison.v2' &&
              'v3 also requires an upper-half signal close and rejects signal ranges above 2 ATR.'}
          </p>
        </div>
        <a className="button" href="/api/btc-test/comparison-export">
          ↓ Export comparison
        </a>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Full-period measure</th>
              {arms.map((a) => (
                <th key={a.key}>{a.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {metrics.map((m) => (
              <tr key={m.label}>
                <td>{m.label}</td>
                {arms.map((a) => (
                  <td key={a.key}>{m.format(a.value)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="btc-actions">
        {arms.map((a) => (
          <button
            key={a.key}
            className={`button ${a.key === arms.at(-1)!.key ? 'primary' : ''}`}
            disabled={busy}
            onClick={() => onSelect(a.key)}
          >
            Inspect {a.label.toLowerCase()}
          </button>
        ))}
      </div>
      <Attribution title="Why v1 lost money" a={c.attribution} />
      {c.version === 'btc-comparison.v2' && (
        <>
          <Attribution title="Why v2 still lost money" a={c.v2Attribution} />
          <details>
            <summary>V2 trades skipped by v3</summary>
            <p>
              These outcomes are shown after replay for diagnosis. Entry gates use only the
              completed signal candle, not the eventual result. Additional v3 entries outside the v2
              entry set: {c.additionalV3Entries ?? 0}.
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>V2 entry time</th>
                    <th>V2 net USDT</th>
                    <th>V3 decision reason</th>
                  </tr>
                </thead>
                <tbody>
                  {(c.skippedV2Trades ?? []).map((t) => (
                    <tr key={t.entryIndex}>
                      <td>{date(t.entryAt)}</td>
                      <td>{money(t.net)}</td>
                      <td>{t.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
      <h3>Previously seen chronological periods · fresh virtual balances</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Window (UTC)</th>
              {arms.map((a) => (
                <th key={a.key}>{a.label} net USDT</th>
              ))}
              <th>Newest version trades / wins</th>
            </tr>
          </thead>
          <tbody>
            {c.windows.map((w) => {
              const third = 'third' in w ? w.third : null;
              return (
                <tr key={w.label}>
                  <td>
                    {w.label === 'DEVELOPMENT' ? 'First two thirds' : 'Later one third'}
                    <small>
                      {date(w.from)} → {date(w.to)}
                    </small>
                  </td>
                  <td>{money(w.original.summary.netPnl)}</td>
                  <td>{money(w.revised.summary.netPnl)}</td>
                  {third && <td>{money(third.summary.netPnl)}</td>}
                  <td>
                    {(third ?? w.revised).summary.closedTrades} /{' '}
                    {(third ?? w.revised).summary.wins}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {c.version === 'btc-comparison.v2' && c.doubleCostSameFills && (
        <details>
          <summary>Cost sensitivity · same fills, double recorded costs</summary>
          <p>
            With the same quantities and fills, subtracting one more copy of recorded fees and
            slippage gives v1 {money(c.doubleCostSameFills.original)}, v2{' '}
            {money(c.doubleCostSameFills.revised)}, and v3 {money(c.doubleCostSameFills.third)}{' '}
            USDT. This is an attribution stress check, not a new replay with different fills or
            sizing.
          </p>
        </details>
      )}
      <p className="notice">
        {c.version === 'btc-comparison.v2'
          ? 'Three strategies: original plus two revisions; one new candidate in this iteration.'
          : 'Original plus one revision.'}{' '}
        These rules were revised after observing this history. No threshold search was performed in
        this iteration. These periods are not an untouched holdout or proof of future profitability.
        Each resets cash and positions, so results are not additive. v2/v3 need 224 hours of
        context; v1 needs 50. Hourly-close exposure misses intrabar positions; lower exposure
        contributes to differences.
      </p>
      <p className="hash">
        {arms.map((a) => (
          <span key={a.key}>
            {a.label}: {a.value.reportId}
            <br />
          </span>
        ))}
        Comparison: {id}
      </p>
    </section>
  );
}
