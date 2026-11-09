'use client';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  SpecialistMatrixSchema,
  SpecialistStateSchema,
  SpecialistJobSchema,
  SpecialistViewSchema,
  DEFAULT_SPECIALIST_FEES,
} from '@crypto/contracts';
import type { SpecialistAsset, SpecialistKey, SpecialistCandidate } from '@crypto/contracts';
import '../market-strategy-tests/market-strategy-tests.css';
import './specialist-tests.css';
const Matrix = z.strictObject({ id: z.string(), matrix: SpecialistMatrixSchema });
type MatrixView = z.infer<typeof Matrix>;
type State = z.infer<typeof SpecialistStateSchema>;
type Detail = z.infer<typeof SpecialistViewSchema>;
const keys = ['V1', 'V2', 'V3', 'V4'] as const;
const tabs = [
  'Results',
  'Why & v4 profiles',
  'Candidate search',
  'Trade explorer',
  'Sources',
] as const;
type Tab = (typeof tabs)[number];
const money = (v: string | number | null, d = 2) =>
  v === null
    ? 'N/A'
    : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (v: string) => `${(Number(v) * 100).toFixed(2)}%`;
const stamp = (v: number) => new Date(v).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
const color = (v: string) =>
  Number(v) < 0 ? 'strategy-loss' : Number(v) > 0 ? 'strategy-profit' : 'strategy-flat';
const describe = (p: SpecialistCandidate) =>
  `${p.base} base · stop ${p.stopAtr} ATR · target ${p.targetAtr} ATR · MA200 slope ${p.trendSlopeHours}h${p.minSignalRangeAtr ? ` · minimum signal range ${p.minSignalRangeAtr} ATR` : ''}`;
