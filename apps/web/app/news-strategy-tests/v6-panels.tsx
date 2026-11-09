import type { V6Report } from '../../../../packages/contracts/src/news-research-v6';
const money = (n: string | number) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const date = (n: number) => new Date(n).toISOString().slice(0, 10);
const names = {
  V2_BASELINE: 'V2 unchanged',
  UNCERTAINTY_ONLY: 'Uncertainty only',
  GROUP_VALIDATION_ONLY: 'Category validation only',
  CONCENTRATION_SELECTION_ONLY: 'Selection penalty only',
};
export default function V6Panels({
  report,
  asset,
  onCase,
}: {
  report: V6Report;
  asset: string;
  onCase: (id: string) => void;
}) {
  const row = report.rows.find((r) => r.asset === asset),
    model = row?.models.find((m) => m.version === 'LEARNED_V6');
  return (
    <>
      <section className="panel">
        <h2>V6 · one change at a time from V2</h2>
        <p>
          V2 is reproduced exactly before any change. News events, issuer categories, non-event
          controls, hourly candles and fees are identical. Fed easing, tightening and other policy
          decisions remain separate.
        </p>
        <p>
          Three standalone tests: add a 1.28 standard-error margin; validate each category using
          normal fees; or penalize dependence on the largest validation win when ranking the same 36
          candidates. Each test starts from V2. Changes are never combined.
        </p>
        <p>
          V6 selects one case using validation P&amp;L minus drawdown and half the largest winning
          trade. It needs three validation trades and a positive score; equal scores prefer
          unchanged V2. Final profits never select a case. Three two-month validation windows show
          in-sample stability using separate accounts. Their configurations and category gates were
          selected using the whole validation period; these windows are not forward tests.
        </p>
        <p>
          The final period has already been viewed. These are descriptive comparisons, not evidence
          of live profitability.
        </p>
      </section>
      <section className="panel">
        <h2>All-token single-factor results · final net USDT with fees</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Token</th>
                <th>V2 unchanged</th>
                <th>Uncertainty only</th>
                <th>Category validation only</th>
                <th>Selection penalty only</th>
                <th>Validation-selected V6 case</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((r) => {
                const m = r.models.find((x) => x.version === 'LEARNED_V6');
                return (
                  <tr key={r.asset}>
                    <td>{r.asset}</td>
                    {[
                      'V2_BASELINE',
                      'UNCERTAINTY_ONLY',
                      'GROUP_VALIDATION_ONLY',
                      'CONCENTRATION_SELECTION_ONLY',
                    ].map((id) => (
                      <td key={id}>
                        {money(
                          m?.version === 'LEARNED_V6'
                            ? m.ablations.find((a) => a.id === id)!.model.evaluations[2]!.netPnl
                            : 0,
                        )}
                      </td>
                    ))}
                    <td>{m?.version === 'LEARNED_V6' ? m.selectedCase : 'Cash control'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p>
          Every cell is an independent 10,000-USDT simulation. A profitable rejected case stays
          visible; it cannot be selected using hindsight.
        </p>
      </section>
      {row?.v2Attribution && (
        <details className="panel">
          <summary>{asset} · unchanged V2 trade attribution</summary>
          {row.v2Attribution.explanation.map((s) => (
            <p key={s}>{s}</p>
          ))}
        </details>
      )}
      {model?.version === 'LEARNED_V6' && (
        <section className="panel">
          <h2>{asset} · isolated changes and selection evidence</h2>
          <p>
            Selected {model.selectedCase}. Fees on.{' '}
            <button className="button" onClick={() => onCase('SELECTED')}>
              Inspect selected V6 trades
            </button>
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Case / changed rule</th>
                  <th>Validation P&amp;L / score</th>
                  <th>Final P&amp;L / change vs V2</th>
                  <th>Final trades / fees</th>
                  <th>Double costs / extra hour</th>
                  <th>Inspect</th>
                </tr>
              </thead>
              <tbody>
                {model.ablations.map((a) => (
                  <tr key={a.id}>
                    <td>
                      {names[a.id]}
                      <small>{a.change}</small>
                      <small>
                        {a.model.config.horizonHours}h · N{a.model.config.minSamples} · cost ×
                        {a.model.config.edgeBuffer} · uncertainty {a.model.config.uncertaintyZ}
                      </small>
                    </td>
                    <td>
                      {money(a.model.evaluations[1]!.netPnl)} /{' '}
                      {a.validationScore <= -1e9 ? 'Insufficient trades' : money(a.validationScore)}
                    </td>
                    <td>
                      {money(a.model.evaluations[2]!.netPnl)} / {money(a.finalDelta)}
                    </td>
                    <td>
                      {a.model.evaluations[2]!.trades.length} /{' '}
                      {money(a.model.evaluations[2]!.fees)}
                    </td>
                    <td>
                      {money(a.model.doubleCostTestPnl)} / {money(a.model.delayedTestPnl)}
                    </td>
                    <td>
                      <button className="button" onClick={() => onCase(a.id)}>
                        Show trades
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details>
            <summary>Chronological validation diagnostics · in-sample · category decisions</summary>
            {model.ablations.map((a) => (
              <div key={a.id}>
                <h3>{names[a.id]}</h3>
                <p>
                  {a.validationWindows
                    .map(
                      (w) =>
                        `${date(w.from)} to ${date(w.to)}: ${money(w.netPnl)} USDT / ${w.trades.length} trades`,
                    )
                    .join(' · ')}
                </p>
                {a.groupChecks.length > 0 && (
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Original V2 category</th>
                          <th>Validation trades</th>
                          <th>Normal-cost P&amp;L</th>
                          <th>Retain</th>
                        </tr>
                      </thead>
                      <tbody>
                        {a.groupChecks.map((g) => (
                          <tr key={g.group}>
                            <td>{g.group}</td>
                            <td>{g.validationTrades}</td>
                            <td>{money(g.validationPnl)}</td>
                            <td>{g.retained ? 'Yes' : 'HOLD'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ))}
          </details>
          <p className="news-history-hash">
            Parent V5 {report.referenceV5RunId}
            <br />
            Parent report {report.referenceV5ReportHash}
            <br />
            V2 events {model.eventsHash}
          </p>
        </section>
      )}
    </>
  );
}
