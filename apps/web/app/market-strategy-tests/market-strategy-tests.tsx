'use client';
import './market-strategy-tests.css';
import { useEffect, useState, useRef } from 'react';
import { z } from 'zod';
import {
  MarketCatalogSchema,
  MarketStateSchema,
  MarketMatrixSchema,
  MarketReportViewSchema,
  MarketJobSchema,
  DEFAULT_MARKET_FEES,
} from '@crypto/contracts';
import type { MarketAsset, MarketStrategyKey, MarketFees } from '@crypto/contracts';

const Matrix = z.strictObject({ id: z.string(), matrix: MarketMatrixSchema });
type MatrixView = z.infer<typeof Matrix>;
type ReportView = z.infer<typeof MarketReportViewSchema>;
type Cell = z.infer<typeof MarketMatrixSchema>['rows'][number]['cells'][number];
const tabs = ['Results', 'Strategies', 'Trade explorer', 'Sources & assumptions'] as const;
type Tab = (typeof tabs)[number];
const money = (value: string | number | null, digits = 2) =>
  value === null
    ? 'N/A'
    : Number(value).toLocaleString('en-US', {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });
const pct = (value: string) => `${(Number(value) * 100).toFixed(2)}%`;
const date = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
const direction = (value: string) =>
  Number(value) > 0 ? 'strategy-profit' : Number(value) < 0 ? 'strategy-loss' : 'strategy-flat';
