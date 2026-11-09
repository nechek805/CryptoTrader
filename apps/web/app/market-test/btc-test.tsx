'use client';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  BTC_PLAN,
  BtcDataViewSchema,
  BtcJobSchema,
  BtcReportSchema,
  BtcStateSchema,
  BtcAnyComparisonSchema,
  HashSchema,
} from '@crypto/contracts';
import BtcComparisonPanel from './comparison-panel';
import type { BtcSelection } from './comparison-panel';

const Report = z.strictObject({ id: HashSchema, report: BtcReportSchema });
const Comparison = z.strictObject({ id: HashSchema, comparison: BtcAnyComparisonSchema });
const date = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const money = (v: string | number) =>
  Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (v: string) => `${(Number(v) * 100).toFixed(2)}%`;
async function request<T>(path: string, schema: z.ZodType<T>, body?: unknown) {
  const response = await fetch(`/api/btc-test${path}`, {
    cache: 'no-store',
    credentials: 'same-origin',
    ...(body !== undefined
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
        ? 'Your research session expired. Refresh this page.'
        : 'The BTC research service could not complete the request. Retry when it is available.',
    );
  return schema.parse((await response.json()) as unknown);
}
function Chart({
  series,
  labels,
  colors,
  caption,
}: {
  series: number[][];
  labels: string[];
  colors: string[];
  caption: string;
}) {
  const values = series.flat();
  if (!values.length) return null;
  const min = Math.min(...values),
    max = Math.max(...values),
    pad = Math.max((max - min) * 0.12, 1),
    lo = min - pad,
    hi = max + pad;
  return (
    <figure className="btc-chart">
      <figcaption>{caption}</figcaption>
      <svg viewBox="0 0 900 240" role="img" aria-label={caption}>
        {[0, 1, 2, 3].map((i) => (
          <g key={i}>
            <line x1="75" x2="890" y1={18 + i * 62} y2={18 + i * 62} stroke="#e2e6df" />
            <text x="0" y={22 + i * 62} className="chart-label">
              {money(hi - ((hi - lo) * i) / 3)}
            </text>
          </g>
        ))}
        {series.map((s, j) => {
          const step = Math.max(1, Math.floor(s.length / 800));
          return (
            <polyline
              key={j}
              fill="none"
              stroke={colors[j]}
              strokeWidth="2"
              strokeDasharray={j === 2 ? '5 5' : undefined}
              points={s
                .flatMap((v, i) =>
                  i % step === 0 || i === s.length - 1
                    ? [
                        `${75 + (i / Math.max(1, s.length - 1)) * 815},${18 + ((hi - v) / (hi - lo)) * 186}`,
                      ]
                    : [],
                )
                .join(' ')}
            />
          );
        })}
      </svg>
      <div className="chart-foot">
        {labels.map((label, i) => (
          <span key={label}>
            <i style={{ background: colors[i] }} />
            {label}
          </span>
        ))}
      </div>
    </figure>
  );
}

export default function BtcTest() {
  const [state, setState] = useState<z.infer<typeof BtcStateSchema> | null>(null),
    [data, setData] = useState<z.infer<typeof BtcDataViewSchema> | null>(null),
    [result, setResult] = useState<z.infer<typeof Report> | null>(null),
    [comparison, setComparison] = useState<z.infer<typeof Comparison> | null>(null);
  const [step, setStep] = useState(1),
    [index, setIndex] = useState(49),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [verified, setVerified] = useState(false),
    [tradePage, setTradePage] = useState(0);
  const dataId = useRef<string | null>(null),
    reportId = useRef<string | null>(null),
    live = useRef(true),
    comparisonId = useRef<string | null>(null);
  const player = useRef<HTMLElement>(null);
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [step]);
  useEffect(() => {
    live.current = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const next = await request('', BtcStateSchema);
        if (!live.current) return;
        setState(next);
        if ((next.comparisonId ?? null) !== comparisonId.current) {
          const value = next.comparisonId ? await request('/comparison', Comparison) : null;
          if (!live.current) return;
          setComparison(value);
          comparisonId.current = next.comparisonId ?? null;
        }
        if (next.datasetId !== dataId.current) {
          const value = next.datasetId ? await request('/data', BtcDataViewSchema) : null;
          if (!live.current) return;
          setData(value);
          dataId.current = next.datasetId;
        }
        if (next.reportId !== reportId.current) {
          const value = next.reportId ? await request('/report', Report) : null;
          if (!live.current) return;
          setResult(value);
          reportId.current = next.reportId;
          setVerified(false);
        }
      } catch (e) {
        if (live.current) setError(e instanceof Error ? e.message : 'BTC research unavailable.');
      }
      if (live.current)
        timer = setTimeout(() => {
          void refresh();
        }, 2000);
    }
    void refresh();
    return () => {
      live.current = false;
      clearTimeout(timer);
    };
  }, []);
  async function start(kind: 'download' | 'run' | 'compare') {
    setBusy(true);
    setError('');
    try {
      const job = await request(
        `/${kind}`,
        BtcJobSchema,
        kind !== 'download' ? { datasetId: data?.id } : {},
      );
      setState((s) => ({ ...s!, job }));
      if (kind !== 'download') {
        setStep(3);
        setIndex(49);
        setTradePage(0);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Research task failed.');
    } finally {
      setBusy(false);
    }
  }
  async function selectStrategy(strategy: BtcSelection) {
    setBusy(true);
    setError('');
    try {
      const selected = await request('/select', Report, { strategy });
      setResult(selected);
      reportId.current = selected.id;
      setStep(3);
      setIndex(selected.report.decisions.find((d) => d.action === 'LONG')?.index ?? 49);
      setTradePage(0);
      setVerified(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open the selected report.');
    } finally {
      setBusy(false);
    }
  }
  const running = busy || state?.job?.status === 'RUNNING',
    report = result?.report,
    decision = report?.decisions[index],
    bar = data?.dataset.bars[index];
  const fills = report?.trades.filter((t) => t.index === index) ?? [];
  const advanceSignal = () => {
    const next = report?.decisions.find(
      (d) =>
        d.index > index &&
        (d.action === 'LONG' ||
          d.action === 'EXIT' ||
          report.trades.some((t) => t.index === d.index)),
    );
    if (next) setIndex(next.index);
    else if (report) setIndex(report.decisions.length - 1);
  };
  return (
    <div className="btc-workflow">
      <div className="context-bar">
        <span className="context-dot" />
        <strong>Real historical data</strong>
        <span>BTC / USDT · hourly candles · market only</span>
        <span className="context-status">RETROSPECTIVE SIMULATION</span>
      </div>
      <nav className="btc-steps" aria-label="BTC test steps">
        {['Load history', 'Review & run', 'Inspect decisions'].map((label, i) => (
          <button
            key={label}
            className={step === i + 1 ? 'active' : ''}
            aria-current={step === i + 1 ? 'step' : undefined}
            disabled={(i === 1 && !data) || (i === 2 && !data)}
            onClick={() => setStep(i + 1)}
          >
            <b>{i + 1}</b>
            <span>
              {label}
              <small>
                {
                  [
                    'Six months of public candles',
                    '10,000 virtual USDT',
                    'One completed hour at a time',
                  ][i]
                }
              </small>
            </span>
          </button>
        ))}
      </nav>
      {comparison && (
        <BtcComparisonPanel
          id={comparison.id}
          c={comparison.comparison}
          busy={!!running}
          onSelect={(strategy) => {
            void selectStrategy(strategy);
          }}
        />
      )}
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      {state?.job && (
        <div className={`notice ${state.job.status === 'FAILED' ? 'error' : ''}`} role="status">
          {state.job.status === 'RUNNING' ? 'Working · ' : ''}
          {state.job.message}
        </div>
      )}
      {!state && <div className="panel empty">Connecting to the BTC research workspace…</div>}
      {step === 1 && (
        <>
          <section className="panel btc-section">
            <div className="btc-section-head">
              <div>
                <div className="eyebrow">01 / SOURCE SNAPSHOT</div>
                <h2>Start with real BTC history</h2>
                <p>
                  Download the six calendar months ending at the latest completed UTC hour. No
                  exchange account or API key is needed.
                </p>
              </div>
              <button
                className="button primary"
                disabled={!state || running}
                onClick={() => {
                  void start('download');
                }}
              >
                {data ? 'Download a fresh snapshot' : 'Load six months of BTC data'}
              </button>
            </div>
            <div className="btc-facts">
              <div>
                <small>Instrument</small>
                <strong>BTCUSDT · spot</strong>
              </div>
              <div>
                <small>Candle interval</small>
                <strong>1 hour</strong>
              </div>
              <div>
                <small>History</small>
                <strong>6 calendar months</strong>
              </div>
              <div>
                <small>Starting balance</small>
                <strong>10,000 virtual USDT</strong>
              </div>
            </div>
            {data && (
              <>
                <div className="btc-data-ok">
                  ✓ {data.dataset.bars.length.toLocaleString()} consecutive closed hourly candles
                  verified
                </div>
                <p>
                  {date(data.dataset.from)} → {date(data.dataset.to)} (end exclusive)
                </p>
                <Chart
                  series={[data.dataset.bars.map((b) => Number(b.close))]}
                  labels={['BTC hourly close · USDT']}
                  colors={['#288c80']}
                  caption="The frozen source history"
                />
                <div className="btc-actions">
                  <button className="button primary" disabled={running} onClick={() => setStep(2)}>
                    Continue to strategy →
                  </button>
                </div>
              </>
            )}
          </section>
          {data && (
            <section className="panel btc-section">
              <h2>Where these numbers come from</h2>
              <p>
                Binance public market-data API. Downloaded {data.dataset.capturedAt}. Original
                response bodies, hashes and an exact-decimal Parquet snapshot are kept locally.
              </p>
              <p className="notice">
                Historical receipt times are unknown. This test assumes each completed candle was
                available at its close. It cannot verify historical publication delays, order-book
                liquidity or actual fills.
              </p>
              <details>
                <summary>Inspect source requests and dataset fingerprint</summary>
                <p className="hash">Dataset: {data.id}</p>
                <div className="data-list">
                  {data.sources.map((s) => (
                    <div key={s.hash}>
                      <a href={s.url} target="_blank" rel="noreferrer">
                        Public BTC candle request ↗
                      </a>
                      <small>{s.url}</small>
                      <small>Received {s.receivedAt}</small>
                      <small className="hash">{s.hash}</small>
                    </div>
                  ))}
                </div>
              </details>
            </section>
          )}
        </>
      )}
      {step === 2 && data && (
        <section className="panel btc-section">
          <div className="eyebrow">02 / FROZEN STRATEGY</div>
          <h2>Review the original and revised rules</h2>
          <p>
            Version {BTC_PLAN.version}. One fixed, untrained rule. No parameter search and no news
            inputs. The 50-candle warm-up is included within the six-month range.
          </p>
          <p>
            Revision v2 keeps the same crossover, stop, target and risk rules. It requires a fresh
            bullish crossover, a close above MA200, MA200 higher than 24 hours earlier, and a 3 ATR
            target at least three times estimated round-trip costs. It needs 224 completed hours and
            does not enter just because the first window is bullish.
          </p>
          <p>
            Revision v3 retains v2 and adds signal-candle quality: close in the upper half of a
            nonzero hourly range and range no larger than 2 ATR14. All three use the same costs,
            risk limits and exit rules.
          </p>
          <div className="btc-rule-grid">
            <article>
              <span>Signal</span>
              <h3>MA20 / MA50 crossover</h3>
              <p>
                LONG on a bullish crossover, or when the first complete MA50 window is already
                bullish. EXIT when the fast average returns to or below the slow average. Otherwise
                HOLD. A bearish signal stays in cash; opening a short is disabled for this spot
                test.
              </p>
            </article>
            <article>
              <span>Risk & quantity</span>
              <h3>0.25% risk · 10% allocation cap</h3>
              <p>
                Size from a 2 × ATR14 stop plus estimated round-trip costs, with at most 1% of the
                prior candle’s BTC volume. No leverage. A 2% daily loss blocks new entries until the
                next UTC day.
              </p>
            </article>
            <article>
              <span>Exits</span>
              <h3>2 × ATR stop / 3 × ATR target</h3>
              <p>
                Levels are fixed from the entry fill. Stops take priority if both levels are touched
                within one candle. Gaps can exceed the planned loss. Target exits use a conservative
                market-exit assumption.
              </p>
            </article>
            <article>
              <span>Execution & costs</span>
              <h3>Next hourly open</h3>
              <p>
                0.10% fee and 0.05% adverse slippage per side. Tick 0.01 USDT; quantity step 0.00001
                BTC; minimum notional 5 USDT. These are fixed research assumptions, not verified
                historical exchange filters.
              </p>
            </article>
          </div>
          <p className="notice">
            This is an exploratory historical simulation, not a trained price forecast or a forward
            test. Candle data does not establish order-book fills. Cash and costed buy-and-hold are
            included; buy-and-hold enters after the same warm-up and uses all available virtual
            cash.
          </p>
          <div className="btc-actions">
            <button className="button" onClick={() => setStep(1)}>
              ← Check data
            </button>
            <button
              className="button primary"
              disabled={running}
              onClick={() => {
                void start('run');
              }}
            >
              Run original v1
            </button>
            <button
              className="button primary"
              disabled={running}
              onClick={() => {
                void start('compare');
              }}
            >
              Run v1 / v2 / v3 comparison
            </button>
          </div>
        </section>
      )}
      {step === 3 && (
        <>
          {!report ? (
            <section className="panel empty">
              <h2>{running ? 'Replaying hourly decisions…' : 'Ready to run the test'}</h2>
              <p>
                {running
                  ? 'The service is calculating signals, sizing virtual positions and reconciling the journal.'
                  : 'Review the assumptions before running this frozen snapshot.'}
              </p>
              <button className="button" disabled={running} onClick={() => setStep(2)}>
                Review strategy
              </button>
            </section>
          ) : (
            <>
              <section className="panel btc-section">
                <div className="btc-section-head">
                  <div>
                    <div className="eyebrow">03 / FULL-PERIOD RESULTS</div>
                    <h2>What happened · {report.plan.version}</h2>
                    <p>
                      {data && `${date(data.dataset.from)} → ${date(data.dataset.to)}`}. Open BTC is
                      marked at the final close; exit costs on an open position are not charged.
                    </p>
                  </div>
                  <a className="button" href="/api/btc-test/export">
                    ↓ Export frozen report
                  </a>
                </div>
                <div className="btc-metrics">
                  {[
                    ['Market-only equity', `${money(report.summary.finalEquity)} USDT`],
                    [
                      'Net P&L',
                      `${money(report.summary.netPnl)} USDT (${pct(report.summary.returnFraction)})`,
                    ],
                    ['Maximum hourly drawdown', pct(report.summary.maxDrawdown)],
                    [
                      'Cash / costed buy-and-hold',
                      `10,000 / ${money(report.summary.buyHoldEquity)}`,
                    ],
                    [
                      'Fees / adverse slippage',
                      `${money(report.summary.fees)} / ${money(report.summary.slippage)} USDT`,
                    ],
                    [
                      'Closed trades / wins',
                      `${report.summary.closedTrades} / ${report.summary.wins}`,
                    ],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <small>{label}</small>
                      <strong>{value}</strong>
                    </div>
                  ))}
                </div>
                <p>
                  Slippage is embedded in fill prices; fees are charged separately. The buy-and-hold
                  comparator has much higher exposure than the strategy. Hourly drawdown can miss
                  intrabar lows.{' '}
                  {comparison
                    ? comparison.comparison.version === 'btc-comparison.v2'
                      ? 'One original strategy and two research revisions.'
                      : 'One original strategy and one research revision.'
                    : 'One fixed original strategy.'}{' '}
                  Repeated replay is the same trial.
                </p>
              </section>
              {decision && bar && (
                <section className="panel btc-section" ref={player}>
                  <div className="btc-section-head">
                    <div>
                      <div className="eyebrow">DECISION PLAYER / NO FUTURE CANDLES IN SIGNALS</div>
                      <h2>{date(decision.at)}</h2>
                      <p>
                        Candle {index + 1} / {report.decisions.length} · open {date(bar.at)} ·
                        decision after its close
                      </p>
                    </div>
                    <span className={`btc-signal btc-${decision.action.toLowerCase()}`}>
                      {decision.action}
                    </span>
                  </div>
                  <label className="btc-slider">
                    Choose a completed hour
                    <input
                      aria-label="Completed candle"
                      type="range"
                      min="0"
                      max={report.decisions.length - 1}
                      value={index}
                      onChange={(e) => setIndex(Number(e.target.value))}
                    />
                  </label>
                  <div className="btc-actions">
                    <button
                      className="button"
                      disabled={index === 0}
                      onClick={() => setIndex((i) => i - 1)}
                    >
                      ← Previous hour
                    </button>
                    <button
                      className="button"
                      disabled={index === report.decisions.length - 1}
                      onClick={() => setIndex((i) => i + 1)}
                    >
                      Next hour →
                    </button>
                    <button
                      className="button primary"
                      disabled={index === report.decisions.length - 1}
                      onClick={advanceSignal}
                    >
                      Next signal or fill →
                    </button>
                    <button
                      className="button"
                      onClick={() => setIndex(report.decisions.length - 1)}
                    >
                      Final hour
                    </button>
                  </div>
                  <div className="btc-decision">
                    {decision.executionNote && <p className="notice">{decision.executionNote}</p>}
                    <h3>{decision.reason}</h3>
                    <p>
                      {decision.action === 'LONG'
                        ? 'Submit a virtual buy for the following hourly open.'
                        : decision.action === 'EXIT'
                          ? 'Submit a virtual exit for the following hourly open.'
                          : 'No new virtual order at this close.'}{' '}
                      Completed candles through this hour are the only signal inputs.
                    </p>
                    <div className="btc-facts">
                      {[
                        [
                          'Open / high / low',
                          `${money(bar.open)} / ${money(bar.high)} / ${money(bar.low)}`,
                        ],
                        ['Completed-hour volume', `${bar.volume} BTC`],
                        ['Close', money(bar.close)],
                        ['MA20', decision.fast ? money(decision.fast) : 'Warming up'],
                        ['MA50', decision.slow ? money(decision.slow) : 'Warming up'],
                        ['ATR14', decision.atr ? money(decision.atr) : 'Warming up'],
                        ...(report.plan.version !== 'btc-ma-atr.v1'
                          ? [
                              ['MA200', decision.trend ? money(decision.trend) : 'Warming up'],
                              [
                                'MA200 rising over 24 hours',
                                decision.trendRising === null
                                  ? 'Warming up'
                                  : decision.trendRising
                                    ? 'Yes'
                                    : 'No',
                              ],
                              [
                                'Target / estimated round-trip cost',
                                decision.rewardCostRatio
                                  ? Number(decision.rewardCostRatio).toFixed(2) + ' ×'
                                  : 'Warming up',
                              ],
                              ['Entry filter', decision.entryGate ?? 'WARMUP'],
                            ]
                          : []),
                        ...(report.plan.version === 'btc-ma-atr.v3'
                          ? [
                              [
                                'Signal candle range / ATR',
                                decision.signalRangeAtr
                                  ? Number(decision.signalRangeAtr).toFixed(2) + ' ×'
                                  : 'Warming up',
                              ],
                              [
                                'Close location in signal candle',
                                decision.closeLocation === null ||
                                decision.closeLocation === undefined
                                  ? 'Zero range'
                                  : pct(decision.closeLocation),
                              ],
                            ]
                          : []),
                        ['Planned order', `${decision.quantity} BTC`],
                        [
                          'Stop / target',
                          decision.stop
                            ? `${money(decision.stop)} / ${money(decision.target!)}`
                            : 'No open position',
                        ],
                        ['Cash', `${money(decision.cash)} USDT`],
                        ['Position', `${decision.btc} BTC`],
                      ].map(([k, v]) => (
                        <div key={k}>
                          <small>{k}</small>
                          <strong>{v}</strong>
                        </div>
                      ))}
                    </div>
                  </div>
                  {fills.length > 0 && (
                    <div className="notice">
                      <strong>Virtual fills during this hour</strong>
                      {fills.map((f, i) => (
                        <p key={i}>
                          {f.side} {f.quantity} BTC at {money(f.price)} USDT · fee {money(f.fee)} ·{' '}
                          {f.reason}.{' '}
                          {f.stop && `Entry stop ${money(f.stop)} / target ${money(f.target!)}.`}
                        </p>
                      ))}
                    </div>
                  )}
                  <Chart
                    series={[
                      report.decisions.slice(0, index + 1).map((d) => Number(d.equity)),
                      report.decisions.slice(0, index + 1).map((d) => Number(d.buyHold)),
                      report.decisions.slice(0, index + 1).map(() => 10000),
                    ]}
                    labels={[report.plan.version, 'Costed buy-and-hold', 'Cash']}
                    colors={['#288c80', '#b08b46', '#95a1a2']}
                    caption="Equity through the selected hour · virtual USDT"
                  />
                  <Chart
                    series={[data.dataset.bars.slice(0, index + 1).map((b) => Number(b.close))]}
                    labels={['BTC hourly close']}
                    colors={['#288c80']}
                    caption="Price history visible to this decision · USDT"
                  />
                </section>
              )}
              <section className="panel btc-section">
                <div className="btc-section-head">
                  <h2>Virtual fill journal</h2>
                  <div className="btc-actions">
                    <button
                      className="button"
                      disabled={tradePage === 0}
                      onClick={() => setTradePage((p) => p - 1)}
                    >
                      Previous
                    </button>
                    <span>
                      Page {tradePage + 1} / {Math.max(1, Math.ceil(report.trades.length / 20))}
                    </span>
                    <button
                      className="button"
                      disabled={(tradePage + 1) * 20 >= report.trades.length}
                      onClick={() => setTradePage((p) => p + 1)}
                    >
                      Next
                    </button>
                  </div>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Assumed UTC fill time</th>
                        <th>Side</th>
                        <th>BTC quantity</th>
                        <th>Fill price</th>
                        <th>Fee (USDT)</th>
                        <th>Trace</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.trades.slice(tradePage * 20, tradePage * 20 + 20).map((t, i) => (
                        <tr key={i}>
                          <td>{date(t.at)}</td>
                          <td>{t.side}</td>
                          <td>{t.quantity}</td>
                          <td>{money(t.price)}</td>
                          <td>{money(t.fee)}</td>
                          <td>
                            <button
                              className="button"
                              onClick={() => {
                                setIndex(t.index);
                                player.current?.scrollIntoView({ block: 'start' });
                              }}
                            >
                              Inspect hour {t.index + 1}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!report.trades.length && <p>No virtual trades met the frozen rule.</p>}
                </div>
              </section>
              <section className="panel btc-section">
                <h2>Reproduce this result</h2>
                <p>
                  Replay the exact frozen data and assumptions and compare the full report hash.
                  This checks reproducibility, not predictive skill.
                </p>
                <p className="hash">
                  Dataset: {report.datasetId}
                  <br />
                  Plan: {report.planHash}
                  <br />
                  Engine: {report.engineHash}
                  <br />
                  Report: {result.id}
                  <br />
                  Journal: {report.journalHash}
                </p>
                <button
                  className="button"
                  disabled={running || busy}
                  onClick={() => {
                    setBusy(true);
                    void request(
                      '/verify',
                      z.strictObject({ verified: z.literal(true), reportId: HashSchema }),
                      {},
                    )
                      .then(() => setVerified(true))
                      .catch(() => setError('Replay verification failed. Check local artifacts.'))
                      .finally(() => setBusy(false));
                  }}
                >
                  Verify deterministic replay
                </button>
                {verified && (
                  <p role="status" className="btc-data-ok">
                    ✓ Replay matches the frozen report and reconciled journal.
                  </p>
                )}
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}
