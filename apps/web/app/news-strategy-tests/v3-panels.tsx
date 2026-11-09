'use client';
import { useMemo, useState, useEffect } from 'react';
import type { V3Report } from '../../../../packages/contracts/src/news-research-v3';
const money = (s: string | number) =>
  Number(s).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (n: number | null) => (n === null ? 'Unavailable' : (n * 100).toFixed(2) + '%');
const time = (n: number | null) =>
  n === null ? 'Unknown' : new Date(n).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
export default function V3Panels({
  report,
  asset,
  onAssetChange,
}: {
  report: V3Report;
  asset: string;
  onAssetChange: (s: string) => void;
}) {
  const [gate, setGate] = useState('ALL'),
    [page, setPage] = useState(0);
  useEffect(() => {
    setPage(0);
  }, [asset, gate]);
  const row = report.rows.find((r) => r.asset === asset),
    model = row?.models.find((m) => m.version === 'LEARNED_V3');
  const events = useMemo(
    () =>
      report.structuredEvents.filter(
        (e) =>
          e.assets.some((a) => a === asset) &&
          (e.publishedAt === null ||
            (e.publishedAt >= report.plan.from && e.publishedAt < report.plan.to)) &&
          (gate === 'ALL' || e.gate === gate),
      ),
    [report, asset, gate],
  );
  const byVersion = useMemo(() => {
    const map = new Map<string, V3Report['events'][number]>();
    for (const e of report.events) if (!map.has(e.versionId)) map.set(e.versionId, e);
    return map;
  }, [report]);
  const structuredMap = useMemo(
    () => new Map(report.structuredEvents.map((e) => [e.id, e])),
    [report],
  );
  return (
    <>
      <section className="panel">
        <h2>V1 / V2 / V3 · same frozen history, fees on</h2>
        <p>
          Each strategy/token starts with 10,000 virtual USDT. V1/V2 results are preserved exactly.
          V3 uses the same news snapshot, hourly prices, fees, slippage, exposure and
          short-financing assumptions. One-minute diagnostics below are separate.
        </p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Token</th>
                <th>V1 final P&L</th>
                <th>V2 final P&L</th>
                <th>V3 final P&L</th>
                <th>V3 change vs V2</th>
                <th>V3 trades / wins</th>
                <th>V3 drawdown</th>
                <th>V3 eligible events</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((r) => {
                const v1 = r.models.find((m) => m.version === 'RULES_V1')?.evaluations[2],
                  v2 = r.models.find((m) => m.version === 'LEARNED_V2')?.evaluations[2],
                  v3 = r.models.find((m) => m.version === 'LEARNED_V3')?.evaluations[2];
                return (
                  <tr key={r.asset} className={r.asset === asset ? 'news-history-selected' : ''}>
                    <td>
                      <button className="button" onClick={() => onAssetChange(r.asset)}>
                        {r.asset}
                      </button>
                    </td>
                    <td>{money(v1?.netPnl ?? 0)}</td>
                    <td>{money(v2?.netPnl ?? 0)}</td>
                    <td>{money(v3?.netPnl ?? 0)}</td>
                    <td>{v3 && v2 ? money(Number(v3.netPnl) - Number(v2.netPnl)) : '—'}</td>
                    <td>{v3 ? `${v3.trades.length} / ${v3.wins}` : 'Cash'}</td>
                    <td>{v3 ? pct(v3.maxDrawdown) : '—'}</td>
                    <td>{r.v3Coverage.eligible}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p>
          Zero P&L with zero trades means HOLD. It demonstrates avoided losses in this replay, not a
          profitable predictive edge. This inspected archive cannot establish live qualification or
          an unseen-test result.
        </p>
        <details>
          <summary>What V3 changes</summary>
          <ul>
            <li>
              Routine posts, AMA invitations, proposals, testnets, postponements and cancellations
              default to HOLD.
            </li>
            <li>
              Facts, status, severity, affected tokens and exact evidence quotes remain separate
              from the learned return direction.
            </li>
            <li>
              Macro releases require actual values and a verified forecast observed before the
              announcement. No forecast provider is configured; missing data remains HOLD.
            </li>
            <li>
              Six declared candidates: 4/24/72-hour holding limits with 12/20 training samples. A
              95% approximate uncertainty margin, twice estimated costs and five validation trades
              are required.
            </li>
            <li>
              A 72-hour training purge and three expanding walk-forward folds protect time ordering.
              Every result and assumption is retained.
            </li>
          </ul>
        </details>
        <p className="news-history-hash">
          Frozen V1/V2 report {report.baselineReportHash}
          <br />
          V3 engine {report.engineHash}
        </p>
      </section>
      <section className="panel">
        <h2>{asset} · V3 coverage and abstention</h2>
        <p>
          Relevant records: {row?.v3Coverage.relevant ?? 0} · dated records:{' '}
          {row?.v3Coverage.dated ?? 0} · material candidates: {row?.v3Coverage.eligible ?? 0} ·
          historically timely: {row?.v3Coverage.historicallyTimely ?? 0}.
        </p>
        {model && 'holdReasons' in model && (
          <>
            <p>
              {Object.entries(model.holdReasons)
                .map(([reason, count]) => `${reason.replaceAll('_', ' ')}: ${count}`)
                .join(' · ')}
            </p>
            <h3>Walk-forward checks · separate 10,000 USDT accounts</h3>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Training ends</th>
                    <th>Validation ends</th>
                    <th>Test ends</th>
                    <th>Selected policy</th>
                    <th>Test net P&L</th>
                    <th>Trades</th>
                  </tr>
                </thead>
                <tbody>
                  {model.walkForward.map((f) => (
                    <tr key={f.testEnd}>
                      <td>{time(f.trainEnd)}</td>
                      <td>{time(f.validationEnd)}</td>
                      <td>{time(f.testEnd)}</td>
                      <td>{f.configId}</td>
                      <td>{money(f.evaluation.netPnl)}</td>
                      <td>{f.evaluation.trades.length}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <details>
              <summary>Training evidence and cost margins</summary>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Event group</th>
                      <th>Samples / minimum</th>
                      <th>Lower estimated edge</th>
                      <th>Required cost margin</th>
                      <th>Opinion</th>
                    </tr>
                  </thead>
                  <tbody>
                    {model.fitEvidence.map((f) => (
                      <tr key={f.group}>
                        <td>{f.group}</td>
                        <td>
                          {f.count} / {f.minimum}
                        </td>
                        <td>{pct(f.lowerEdge)}</td>
                        <td>{pct(f.requiredEdge)}</td>
                        <td>{f.side}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!model.fitEvidence.length && (
                <p>No actionable, sufficiently dated event group was available to fit.</p>
              )}
            </details>
          </>
        )}
      </section>
      <section className="panel">
        <div className="news-history-toolbar">
          <h2>{asset} · structured news interpretation</h2>
          <select aria-label="V3 event gate" value={gate} onChange={(e) => setGate(e.target.value)}>
            <option value="ALL">All event gates</option>
            {[...new Set(report.structuredEvents.map((e) => e.gate))].sort().map((g) => (
              <option key={g}>{g}</option>
            ))}
          </select>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>News and evidence</th>
                <th>Event / stage</th>
                <th>Severity / attribution</th>
                <th>V1 opinion</th>
                <th>V2 opinion</th>
                <th>V3 gate</th>
                <th>Publication / actual availability</th>
              </tr>
            </thead>
            <tbody>
              {events.slice(page * 20, (page + 1) * 20).map((e) => {
                const old = byVersion.get(e.versionId),
                  v2 =
                    row?.models
                      .find((m) => m.version === 'LEARNED_V2')
                      ?.rules.find((r) => r.group === old?.group)?.side ?? 'HOLD';
                return (
                  <tr key={e.id}>
                    <td>
                      <a href={e.url} target="_blank" rel="noreferrer">
                        {e.title}
                      </a>
                      <small>{e.publisher}</small>
                      <details>
                        <summary>Evidence / macro data</summary>
                        {e.evidenceQuotes.map((q) => (
                          <p key={q}>{q}</p>
                        ))}
                        {e.macro && (
                          <p>
                            Actual: {e.macro.actual ?? 'unknown'} · consensus:{' '}
                            {e.macro.consensus ?? 'unknown'} · surprise:{' '}
                            {e.macro.surprise ?? 'unknown'} · unit: {e.macro.unit} · forecast
                            available: {time(e.macro.expectationAvailableAt)}
                          </p>
                        )}
                      </details>
                    </td>
                    <td>
                      {e.kind}
                      <small>{e.stage}</small>
                    </td>
                    <td>
                      {e.severity}
                      <small>{e.attribution}</small>
                    </td>
                    <td>{old?.fixedSide ?? 'Not in baseline'}</td>
                    <td>{v2}</td>
                    <td>{e.gate.replaceAll('_', ' ')}</td>
                    <td>
                      {time(e.publishedAt)}
                      <small>{time(e.availableAt)}</small>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="news-history-toolbar">
          <button className="button" disabled={!page} onClick={() => setPage((p) => p - 1)}>
            Previous
          </button>
          <span>
            {events.length} matching events · page {page + 1}
          </span>
          <button
            className="button"
            disabled={(page + 1) * 20 >= events.length}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </button>
        </div>
      </section>
      <section className="panel">
        <h2>{asset} · one-minute reaction diagnostics</h2>
        <p>
          Real public 1m candles around preselected news events. These are raw price reactions, not
          net strategy profits. The V1/V2/V3 comparison keeps fees on and its original hourly
          execution. Minute windows are selected without looking at later returns.
        </p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>News</th>
                <th>First 1m entry after delay</th>
                <th>Hourly entry</th>
                <th>5m reaction</th>
                <th>15m reaction</th>
                <th>60m reaction</th>
                <th>Data status</th>
              </tr>
            </thead>
            <tbody>
              {report.minuteDiagnostics
                .filter((d) => d.asset === asset)
                .map((d) => (
                  <tr key={d.eventId + d.asset}>
                    <td>{structuredMap.get(d.eventId)?.title ?? d.eventId}</td>
                    <td>{time(d.firstMinuteEntryAt)}</td>
                    <td>{time(d.hourlyEntryAt)}</td>
                    <td>{pct(d.return5m)}</td>
                    <td>{pct(d.return15m)}</td>
                    <td>{pct(d.return60m)}</td>
                    <td>
                      {d.status}
                      <small>{d.error}</small>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        {!report.minuteDiagnostics.some((d) => d.asset === asset) && (
          <p>No permitted, dated event window is available for this token.</p>
        )}
      </section>
    </>
  );
}