async function request<T>(path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
  const response = await fetch(`/api/market-strategies${path}`, {
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
  if (!response.ok)
    throw new Error(
      response.status === 401
        ? 'Your session expired. Refresh the page to reconnect.'
        : response.status === 404
          ? 'No completed results yet. Run all market tests to begin.'
          : 'The market research request failed. Retry or check the local research API.',
    );
  return schema.parse(await response.json());
}
function Outcome({ cell }: { cell: Cell }) {
  const net = Number(cell.summary.netPnl),
    a = cell.attribution;
  return (
    <p className="strategy-explanation">
      {cell.summary.closedTrades === 0 && cell.summary.openBase === '0'
        ? 'No trades passed the rules. The account stayed in USDT; a flat result does not demonstrate prediction skill.'
        : net < 0
          ? Number(a.beforeFeesAndSlippage) > 0
            ? Number(cell.summary.fees) === 0
              ? 'The recorded trades had a positive result before adverse slippage, but slippage and tick rounding outweighed it.'
              : 'The recorded trades had a positive result before recorded costs, but fees and adverse slippage outweighed it.'
            : 'Trading losses remained after costs; avoided trades and risk caps did not create a positive edge in this window.'
          : net > 0
            ? 'Profitable trades and any open-position mark outweighed losses and recorded trading costs in this window.'
            : 'Wins, losses and recorded costs balanced in this window.'}{' '}
      Closed positions contributed {money(a.closedNet)} USDT; the open position contributed{' '}
      {money(a.openContribution)} USDT, including its entry costs.
    </p>
  );
}
function Curve({ data }: { data: ReportView }) {
  const values = data.report.decisions.map((d) => Number(d.equity)),
    low = Math.min(10000, ...values),
    high = Math.max(10000, ...values),
    padding = Math.max(5, (high - low) * 0.1),
    min = low - padding,
    max = high + padding;
  const x = (i: number) => 64 + (i * 860) / Math.max(1, values.length - 1),
    y = (v: number) => 24 + ((max - v) * 200) / (max - min);
  return (
    <>
      <svg
        className="equity-chart strategy-curve"
        viewBox="0 0 960 270"
        role="img"
        aria-label={`${data.report.asset} ${data.report.plan.strategy} net equity versus 10,000 USDT cash`}
      >
        {[0, 1, 2, 3].map((i) => (
          <g key={i}>
            <line
              x1="64"
              x2="925"
              y1={24 + (i * 200) / 3}
              y2={24 + (i * 200) / 3}
              stroke="#e0e5dc"
            />
            <text x="0" y={29 + (i * 200) / 3} className="chart-label">
              {money(max - (i * (max - min)) / 3, 0)}
            </text>
          </g>
        ))}
        <line x1="64" x2="924" y1={y(10000)} y2={y(10000)} stroke="#95a1a2" strokeDasharray="6 5" />
        <polyline
          fill="none"
          stroke="#287e72"
          strokeWidth="2"
          points={values.map((v, i) => `${x(i)},${y(v)}`).join(' ')}
        />
        <text x="64" y="256" className="chart-label">
          {date(data.dataset.from)}
        </text>
        <text x="924" y="256" textAnchor="end" className="chart-label">
          {date(data.dataset.to)}
        </text>
      </svg>
      <p className="muted">
        Green: strategy equity after costs · Dashed: 10,000 USDT cash. Vertical scale follows the
        selected result.
      </p>
    </>
  );
}
function FeeToggle({
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
  onChange: (on: boolean) => void;
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
        aria-label={label}
      />
      <span>
        {label}
        <small>{mixed ? 'Mixed' : checked ? 'On · 0.10% per side' : 'Off · 0% fees'}</small>
      </span>
    </label>
  );
}
export default function MarketStrategyTests() {
  const [tab, setTab] = useState<Tab>('Results'),
    [catalog, setCatalog] = useState<z.infer<typeof MarketCatalogSchema>>([]),
    [state, setState] = useState<z.infer<typeof MarketStateSchema> | null>(null),
    [matrix, setMatrix] = useState<MatrixView | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [starting, setStarting] = useState(false),
    [feeSaving, setFeeSaving] = useState(false);
  const [asset, setAsset] = useState<MarketAsset>('BTC'),
    [strategy, setStrategy] = useState<MarketStrategyKey>('V3'),
    [report, setReport] = useState<ReportView | null>(null),
    [reportLoading, setReportLoading] = useState(false),
    [hour, setHour] = useState(0),
    [page, setPage] = useState(0),
    [verification, setVerification] = useState<{ id: string; message: string } | null>(null),
    [verifying, setVerifying] = useState(false);
  async function load() {
    setLoading(true);
    setError('');
    try {
      const [next, descriptions] = await Promise.all([
        request('', MarketStateSchema),
        request('/catalog', MarketCatalogSchema),
      ]);
      setCatalog(descriptions);
      setState(next);
      if (next.matrixId) setMatrix(await request('/matrix', Matrix));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load research.');
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
    const poll = setInterval(() => {
      void (async () => {
        try {
          const next = await request('', MarketStateSchema);
          if (!active) return;
          setState(next);
          if (next.job?.status !== 'RUNNING' && next.matrixId) {
            const result = await request('/matrix', Matrix);
            if (active) setMatrix(result);
          }
        } catch (e) {
          if (active) setError(e instanceof Error ? e.message : 'Could not check progress.');
        }
      })();
    }, 1500);
    return () => {
      active = false;
      clearInterval(poll);
    };
  }, [state?.job?.id, state?.job?.status]);
  useEffect(() => {
    if (tab !== 'Trade explorer' || !matrix) return;
    const cell = matrix.matrix.rows
      .find((r) => r.asset === asset)
      ?.cells.find((c) => c.strategy === strategy);
    setReport(null);
    setVerification(null);
    setPage(0);
    setHour(0);
    if (!cell) {
      setReportLoading(false);
      return;
    }
    let active = true;
    setReportLoading(true);
    void request(`/report?asset=${asset}&strategy=${strategy}`, MarketReportViewSchema)
      .then((value) => {
        if (active) {
          setReport(value);
          setHour(value.report.decisions.find((d) => d.action === 'LONG')?.index ?? 0);
        }
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : 'Could not open report.');
      })
      .finally(() => {
        if (active) setReportLoading(false);
      });
    return () => {
      active = false;
    };
  }, [asset, strategy, tab, matrix]);
  async function run() {
    setStarting(true);
    setError('');
    try {
      const job = await request('/run', MarketJobSchema, {});
      setState((previous) => ({
        matrixId: previous?.matrixId ?? null,
        job,
        fees: previous?.fees ?? DEFAULT_MARKET_FEES,
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start tests.');
    } finally {
      setStarting(false);
    }
  }
  async function changeFees(fees: MarketFees) {
    setFeeSaving(true);
    setError('');
    try {
      const next = await request('/fees', MarketStateSchema, { fees });
      const result = next.matrixId ? await request('/matrix', Matrix) : null;
      setMatrix(result);
      setState(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save fee settings.');
    } finally {
      setFeeSaving(false);
    }
  }
  async function verify() {
    setVerifying(true);
    setVerification(null);
    try {
      const value = await request(
        '/verify',
        z.object({ verified: z.literal(true), reportId: z.string() }),
        {
          asset,
          strategy,
        },
      );
      setVerification({
        id: value.reportId,
        message: 'Verified: decisions, fills and ledger reproduce exactly.',
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Replay verification failed.');
    } finally {
      setVerifying(false);
    }
  }
  function inspect(selectedAsset: MarketAsset, selectedStrategy: MarketStrategyKey) {
    setAsset(selectedAsset);
    setStrategy(selectedStrategy);
    setTab('Trade explorer');
  }
  const busy = state?.job?.status === 'RUNNING' || starting,
    m = matrix?.matrix,
    activeFees =
      m?.fees ??
      (m?.feeMode === 'ZERO'
        ? { V1: false, V2: false, V3: false }
        : (state?.fees ?? DEFAULT_MARKET_FEES)),
    selectedFees = state?.fees ?? DEFAULT_MARKET_FEES,
    allFees = Object.values(selectedFees).every(Boolean),
    mixedFees = Object.values(selectedFees).some(Boolean) && !allFees,
    feeDescription = Object.values(activeFees).every(Boolean)
      ? 'Trading fees on: 0.10% per side.'
      : Object.values(activeFees).every((on) => !on)
        ? 'Trading fees off: 0% per side.'
        : 'Mixed fee settings: see each strategy’s on/off label.',
    selectedRow = m?.rows.find((r) => r.asset === asset),
    selectedCell = selectedRow?.cells.find((c) => c.strategy === strategy),
    decision = report?.report.decisions[hour],
    bar = report?.bars[hour];
  return (
    <div className="strategy-tests">
      <div className="context-bar">
        <span className="context-dot" />
        <strong>Real historical data</strong>
        <span>Hourly candles · 10,000 virtual USDT per test</span>
        <span className="context-status">RETROSPECTIVE SIMULATION</span>
      </div>
      <section className="panel strategy-intro">
        <div>
          <div className="eyebrow">TEN MARKETS / THREE FROZEN STRATEGIES</div>
          <h2>Compare the rules. Inspect the evidence.</h2>
          <p>
            BTC, ETH, SOL, TRX, BNB, XRP, DOGE, ADA, LINK and AVAX, each quoted in USDT. All three
            strategies replay the same candles for each coin. USDT appears as the cash baseline.
          </p>
          {m && (
            <p>
              <strong>
                {date(m.from)} → {date(m.to)}
              </strong>{' '}
              · End exclusive · {m.rows.filter((r) => r.status === 'COMPLETE').length}/10 markets
              complete
            </p>
          )}
          <p className="muted">
            Each cell is an independent account. Results cannot be added into a portfolio balance.
            Entry and exit rules are unchanged.
          </p>
          <p>
            <strong>{feeDescription}</strong> Adverse slippage remains 0.05% per side plus tick
            rounding. Buy-and-hold uses the matching strategy’s fee setting.
          </p>
        </div>
        <div className="strategy-actions">
          <button
            className="primary"
            disabled={busy || loading || feeSaving}
            onClick={() => {
              void run();
            }}
          >
            {busy ? 'Tests running…' : m ? 'Rerun all market tests' : 'Run all market tests'}
          </button>
          {matrix && (
            <a className="button" href="/api/market-strategies/export">
              ↓ Export all results
            </a>
          )}
        </div>
      </section>
      <section
        className="panel strategy-fee-controls"
        aria-label="Trading fee settings"
        aria-busy={feeSaving}
      >
        <div>
          <h2>Trading fees</h2>
          <p>
            The global switch sets every strategy. Change a strategy individually to override it for
            all coins and positions. Settings are saved; calculated results switch immediately.
          </p>
        </div>
        <div className="strategy-fee-switches">
          <FeeToggle
            label="Fees for all strategies"
            checked={allFees}
            mixed={mixedFees}
            disabled={busy || loading || feeSaving}
            onChange={(on) => {
              void changeFees({ V1: on, V2: on, V3: on });
            }}
          />
          {(['V1', 'V2', 'V3'] as const).map((key) => (
            <FeeToggle
              key={key}
              label={`${key} fees`}
              checked={selectedFees[key]}
              disabled={busy || loading || feeSaving}
              onChange={(on) => {
                void changeFees({ ...selectedFees, [key]: on });
              }}
            />
          ))}
        </div>
        <p className="muted" role="status">
          {feeSaving
            ? 'Updating fee settings and results…'
            : m
              ? 'Both fee scenarios are ready. Slippage stays enabled in every test.'
              : 'Choose fees, then run market tests to calculate both scenarios.'}
        </p>
      </section>
      {state?.job && (
        <div className={`notice ${state.job.status === 'FAILED' ? 'error' : ''}`} role="status">
          <strong>{state.job.completedAssets} / 10 markets</strong> · {state.job.message}
          {state.job.status === 'RUNNING' && (
            <progress max="10" value={state.job.completedAssets} aria-label="Markets completed" />
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
            Retry loading
          </button>
        </div>
      )}
      <div className="strategy-tabs" role="tablist" aria-label="Market strategy research">
        {tabs.map((name, i) => (
          <button
            key={name}
            id={`strategy-tab-${i}`}
            type="button"
            role="tab"
            aria-selected={tab === name}
            aria-controls="strategy-tab-panel"
            tabIndex={tab === name ? 0 : -1}
            className={tab === name ? 'selected' : ''}
            onClick={() => setTab(name)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                event.preventDefault();
                const next = (i + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
                setTab(tabs[next]!);
                document.getElementById(`strategy-tab-${next}`)?.focus();
              }
            }}
          >
            {name}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id="strategy-tab-panel"
        aria-labelledby={`strategy-tab-${tabs.indexOf(tab)}`}
      >
        {loading && <div className="panel empty">Loading frozen market research…</div>}
        {!loading && tab === 'Results' && (
          <>
            {!m ? (
              <section className="panel empty">
                <h2>Start with the same six-month window</h2>
                <p>
                  Run all market tests to capture public hourly candles and replay v1, v2 and v3.
                  The window comes from the latest frozen BTC history on the BTC market test page.
                </p>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => {
                    void run();
                  }}
                >
                  Run all market tests
                </button>
              </section>
            ) : (
              <>
                <section className="panel">
                  <div className="panel-title">
                    <div>
                      <h2>Net results after trading costs</h2>
                      <p>
                        Select any result to see its trades, signals and reasons. Negative and
                        failed tests stay visible.
                      </p>
                    </div>
                  </div>
                  <div className="table-wrap">
                    <table className="strategy-matrix">
                      <thead>
                        <tr>
                          <th scope="col">Market / candles</th>
                          {catalog.map((s) => (
                            <th scope="col" key={s.key}>
                              {s.key} · {s.name}
                              <small>Fees {activeFees[s.key] ? 'on · 0.10%' : 'off · 0%'}</small>
                            </th>
                          ))}
                          <th scope="col">Buy & hold by strategy</th>
                        </tr>
                      </thead>
                      <tbody>
                        {m.rows.map((row) => (
                          <tr key={row.asset}>
                            <th scope="row">
                              {row.asset} / USDT
                              <small>
                                {row.candles.toLocaleString()} hourly candles
                                {row.btcReferenceReproduced
                                  ? ' · Original BTC rules verified with standard fees'
                                  : ''}
                              </small>
                            </th>
                            {row.status === 'FAILED' ? (
                              <td colSpan={4}>
                                <span className="strategy-loss">Failed: {row.error}</span>
                                <br />
                                No result is reported for missing or invalid data.
                              </td>
                            ) : (
                              <>
                                {(['V1', 'V2', 'V3'] as const).map((key) => {
                                  const cell = row.cells.find((c) => c.strategy === key)!;
                                  return (
                                    <td key={key}>
                                      <button
                                        className="strategy-result"
                                        onClick={() => inspect(row.asset, key)}
                                        aria-label={`Inspect ${row.asset} ${key}: ${money(cell.summary.netPnl)} USDT net`}
                                      >
                                        <strong className={direction(cell.summary.netPnl)}>
                                          {Number(cell.summary.netPnl) > 0 ? '+' : ''}
                                          {money(cell.summary.netPnl)} <small>USDT</small>
                                        </strong>
                                        <span>
                                          {pct(cell.summary.returnFraction)} · Equity{' '}
                                          {money(cell.summary.finalEquity)}
                                        </span>
                                        <span>
                                          {cell.summary.closedTrades} closed · {cell.summary.wins}{' '}
                                          wins · DD {pct(cell.summary.maxDrawdown)}
                                        </span>
                                        <span>
                                          Fees {money(cell.summary.fees)} · Slippage{' '}
                                          {money(cell.summary.slippage)}
                                        </span>
                                        <span className="strategy-link">Inspect decisions ↗</span>
                                      </button>
                                    </td>
                                  );
                                })}
                                <td>
                                  {row.cells.map((cell) => (
                                    <div key={cell.strategy}>
                                      {cell.strategy}: {money(cell.summary.buyHoldEquity)} USDT
                                    </div>
                                  ))}
                                  <small>Higher market exposure</small>
                                </td>
                              </>
                            )}
                          </tr>
                        ))}
                        <tr className="strategy-cash">
                          <th scope="row">
                            USDT cash<small>Quote-currency baseline</small>
                          </th>
                          {['V1', 'V2', 'V3'].map((key) => (
                            <td key={key}>
                              <strong>0.00 USDT</strong>
                              <small>
                                0.00% · Equity 10,000.00
                                <br />0 trades · 0 fees
                              </small>
                            </td>
                          ))}
                          <td>
                            10,000.00 USDT<small>USD peg changes are not modeled</small>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  <p className="muted">
                    Drawdown is measured at hourly closes and can miss intrabar lows. Open positions
                    are marked at the final close; final exit costs are not charged. Fees and
                    adverse slippage are already included in net P&L.
                  </p>
                </section>
                <section className="panel">
                  <h2>What the comparison can tell us</h2>
                  <p>
                    Filters can reduce expensive or weak entries, but can also miss profitable
                    moves. A later version is only better for a particular test when its measured
                    results justify that claim. Three strategy versions are shown; v2 and v3 were
                    developed after seeing the BTC period.
                  </p>
                  <p>
                    These ten coins share market regimes and are correlated. This fixed list of
                    currently available assets is not a historical top-coin universe. Results are
                    exploratory and do not establish a forward trading edge.
                  </p>
                </section>
              </>
            )}
          </>
        )}
        {!loading && tab === 'Strategies' && (
          <>
            <div className="strategy-card-grid">
              {catalog.map((s) => {
                const cells =
                  m?.rows.flatMap((r) => r.cells.filter((c) => c.strategy === s.key)) ?? [];
                return (
                  <section className="panel strategy-card" key={s.key}>
                    <div className="eyebrow">
                      {s.key} / {s.warmupHours} HOUR WARM-UP
                    </div>
                    <h2>{s.name}</h2>
                    <p>{s.description}</p>
                    <h3>Decision rules</h3>
                    <ul>
                      {s.rules.map((rule) => (
                        <li key={rule}>{rule}</li>
                      ))}
                    </ul>
                    <h3>Why this change may help</h3>
                    <p>{s.intendedImprovement}</p>
                    <h3>Why it can lose or miss profits</h3>
                    <ul>
                      {s.failureModes.map((f) => (
                        <li key={f}>{f}</li>
                      ))}
                    </ul>
                    {cells.length > 0 && (
                      <p className="strategy-score">
                        This window: {cells.filter((c) => Number(c.summary.netPnl) > 0).length}{' '}
                        profitable / {cells.filter((c) => Number(c.summary.netPnl) < 0).length}{' '}
                        losing / {cells.filter((c) => Number(c.summary.netPnl) === 0).length} flat
                        markets. {10 - cells.length} unavailable. Counts exclude USDT cash.
                      </p>
                    )}
                  </section>
                );
              })}
            </div>
            <section className="panel">
              <h2>Execution and risk rules shared by every version</h2>
              <p>
                Long, hold and exit for spot markets. Shorting and leverage are disabled. Signals
                use completed candles and orders fill at the next candle open. A 2 ATR stop and 3
                ATR target protect positions; if both are touched in one candle the stop is applied
                first. Gaps use the worse open price.
              </p>
              <p>
                ATR uses 14 hourly candles. Risk is capped at 0.25% of equity per entry, allocation
                at 10%, and participation at 1% of the previous completed candle’s volume. A 2% UTC
                daily loss limit blocks new entries. Fee assumption:{' '}
                {(['V1', 'V2', 'V3'] as const)
                  .map((key) => `${key}: ${activeFees[key] ? '0.10%' : '0%'}`)
                  .join(' · ')}{' '}
                per side; adverse slippage: 0.05% per side plus tick rounding. Buy-and-hold uses the
                same cost assumptions.
              </p>
              <p>
                Each coin uses its captured price tick, lot size and minimum notional. Current
                exchange filters are applied throughout the history as a research assumption;
                historical filters and historical first-availability times are unknown.
              </p>
            </section>
          </>
        )}
        {!loading && tab === 'Trade explorer' && (
          <>
            <section className="panel">
              <div className="strategy-selectors">
                <label>
                  Market
                  <select value={asset} onChange={(e) => setAsset(e.target.value as MarketAsset)}>
                    {(m?.rows ?? []).map((row) => (
                      <option key={row.asset} value={row.asset}>
                        {row.asset} / USDT{row.status === 'FAILED' ? ' — unavailable' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Strategy
                  <select
                    value={strategy}
                    onChange={(e) => setStrategy(e.target.value as MarketStrategyKey)}
                  >
                    {catalog.map((s) => (
                      <option key={s.key} value={s.key}>
                        {s.key} · {s.name}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="muted">USDT cash has no orders or price signals.</span>
              </div>
            </section>
            {reportLoading ? (
              <div className="panel empty">Opening verified candles and decisions…</div>
            ) : !report ? (
              <div className="panel empty">
                {selectedRow?.error ??
                  'Run market tests, then select a completed market and strategy.'}
              </div>
            ) : (
              selectedCell && (
                <>
                  <section className="panel">
                    <div className="panel-title">
                      <div>
                        <div className="eyebrow">
                          {report.report.asset} / {report.report.plan.strategy}
                          {' · Fees '}
                          {report.report.plan.feeMode === 'ZERO' ? 'off (0%)' : 'on (0.10%)'}
                        </div>
                        <h2>
                          Why this test{' '}
                          {Number(report.report.summary.netPnl) < 0
                            ? 'lost money'
                            : Number(report.report.summary.netPnl) > 0
                              ? 'made money'
                              : 'finished flat'}
                        </h2>
                      </div>
                      <a
                        className="button"
                        href={`/api/market-strategies/report-export?asset=${asset}&strategy=${strategy}`}
                      >
                        ↓ Export selected test
                      </a>
                    </div>
                    <Outcome cell={selectedCell} />
                    <div className="strategy-metrics">
                      {[
                        ['Final equity', `${money(report.report.summary.finalEquity)} USDT`],
                        [
                          'Net P&L',
                          `${money(report.report.summary.netPnl)} USDT (${pct(report.report.summary.returnFraction)})`,
                        ],
                        [
                          'Fees / slippage',
                          `${money(report.report.summary.fees)} / ${money(report.report.summary.slippage)} USDT`,
                        ],
                        [
                          'Closed trades / wins',
                          `${report.report.summary.closedTrades} / ${report.report.summary.wins}`,
                        ],
                        [
                          'Average win / loss',
                          `${money(report.attribution.averageWin)} / ${money(report.attribution.averageLoss)} USDT`,
                        ],
                        [
                          'Exposure / max drawdown',
                          `${pct(selectedCell.exposureFraction)} / ${pct(report.report.summary.maxDrawdown)}`,
                        ],
                      ].map(([label, value]) => (
                        <div key={label}>
                          <small>{label}</small>
                          <strong>{value}</strong>
                        </div>
                      ))}
                    </div>
                    <Curve data={report} />
                    <h3>Closed trades grouped by exit reason</h3>
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Exit</th>
                            <th>Closed / wins</th>
                            <th>Net USDT</th>
                            <th>Fees / slippage</th>
                            <th>Average hours</th>
                          </tr>
                        </thead>
                        <tbody>
                          {report.attribution.groups.map((g) => (
                            <tr key={g.reason}>
                              <td>{g.reason}</td>
                              <td>
                                {g.count} / {g.wins}
                              </td>
                              <td className={direction(g.net)}>{money(g.net)}</td>
                              <td>
                                {money(g.fees)} / {money(g.slippage)}
                              </td>
                              <td>{money(g.averageHours, 1)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {!report.attribution.groups.length && <p>No closed trades in this test.</p>}
                    <p className="muted">
                      Recorded same-fill result before fees and slippage:{' '}
                      {money(report.attribution.beforeFeesAndSlippage)} USDT. This accounting
                      diagnostic does not simulate how trades would change under different costs. Up
                      to 12-hour trades: {report.attribution.shortHoldCount}, net{' '}
                      {money(report.attribution.shortHoldNet)} USDT.
                    </p>
                    {Object.keys(selectedCell.gateCounts).length > 0 && (
                      <p className="muted">
                        Entry gates across all hourly decisions:{' '}
                        {Object.entries(selectedCell.gateCounts)
                          .map(([gate, count]) => `${gate}: ${count}`)
                          .join(' · ')}
                        . These are hourly states, not a count of rejected orders.
                      </p>
                    )}
                  </section>
                  {decision && bar && (
                    <section className="panel">
                      <div className="panel-title">
                        <div>
                          <h2>Inspect one completed hour</h2>
                          <p>
                            {date(bar.at)} → {date(decision.at)}
                          </p>
                        </div>
                        <span className="strategy-action-label">{decision.action}</span>
                      </div>
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
                          disabled={hour === report.report.decisions.length - 1}
                          onClick={() => setHour((i) => i + 1)}
                        >
                          Next hour →
                        </button>
                        <button
                          className="button"
                          disabled={
                            !report.report.decisions
                              .slice(hour + 1)
                              .some((d) => d.action === 'LONG' || d.action === 'EXIT')
                          }
                          onClick={() => {
                            const next = report.report.decisions
                              .slice(hour + 1)
                              .find((d) => d.action === 'LONG' || d.action === 'EXIT');
                            if (next) setHour(next.index);
                          }}
                        >
                          Next long / exit
                        </button>
                        <span>
                          {hour + 1} / {report.bars.length}
                        </span>
                      </div>
                      <input
                        className="strategy-hour-slider"
                        type="range"
                        min="0"
                        max={report.bars.length - 1}
                        value={hour}
                        onChange={(e) => setHour(Number(e.target.value))}
                        aria-label="Historical candle hour"
                      />
                      <p>
                        <strong>{decision.reason}</strong>
                      </p>
                      {decision.executionNote && <p>{decision.executionNote}</p>}
                      <div className="strategy-metrics">
                        {[
                          ['Open / close', `${money(bar.open, 5)} / ${money(bar.close, 5)}`],
                          ['High / low', `${money(bar.high, 5)} / ${money(bar.low, 5)}`],
                          [
                            'MA20 / MA50',
                            `${money(decision.fast, 5)} / ${money(decision.slow, 5)}`,
                          ],
                          [
                            'ATR14 / MA200',
                            `${money(decision.atr, 5)} / ${money(decision.trend ?? null, 5)}`,
                          ],
                          [
                            'Stop / target',
                            `${money(decision.stop, 5)} / ${money(decision.target, 5)}`,
                          ],
                          [
                            'Position / proposed quantity',
                            `${money(decision.position, 8)} / ${money(decision.quantity, 8)} ${asset}`,
                          ],
                        ].map(([label, value]) => (
                          <div key={label}>
                            <small>{label}</small>
                            <strong>{value}</strong>
                          </div>
                        ))}
                      </div>
                      <p className="muted">
                        Signal time is the candle close. A LONG or EXIT proposes an order for the
                        following open; fills below show what actually happened. Protective
                        stop/target exits can occur inside a candle.
                      </p>
                      <p>
                        Cash {money(decision.cash)} USDT · Equity {money(decision.equity)} USDT
                        {decision.entryGate ? ` · Gate: ${decision.entryGate}` : ''}
                        {decision.closeLocation
                          ? ` · Close location: ${pct(decision.closeLocation)}`
                          : ''}
                        {decision.signalRangeAtr
                          ? ` · Range / ATR: ${money(decision.signalRangeAtr)}`
                          : ''}
                      </p>
                    </section>
                  )}
                  <section className="panel">
                    <div className="panel-title">
                      <div>
                        <h2>Virtual fills</h2>
                        <p>
                          Fees are separate from fill prices; adverse slippage is embedded in the
                          price.
                        </p>
                      </div>
                      <span>{report.report.trades.length} fills</span>
                    </div>
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Time / candle</th>
                            <th>Side</th>
                            <th>Quantity {asset}</th>
                            <th>Price USDT</th>
                            <th>Fee / slippage USDT</th>
                            <th>Reason</th>
                          </tr>
                        </thead>
                        <tbody>
                          {report.report.trades.slice(page * 20, page * 20 + 20).map((fill, i) => (
                            <tr key={`${fill.index}-${i}`}>
                              <td>
                                <button
                                  className="strategy-text-button"
                                  onClick={() => setHour(fill.index)}
                                >
                                  {date(fill.at)} ↗
                                </button>
                              </td>
                              <td>{fill.side}</td>
                              <td>{money(fill.quantity, 8)}</td>
                              <td>{money(fill.price, 5)}</td>
                              <td>
                                {money(fill.fee, 4)} / {money(fill.slippage, 4)}
                              </td>
                              <td>{fill.reason}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {report.report.trades.length === 0 && (
                      <p>No fills; the strategy remained in cash.</p>
                    )}
                    <div className="strategy-stepper">
                      <button
                        className="button"
                        disabled={page === 0}
                        onClick={() => setPage((i) => i - 1)}
                      >
                        Previous fills
                      </button>
                      <span>
                        Page {page + 1} / {Math.max(1, Math.ceil(report.report.trades.length / 20))}
                      </span>
                      <button
                        className="button"
                        disabled={(page + 1) * 20 >= report.report.trades.length}
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
                        {verifying ? 'Verifying…' : 'Verify deterministic replay'}
                      </button>
                    </div>
                    {verification?.id === report.id && <p role="status">{verification.message}</p>}
                    <p className="strategy-hash">
                      Report {report.id}
                      <br />
                      Dataset {report.report.datasetId}
                      <br />
                      Engine {report.report.engineHash}
                    </p>
                  </section>
                </>
              )
            )}
          </>
        )}
        {!loading && tab === 'Sources & assumptions' && (
          <>
            <section className="panel">
              <h2>What is real, and what is simulated</h2>
              <p>
                Prices and volumes are captured public Binance spot hourly candles for each named
                coin. The BTC snapshot anchors the exact calendar window. Public raw responses,
                exchange metadata and decimal-preserving Parquet candles are stored locally with
                hashes. Replays and virtual fills are simulations.
              </p>
              <ul>
                <li>
                  Each strategy starts with 10,000 USDT; each coin is tested independently. USDT is
                  the denomination and cash control. We do not fetch a fictional USDT/USDT pair or
                  test USDT’s USD peg.
                </li>
                <li>
                  Historical candle first-availability times are unknown. Actual download timestamps
                  are retained. These retrospective tests do not pass the native forward-experiment
                  availability gates.
                </li>
                <li>
                  Current PRICE_FILTER, LOT_SIZE and minimum-notional metadata is applied
                  retrospectively. Historical filter changes, order-book liquidity and spread are
                  not reconstructed. Trading fees are set independently per strategy:{' '}
                  {(['V1', 'V2', 'V3'] as const)
                    .map((key) => `${key} ${activeFees[key] ? 'on (0.10%)' : 'off (0%)'}`)
                    .join(' · ')}
                  . Static slippage and conservative OHLC fills are assumptions, not exact exchange
                  executions.
                </li>
                <li>
                  Spot only: no short, funding, leverage or liquidation model. Stops and targets are
                  simulated protective exits; resting limit fills and maker queues are not modeled.
                </li>
                <li>
                  The asset list is fixed for this research comparison and includes surviving,
                  currently available coins. It is not a point-in-time ranking. Cross-asset results
                  are correlated, and no threshold search or new strategy tuning is performed.
                </li>
                <li>
                  V2 and v3 were designed after seeing the BTC data. This page retains every
                  strategy and market, including losses, flat runs and failed captures. Small
                  profits and a few trades are not proof of an edge.
                </li>
              </ul>
              {matrix && (
                <p className="strategy-hash">
                  Matrix {matrix.id}
                  <br />
                  Reference BTC dataset {matrix.matrix.referenceBtcDatasetId}
                  <br />
                  Engine {matrix.matrix.engineHash}
                </p>
              )}
            </section>
            {m?.rows.map((row) => (
              <section className="panel" key={row.asset}>
                <div className="panel-title">
                  <h2>{row.asset} / USDT</h2>
                  <span>{row.status}</span>
                </div>
                {row.error && <p className="error">{row.error}</p>}
                <p className="strategy-hash">Dataset {row.datasetId ?? 'Unavailable'}</p>
                {row.filters && (
                  <p>
                    Price tick {row.filters.priceTick} · Quantity step {row.filters.quantityStep} ·
                    Min/max quantity {row.filters.minQty} / {row.filters.maxQty} {row.asset} ·
                    Minimum notional {row.filters.minNotional} USDT
                  </p>
                )}
                <details>
                  <summary>{row.sources.length} captured public responses and hashes</summary>
                  <ul className="strategy-sources">
                    {row.sources.map((source, i) => (
                      <li key={i}>
                        <a href={source.url} target="_blank" rel="noreferrer">
                          {i === 0 ? 'Exchange metadata' : `Hourly candle batch ${i}`}
                        </a>{' '}
                        · Captured {source.receivedAt}
                        <br />
                        <code>{source.hash}</code>
                      </li>
                    ))}
                  </ul>
                  <p className="muted">
                    Source links request the public endpoint again. The frozen bytes used by this
                    test are retained in the local dataset artifact.
                  </p>
                </details>
              </section>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