async function api<T>(path: string, schema: z.ZodType<T>, body?: unknown) {
  const r = await fetch('/api/specialist-tests' + path, {
    cache: 'no-store',
    credentials: 'same-origin',
    ...(body
      ? {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  });
  if (!r.ok)
    throw new Error(
      r.status === 401
        ? 'Session expired. Refresh to reconnect.'
        : r.status === 409
          ? 'Wait for the active research job.'
          : 'Specialist research could not complete this request. Check that real SOL/XRP market tests exist and retry.',
    );
  return schema.parse(await r.json());
}
function FeeSwitch({
  label,
  checked,
  mixed = false,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  mixed?: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = mixed;
  });
  return (
    <label className="strategy-fee-toggle">
      <input
        ref={ref}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        {label}
        <small>{mixed ? 'Mixed' : checked ? 'On · 0.10% per side' : 'Off · 0%'}</small>
      </span>
    </label>
  );
}
function Curve({ report }: { report: Detail }) {
  const values = report.report.decisions.map((d) => Number(d.equity)),
    low = Math.min(10000, ...values) - 5,
    high = Math.max(10000, ...values) + 5,
    x = (i: number) => 60 + (i * 860) / (values.length - 1),
    y = (v: number) => 20 + ((high - v) * 200) / (high - low);
  return (
    <>
      <svg
        className="equity-chart"
        viewBox="0 0 960 270"
        role="img"
        aria-label={`${report.report.asset} ${report.report.plan.strategy} virtual equity versus cash`}
      >
        <text x="0" y="25" className="chart-label">
          {money(high, 0)}
        </text>
        <text x="0" y="220" className="chart-label">
          {money(low, 0)}
        </text>
        <line x1="60" x2="920" y1={y(10000)} y2={y(10000)} stroke="#9aaa9c" strokeDasharray="5 5" />
        <polyline
          fill="none"
          stroke="#287e72"
          strokeWidth="2"
          points={values.map((v, i) => `${x(i)},${y(v)}`).join(' ')}
        />
        <text x="60" y="255" className="chart-label">
          {stamp(report.dataset.from)}
        </text>
        <text x="920" y="255" textAnchor="end" className="chart-label">
          {stamp(report.dataset.to)}
        </text>
      </svg>
      <p className="muted">
        Strategy equity after the selected costs. Dashed line: 10,000 USDT cash. Vertical scale
        follows the selected report.
      </p>
    </>
  );
}
export default function SpecialistTests() {
  const [state, setState] = useState<State | null>(null),
    [matrix, setMatrix] = useState<MatrixView | null>(null),
    [tab, setTab] = useState<Tab>('Results'),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [saving, setSaving] = useState(false),
    [asset, setAsset] = useState<SpecialistAsset>('SOL'),
    [strategy, setStrategy] = useState<SpecialistKey>('V4'),
    [detail, setDetail] = useState<Detail | null>(null),
    [detailLoading, setDetailLoading] = useState(false),
    [hour, setHour] = useState(0),
    [page, setPage] = useState(0),
    [verified, setVerified] = useState<string | null>(null),
    [verifying, setVerifying] = useState(false);
  const fees = state?.fees ?? DEFAULT_SPECIALIST_FEES,
    busy = state?.job?.status === 'RUNNING' || saving,
    all = Object.values(fees).every(Boolean),
    mixed = Object.values(fees).some(Boolean) && !all,
    row = matrix?.matrix.rows.find((r) => r.asset === asset),
    cell = row?.variants[fees[strategy] ? 'STANDARD' : 'ZERO'].find((c) => c.strategy === strategy),
    reportId = cell?.reportId;
  async function load() {
    setLoading(true);
    setError('');
    try {
      const next = await api('', SpecialistStateSchema);
      const value = next.matrixId ? await api('/matrix', Matrix) : null;
      setState(next);
      setMatrix(value);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open research.');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    if (state?.job?.status !== 'RUNNING') return;
    let active = true;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const next = await api('', SpecialistStateSchema);
          if (!active) return;
          setState(next);
          if (next.job?.status !== 'RUNNING' && next.matrixId) {
            const value = await api('/matrix', Matrix);
            if (active) setMatrix(value);
          }
        } catch (e) {
          if (active) setError(e instanceof Error ? e.message : 'Could not check progress.');
        }
      })();
    }, 1500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [state?.job?.id, state?.job?.status]);
  useEffect(() => {
    if (tab !== 'Trade explorer' || !reportId) return;
    let active = true;
    setDetail(null);
    setDetailLoading(true);
    setPage(0);
    setVerified(null);
    void api(`/report?asset=${asset}&strategy=${strategy}`, SpecialistViewSchema)
      .then((value) => {
        if (active) {
          setDetail(value);
          setHour(value.report.decisions.find((d) => d.action === 'LONG')?.index ?? 0);
        }
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : 'Report unavailable.');
      })
      .finally(() => {
        if (active) setDetailLoading(false);
      });
    return () => {
      active = false;
    };
  }, [asset, strategy, tab, reportId]);
  async function run() {
    setSaving(true);
    setError('');
    try {
      const job = await api('/run', SpecialistJobSchema, {});
      setState((prev) => ({
        matrixId: prev?.matrixId ?? null,
        fees: prev?.fees ?? DEFAULT_SPECIALIST_FEES,
        job,
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not run research.');
    } finally {
      setSaving(false);
    }
  }
  async function setFees(next: State['fees']) {
    setSaving(true);
    setError('');
    try {
      setState(await api('/fees', SpecialistStateSchema, { fees: next }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save fees.');
    } finally {
      setSaving(false);
    }
  }
  async function verify() {
    setVerifying(true);
    setError('');
    try {
      const value = await api(
        '/verify',
        z.object({ verified: z.literal(true), reportId: z.string() }),
        { asset, strategy },
      );
      setVerified(value.reportId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Replay did not verify.');
    } finally {
      setVerifying(false);
    }
  }
  const decision = detail?.report.decisions[hour],
    bar = detail?.bars[hour];
  return (
    <div className="strategy-tests specialist-tests">
      <div className="context-bar">
        <span className="context-dot" />
        <strong>SOL & XRP only</strong>
        <span>Real hourly history · 10,000 virtual USDT per coin/version</span>
        <span className="context-status">RETROSPECTIVE RESEARCH</span>
      </div>
      <section className="panel strategy-intro">
        <div>
          <div className="eyebrow">SEPARATE STRATEGIES / FIXED RISK</div>
          <h2>Develop each coin on its own evidence</h2>
          <p>
            SOL v4 develops the v2 trend/cost strategy. XRP v4 develops v3’s candle-quality
            strategy. Earlier versions remain available here, and every other coin stays in Market
            strategy tests.
          </p>
          {matrix && (
            <p>
              {stamp(matrix.matrix.from)} → {stamp(matrix.matrix.to)} · End exclusive
            </p>
          )}
          <p className="muted">
            V4 maximizes earlier-period net profit within a bounded, disclosed search. It does not
            claim maximum future profit. All of this history was previously seen.
          </p>
        </div>
        <div className="strategy-actions">
          <button
            className="primary"
            disabled={busy || loading}
            onClick={() => {
              void run();
            }}
          >
            {busy
              ? 'Research running…'
              : matrix
                ? 'Rerun SOL & XRP research'
                : 'Run SOL & XRP research'}
          </button>
          {matrix && (
            <a className="button" href="/api/specialist-tests/export">
              ↓ Export research
            </a>
          )}
        </div>
      </section>
      <section className="panel strategy-fee-controls">
        <h2>Trading fees</h2>
        <p>
          These switches apply to both coins and every position in the selected version. This lab
          saves its own settings. Slippage remains 0.05% per side plus tick rounding.
        </p>
        <div className="strategy-fee-switches">
          <FeeSwitch
            label="Fees for all versions"
            checked={all}
            mixed={mixed}
            disabled={busy || loading}
            onChange={(on) => {
              void setFees({ V1: on, V2: on, V3: on, V4: on });
            }}
          />
          {keys.map((key) => (
            <FeeSwitch
              key={key}
              label={`${key} fees`}
              checked={fees[key]}
              disabled={busy || loading}
              onChange={(on) => {
                void setFees({ ...fees, [key]: on });
              }}
            />
          ))}
        </div>
      </section>
      {state?.job && (
        <div className={`notice ${state.job.status === 'FAILED' ? 'error' : ''}`} role="status">
          {state.job.completed}/2 coins · {state.job.message}
          {state.job.status === 'RUNNING' && (
            <progress max="2" value={state.job.completed} aria-label="Coins completed" />
          )}
        </div>
      )}
      {error && (
        <div className="notice error" role="alert">
          {error}{' '}
          <button
            className="button"
            onClick={() => {
              void load();
            }}
          >
            Reload
          </button>
        </div>
      )}
      <div className="strategy-tabs" role="tablist" aria-label="Specialist research">
        {tabs.map((name, i) => (
          <button
            type="button"
            id={`specialist-tab-${i}`}
            role="tab"
            aria-selected={tab === name}
            aria-controls="specialist-panel"
            tabIndex={tab === name ? 0 : -1}
            key={name}
            className={tab === name ? 'selected' : ''}
            onClick={() => setTab(name)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                e.preventDefault();
                const next = (i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
                setTab(tabs[next]!);
                document.getElementById(`specialist-tab-${next}`)?.focus();
              }
            }}
          >
            {name}
          </button>
        ))}
      </div>
      <div
        id="specialist-panel"
        role="tabpanel"
        aria-labelledby={`specialist-tab-${tabs.indexOf(tab)}`}
      >
        {loading ? (
          <div className="panel empty">Loading coin-specific research…</div>
        ) : !matrix ? (
          <section className="panel empty">
            <h2>Prepare the two coin profiles</h2>
            <p>
              Run the research to reuse the frozen public SOL and XRP candles, retain each candidate
              trial, and compare v4 with v1/v2/v3.
            </p>
            <button
              className="primary"
              disabled={busy}
              onClick={() => {
                void run();
              }}
            >
              Run SOL & XRP research
            </button>
          </section>
        ) : (
          <>
            {tab === 'Results' && (
              <>
                <section className="panel">
                  <h2>Full-period results after selected costs</h2>
                  <p>
                    Every cell is an independent account. Select a result to trace its signals and
                    fills. Buy-and-hold uses that version’s fee switch.
                  </p>
                  <div className="table-wrap">
                    <table className="specialist-matrix">
                      <thead>
                        <tr>
                          <th>Coin</th>
                          {keys.map((key) => (
                            <th key={key}>
                              {key}
                              {key === 'V4' ? ' · Coin-specific' : ''}
                              <small>Fees {fees[key] ? 'on · 0.10%' : 'off · 0%'}</small>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {matrix.matrix.rows.map((r) => (
                          <tr key={r.asset}>
                            <th scope="row">
                              {r.asset} / USDT
                              <small>
                                {r.asset === 'SOL' ? 'V4 built on v2' : 'V4 built on v3'}
                              </small>
                            </th>
                            {keys.map((key) => {
                              const c = r.variants[fees[key] ? 'STANDARD' : 'ZERO'].find(
                                (c) => c.strategy === key,
                              )!;
                              return (
                                <td key={key}>
                                  <button
                                    className="strategy-result"
                                    onClick={() => {
                                      setAsset(r.asset);
                                      setStrategy(key);
                                      setTab('Trade explorer');
                                    }}
                                  >
                                    <strong className={color(c.summary.netPnl)}>
                                      {Number(c.summary.netPnl) > 0 ? '+' : ''}
                                      {money(c.summary.netPnl)} <small>USDT</small>
                                    </strong>
                                    <span>
                                      {pct(c.summary.returnFraction)} · Equity{' '}
                                      {money(c.summary.finalEquity)}
                                    </span>
                                    <span>
                                      {c.summary.closedTrades} closed · {c.summary.wins} wins
                                    </span>
                                    <span>
                                      Fees {money(c.summary.fees)} · Slip{' '}
                                      {money(c.summary.slippage)}
                                    </span>
                                    <span>Drawdown {pct(c.summary.maxDrawdown)}</span>
                                    <span>Buy & hold equity {money(c.summary.buyHoldEquity)}</span>
                                    <span className="strategy-link">Inspect decisions ↗</span>
                                  </button>
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="muted">
                    Cash baseline: 10,000 USDT. Equity marks any open position at the final close;
                    no final exit costs are charged. Hourly drawdown can miss intrabar lows.
                  </p>
                </section>
                <section className="panel">
                  <h2>Development choice and later chronological check</h2>
                  <p>
                    Selection uses fees on and the earlier two-thirds only. Each displayed slice
                    resets to 10,000 USDT; their results are not additive. The later third is an
                    exploratory check on previously seen history.
                  </p>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Coin</th>
                          <th>Earlier baseline</th>
                          <th>Earlier v4</th>
                          <th>Later baseline</th>
                          <th>Later v4</th>
                        </tr>
                      </thead>
                      <tbody>
                        {matrix.matrix.rows.map((r) => (
                          <tr key={r.asset}>
                            <th>{r.asset}</th>
                            <td>
                              {r.baseline}: {money(r.development.baseline.summary.netPnl)} USDT
                            </td>
                            <td>{money(r.development.selected.summary.netPnl)} USDT</td>
                            <td>
                              {r.baseline}: {money(r.check.baseline.summary.netPnl)} USDT
                            </td>
                            <td className={color(r.check.selected.summary.netPnl)}>
                              {money(r.check.selected.summary.netPnl)} USDT
                              <small>{r.check.selected.summary.closedTrades} closed trades</small>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              </>
            )}
            {tab === 'Why & v4 profiles' &&
              matrix.matrix.rows.map((r) => (
                <section className="panel" key={r.asset}>
                  <div className="eyebrow">{r.asset} / V4 PROFILE</div>
                  <h2>
                    {r.asset === 'XRP'
                      ? 'Retain candle quality; improve eligible momentum entries'
                      : 'Keep v2 opportunities; improve stop and target distances'}
                  </h2>
                  <p className="muted">
                    Diagnosis and candidate selection use fees on (0.10% per side). The fee switches
                    change comparison results without retuning v4.
                  </p>
                  {r.diagnosis.map((line) => (
                    <p key={line}>{line}</p>
                  ))}
                  <div className="specialist-profile">
                    <strong>{describe(r.selected)}</strong>
                    <p>
                      {r.asset === 'XRP'
                        ? 'Keep the completed-candle close in the upper half of its range and maximum range of 2 ATR. A selected minimum range requires enough price impulse before entry.'
                        : 'The v3 upper-half-close and shock-range entry gates are not used. Wider protective distances, if selected, reduce quantity through the unchanged risk cap.'}
                    </p>
                  </div>
                  <p>
                    Common rules: MA20/MA50 fresh crossover, close above a rising MA200,
                    reward-to-cost gate, ATR14, next-open execution, conservative stop-first OHLC
                    fills, no leverage/shorts, 0.25% risk, 10% allocation, 1% prior-bar volume
                    participation and 2% daily loss limit.
                  </p>
                  <p className="muted">
                    Only the candidate parameters shown above change. No additional capital or risk
                    is used to manufacture higher profit.
                  </p>
                </section>
              ))}
            {tab === 'Candidate search' && (
              <>
                <section className="panel">
                  <h2>A disclosed, bounded search</h2>
                  <p>
                    {stamp(matrix.matrix.from)} →{' '}
                    {stamp(matrix.matrix.from + matrix.matrix.splitIndex * 3600000)} is the
                    development period. The later check starts at that split. Rank by development
                    net P&L, require development drawdown ≤2%, then break ties by fewer trades and
                    simpler parameters. Fees on selects the candidate; turning fees off does not
                    retune it.
                  </p>
                  {matrix.matrix.searchNotes?.map((note) => (
                    <p className="muted" key={note}>
                      {note}
                    </p>
                  ))}
                </section>
                {matrix.matrix.rows.map((r) => (
                  <section className="panel" key={r.asset}>
                    <h2>
                      {r.asset}: all {r.search.length} candidate trials
                    </h2>
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Stop ATR</th>
                            <th>Target ATR</th>
                            <th>Slope hours</th>
                            <th>Min range ATR</th>
                            <th>Development net USDT</th>
                            <th>Drawdown</th>
                            <th>Decision</th>
                          </tr>
                        </thead>
                        <tbody>
                          {[...r.search]
                            .sort(
                              (a, b) =>
                                Number(b.development.summary.netPnl) -
                                Number(a.development.summary.netPnl),
                            )
                            .map((trial, i) => (
                              <tr key={i} className={trial.selected ? 'specialist-selected' : ''}>
                                <td>{trial.candidate.stopAtr}</td>
                                <td>{trial.candidate.targetAtr}</td>
                                <td>{trial.candidate.trendSlopeHours}</td>
                                <td>{trial.candidate.minSignalRangeAtr ?? 'None'}</td>
                                <td className={color(trial.development.summary.netPnl)}>
                                  {money(trial.development.summary.netPnl)}
                                </td>
                                <td>{pct(trial.development.summary.maxDrawdown)}</td>
                                <td>
                                  {trial.selected
                                    ? 'Selected v4'
                                    : trial.eligible
                                      ? 'Retained trial'
                                      : 'Drawdown gate failed'}
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                ))}
              </>
            )}
            {tab === 'Trade explorer' && (
              <>
                <section className="panel">
                  <div className="strategy-selectors">
                    <label>
                      Coin
                      <select
                        value={asset}
                        onChange={(e) => setAsset(e.target.value as SpecialistAsset)}
                      >
                        <option>SOL</option>
                        <option>XRP</option>
                      </select>
                    </label>
                    <label>
                      Version
                      <select
                        value={strategy}
                        onChange={(e) => setStrategy(e.target.value as SpecialistKey)}
                      >
                        {keys.map((key) => (
                          <option key={key}>{key}</option>
                        ))}
                      </select>
                    </label>
                    <span>
                      Fees {fees[strategy] ? 'on (0.10%)' : 'off (0%)'} · Slippage included
                    </span>
                  </div>
                </section>
                {detailLoading ? (
                  <div className="panel empty">Opening the selected report…</div>
                ) : (
                  detail &&
                  detail.id === reportId &&
                  cell && (
                    <>
                      <section className="panel">
                        <div className="panel-title">
                          <h2>
                            {asset} / {strategy} — {money(cell.summary.netPnl)} USDT net
                          </h2>
                          <a
                            className="button"
                            href={`/api/specialist-tests/report-export?asset=${asset}&strategy=${strategy}`}
                          >
                            ↓ Export selected report
                          </a>
                        </div>
                        {detail.report.version === 'specialist-replay.v1' && (
                          <p>{describe(detail.report.plan.candidate)}</p>
                        )}
                        <p>
                          Closed trades contributed {money(detail.attribution.closedNet)} USDT; the
                          final open position contributed{' '}
                          {money(detail.attribution.openContribution)} USDT, including entry costs.
                        </p>
                        <Curve report={detail} />
                        <div className="table-wrap">
                          <table>
                            <thead>
                              <tr>
                                <th>Exit reason</th>
                                <th>Trades / wins</th>
                                <th>Net USDT</th>
                                <th>Fees / slippage</th>
                              </tr>
                            </thead>
                            <tbody>
                              {detail.attribution.groups.map((g) => (
                                <tr key={g.reason}>
                                  <td>{g.reason}</td>
                                  <td>
                                    {g.count} / {g.wins}
                                  </td>
                                  <td className={color(g.net)}>{money(g.net)}</td>
                                  <td>
                                    {money(g.fees)} / {money(g.slippage)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </section>
                      {decision && bar && (
                        <section className="panel">
                          <div className="panel-title">
                            <h2>One completed hour</h2>
                            <strong>{decision.action}</strong>
                          </div>
                          <p>
                            {stamp(bar.at)} → {stamp(decision.at)}
                          </p>
                          <div className="strategy-stepper">
                            <button
                              className="button"
                              disabled={hour === 0}
                              onClick={() => setHour((i) => i - 1)}
                            >
                              ← Previous hour
                            </button>
                            <button
                              className="button"
                              disabled={hour === detail.bars.length - 1}
                              onClick={() => setHour((i) => i + 1)}
                            >
                              Next hour →
                            </button>
                            <button
                              className="button"
                              disabled={
                                !detail.report.decisions
                                  .slice(hour + 1)
                                  .some((d) => d.action === 'LONG' || d.action === 'EXIT')
                              }
                              onClick={() => {
                                const next = detail.report.decisions
                                  .slice(hour + 1)
                                  .find((d) => d.action === 'LONG' || d.action === 'EXIT');
                                if (next) setHour(next.index);
                              }}
                            >
                              Next long / exit
                            </button>
                            <span>
                              {hour + 1} / {detail.bars.length}
                            </span>
                          </div>
                          <input
                            className="strategy-hour-slider"
                            type="range"
                            min="0"
                            max={detail.bars.length - 1}
                            value={hour}
                            onChange={(e) => setHour(Number(e.target.value))}
                            aria-label="Candle hour"
                          />
                          <p>
                            <strong>{decision.reason}</strong>
                          </p>
                          {decision.executionNote && <p>{decision.executionNote}</p>}
                          <div className="strategy-metrics">
                            {[
                              ['Open / close', `${money(bar.open, 5)} / ${money(bar.close, 5)}`],
                              [
                                'MA20 / MA50',
                                `${money(decision.fast, 5)} / ${money(decision.slow, 5)}`,
                              ],
                              [
                                'ATR / MA200',
                                `${money(decision.atr, 5)} / ${money(decision.trend ?? null, 5)}`,
                              ],
                              [
                                'Stop / target',
                                `${money(decision.stop, 5)} / ${money(decision.target, 5)}`,
                              ],
                              ['Position', `${money(decision.position, 8)} ${asset}`],
                              [
                                'Cash / equity',
                                `${money(decision.cash)} / ${money(decision.equity)} USDT`,
                              ],
                            ].map(([label, value]) => (
                              <div key={label}>
                                <small>{label}</small>
                                <strong>{value}</strong>
                              </div>
                            ))}
                          </div>
                          <p>
                            Entry gate: {decision.entryGate ?? 'Baseline crossover'} · Range / ATR:{' '}
                            {money(decision.signalRangeAtr ?? null)} · Close location:{' '}
                            {decision.closeLocation ? pct(decision.closeLocation) : 'N/A'}
                          </p>
                        </section>
                      )}
                      <section className="panel">
                        <h2>Virtual fills</h2>
                        <p>
                          Signals propose the following open; actual fills are below. Slippage is
                          embedded in price. Fees are separate.
                        </p>
                        <div className="table-wrap">
                          <table>
                            <thead>
                              <tr>
                                <th>Time</th>
                                <th>Side</th>
                                <th>Quantity {asset}</th>
                                <th>Price USDT</th>
                                <th>Fee / slip</th>
                                <th>Reason</th>
                              </tr>
                            </thead>
                            <tbody>
                              {detail.report.trades.slice(page * 20, page * 20 + 20).map((t, i) => (
                                <tr key={`${t.index}-${i}`}>
                                  <td>
                                    <button
                                      className="strategy-text-button"
                                      onClick={() => setHour(t.index)}
                                    >
                                      {stamp(t.at)} ↗
                                    </button>
                                  </td>
                                  <td>{t.side}</td>
                                  <td>{money(t.quantity, 8)}</td>
                                  <td>{money(t.price, 5)}</td>
                                  <td>
                                    {money(t.fee, 4)} / {money(t.slippage, 4)}
                                  </td>
                                  <td>{t.reason}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        <div className="strategy-stepper">
                          <button
                            className="button"
                            disabled={page === 0}
                            onClick={() => setPage((i) => i - 1)}
                          >
                            Previous fills
                          </button>
                          <span>
                            Page {page + 1} /{' '}
                            {Math.max(1, Math.ceil(detail.report.trades.length / 20))}
                          </span>
                          <button
                            className="button"
                            disabled={(page + 1) * 20 >= detail.report.trades.length}
                            onClick={() => setPage((i) => i + 1)}
                          >
                            Next fills
                          </button>
                          <button
                            className="button"
                            disabled={verifying}
                            onClick={() => {
                              void verify();
                            }}
                          >
                            {verifying ? 'Verifying…' : 'Verify exact replay'}
                          </button>
                        </div>
                        {verified === detail.id && (
                          <p role="status">
                            Verified: decisions, fills and the balanced journal reproduce exactly.
                          </p>
                        )}
                        <p className="strategy-hash">
                          Report {detail.id}
                          <br />
                          Dataset {detail.report.datasetId}
                          <br />
                          Engine {detail.report.engineHash}
                        </p>
                      </section>
                    </>
                  )
                )}
              </>
            )}
            {tab === 'Sources' && (
              <>
                <section className="panel">
                  <h2>Research boundaries and sources</h2>
                  <p>
                    SOL and XRP are the only development assets in this lab. The earlier all-coin
                    page, its settings, source files and results are preserved. These two coins were
                    chosen after seeing their prior performance; that selection itself is a source
                    of bias.
                  </p>
                  <p>
                    Use the same frozen public hourly candles as the original market tests.
                    Historical first-availability remains UNKNOWN. Current exchange
                    tick/lot/notional filters are applied retrospectively. No bid/ask depth, maker
                    queue, short, leverage, funding or liquidation is reconstructed.
                  </p>
                  <p>
                    The earlier development period chooses one candidate per coin. All candidates
                    are retained, including failures and negative outcomes. The later check resets
                    its account, retains earlier indicator context, and must not be called unseen or
                    independent: this history was already examined. Future profitability is not
                    established, especially with few closed trades.
                  </p>
                  <p>
                    The selected profile is fixed when displaying fees off; the search is not rerun
                    to choose a different fee-free winner. Risk caps and starting capital are
                    unchanged. Cash remains 10,000 USDT. Buy-and-hold uses higher exposure than
                    active strategies.
                  </p>
                  <p className="strategy-hash">
                    Matrix {matrix.id}
                    <br />
                    Original comparison {matrix.matrix.sourceMatrixId}
                    <br />
                    Engine {matrix.matrix.engineHash}
                    <br />
                    Generated{' '}
                    {matrix.matrix.generatedAt ?? 'Recorded in the prior research artifact'}
                  </p>
                </section>
                {matrix.matrix.rows.map((r) => (
                  <section className="panel" key={r.asset}>
                    <h2>{r.asset} / USDT</h2>
                    <p className="strategy-hash">Dataset {r.datasetId}</p>
                    <p>
                      Original v1/v2/v3 report IDs remain in the matrix export. Source response
                      URLs, hashes, actual capture times and per-coin filters are included in any
                      selected report export.
                    </p>
                    <button
                      className="button"
                      onClick={() => {
                        setAsset(r.asset);
                        setStrategy('V4');
                        setTab('Trade explorer');
                      }}
                    >
                      Open {r.asset} source-linked v4
                    </button>
                  </section>
                ))}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
