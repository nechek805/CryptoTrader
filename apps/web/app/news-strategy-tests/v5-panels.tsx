import type { V5Report } from '../../../../packages/contracts/src/news-research-v5';
const money = (n: string | number) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export default function V5Panels({ report, asset }: { report: V5Report; asset: string }) {
  const row = report.rows.find((r) => r.asset === asset),
    analysis = row?.v2Attribution;
  const model = row?.models.find((m) => m.version === 'LEARNED_V5');
  return (
    <>
      <section className="panel">
        <h2>What V5 changes · separate reactions for every token</h2>
        <p>
          V2’s winning ADA, AVAX and ETH trades mostly followed inflation, jobs and Fed releases.
          V4’s signed features and stronger uncertainty/sample gates rejected all candidates. V5
          tests an unconditional reaction to a release category; it does not invent missing market
          expectations.
        </p>
        <p>
          Three holding periods: 4, 24 and 72 hours. Each category needs eight training samples and
          a mean controlled reaction greater than twice estimated costs. Direction comes from
          training only. Validation keeps a category only with three trades across two months and
          positive P&amp;L at normal and double costs. Horizon selection needs five combined
          validation trades; drawdown and half the largest win reduce its score.
        </p>
        <p>
          This is an exploratory mean-edge hypothesis without V4’s confidence margin. Group checks
          add adaptive trials. The final six months were already inspected; positive results remain
          descriptive and do not enable live trading.
        </p>
        <p>
          V1–V4 accounts are preserved exactly. V5 uses the same frozen corpus, price hashes, 10,000
          virtual USDT, 20% allocation, stops/targets, fees, adverse slippage and assumed short
          borrowing.
        </p>
      </section>
      {analysis && (
        <section className="panel">
          <h2>{asset} · why V2 won or lost</h2>
          {analysis.explanation.map((s) => (
            <p key={s}>{s}</p>
          ))}
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Breakdown</th>
                  <th>Trades / wins</th>
                  <th>Net USDT</th>
                  <th>Fees</th>
                </tr>
              </thead>
              <tbody>
                {[...analysis.groups, ...analysis.directions, ...analysis.months].map((b) => (
                  <tr key={b.label}>
                    <td>{b.label}</td>
                    <td>
                      {b.trades} / {b.wins}
                    </td>
                    <td>{money(b.netPnl)}</td>
                    <td>{money(b.fees)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {model?.version === 'LEARNED_V5' && (
        <section className="panel">
          <h2>{asset} · V5 selection evidence</h2>
          <p>
            Selected {model.config.id}. Final P&amp;L {money(model.evaluations[2]!.netPnl)} USDT;
            double costs {money(model.doubleCostTestPnl)}; one extra hour of delay{' '}
            {money(model.delayedTestPnl)}.
          </p>
          <details>
            <summary>Every candidate and event-category check</summary>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Candidate / group</th>
                    <th>Training N / side</th>
                    <th>Validation trades / months</th>
                    <th>Validation net / double cost</th>
                    <th>Decision</th>
                  </tr>
                </thead>
                <tbody>
                  {model.groupChecks.map((c) => (
                    <tr key={c.configId + c.group}>
                      <td>
                        {c.configId}
                        <small>{c.group}</small>
                      </td>
                      <td>
                        {c.trainingCount} / {c.side}
                      </td>
                      <td>
                        {c.validationTrades} / {c.validationMonths}
                      </td>
                      <td>
                        {money(c.validationPnl)} / {money(c.doubleCostValidationPnl)}
                      </td>
                      <td>
                        {c.accepted ? 'Keep category' : 'HOLD'}
                        <small>{c.reason}</small>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
          <p className="news-history-hash">
            Frozen parent {report.referenceV4RunId}
            <br />
            Parent report {report.referenceV4ReportHash}
            <br />
            Corpus {report.corpusHash}
          </p>
        </section>
      )}
    </>
  );
}
