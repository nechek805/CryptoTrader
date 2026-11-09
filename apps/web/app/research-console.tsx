'use client';
import { useEffect, useState, useRef } from 'react';
import Link from 'next/link';
import { z } from 'zod';
import BtcTest from './market-test/btc-test';
import MarketStrategyTests from './market-strategy-tests/market-strategy-tests';
import SpecialistTests from './sol-xrp-lab/workspace';
import DirectionalTests from './long-short-tests/workspace';
import LiveWorkspace from './live-paper/workspace';
import NewsPaperWorkspace from './news-paper/workspace';
import NewsWorkspace from './news-engine/workspace';
import NewsStrategyTests from './news-strategy-tests/workspace';
import {
  OpsOverviewSchema,
  OpsCurveSchema,
  OpsSignalSchema,
  OpsTraceSchema,
  EvaluationReportSchema,
  PaperFillSchema,
  EventStudyResultSchema,
  opsPageSchema,
} from '@crypto/contracts';
import type {
  OpsOverview,
  OpsCurve,
  OpsSignal,
  OpsTrace,
  EvaluationReport,
} from '@crypto/contracts';

type View =
  | 'news-strategy-tests'
  | 'news-engine'
  | 'news-paper'
  | 'live-paper'
  | 'overview'
  | 'runs'
  | 'provenance'
  | 'trades'
  | 'analytics'
  | 'operations'
  | 'market-test'
  | 'market-strategy-tests'
  | 'sol-xrp-lab'
  | 'long-short-tests';
const labels = {
  BASELINE: 'Cash baseline',
  NEWS_ONLY: 'News only',
  MARKET_ONLY: 'Market only',
  FUSION: 'Fusion',
};
const colors = {
  BASELINE: '#95a1a2',
  NEWS_ONLY: '#c48a3d',
  MARKET_ONLY: '#288c80',
  FUSION: '#5879b2',
};
const paths: [View, string, string][] = [
  ['news-engine', '/news-engine', 'Live news engine'],
  ['news-paper', '/news-paper', 'News paper trading'],
  ['news-strategy-tests', '/news-strategy-tests', 'News strategy tests'],
  ['live-paper', '/live-paper', 'Live paper trading'],
  ['overview', '/', 'Overview'],
  ['runs', '/runs', 'Paper runs'],
  ['provenance', '/provenance', 'News provenance'],
  ['trades', '/trades', 'Virtual trades'],
  ['analytics', '/analytics', 'Comparison lab'],
  ['operations', '/operations', 'Operations'],
  ['market-test', '/market-test', 'BTC market test'],
  ['market-strategy-tests', '/market-strategy-tests', 'Market strategy tests'],
  ['sol-xrp-lab', '/sol-xrp-lab', 'SOL & XRP strategy lab'],
  ['long-short-tests', '/long-short-tests', 'Long & short tests'],
];
const time = (s: string) =>
  new Date(s).toLocaleString('en-GB', {
    timeZone: 'UTC',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
const money = (n: string | null, digits = 2) =>
  n === null
    ? 'N/A'
    : Number(n).toLocaleString('en-US', {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });
const pct = (n: string | number | null) =>
  n === null ? 'N/A' : `${(Number(n) * 100).toFixed(2)}%`;
const textValue = (v: unknown, fallback = 'Unknown') => (typeof v === 'string' ? v : fallback);
async function api<T>(path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...(body
      ? {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  });
  if (response.status === 401) throw new Error('AUTH_REQUIRED');
  if (!response.ok)
    throw new Error(
      response.status === 403
        ? 'Operator access is required.'
        : response.status === 409
          ? 'This frozen run cannot accept that control.'
          : 'The research service could not complete this request.',
    );
  const raw: unknown = await response.json();
  return schema.parse(raw);
}
function EquityChart({ curve, selected }: { curve: OpsCurve; selected: keyof typeof labels }) {
  const series = curve.series.filter((s) => s.portfolio === selected || s.portfolio === 'BASELINE'),
    values = series.flatMap((s) =>
      s.points.flatMap((p) => (p.value === null ? [] : [Number(p.value)])),
    ),
    dates = series.flatMap((s) => s.points.map((p) => Date.parse(p.at)));
  if (!values.length) return <div className="empty">No valid equity marks are available.</div>;
  const low = Math.min(...values),
    high = Math.max(...values),
    min = low - Math.max(10, (high - low) * 0.2),
    max = high + Math.max(10, (high - low) * 0.2),
    first = Math.min(...dates),
    last = Math.max(...dates),
    x = (at: string) => 68 + ((Date.parse(at) - first) / Math.max(1, last - first)) * 860,
    y = (v: string) => 30 + ((max - Number(v)) / (max - min)) * 218;
  return (
    <>
      <svg
        className="equity-chart"
        viewBox="0 0 960 292"
        role="img"
        aria-label="Simulated portfolio equity; missing observations form gaps"
      >
        {[0, 1, 2, 3].map((i) => (
          <g key={i}>
            <line x1="68" x2="930" y1={30 + i * 72} y2={30 + i * 72} stroke="#e6e9e5" />
            <text x="4" y={35 + i * 72} className="chart-label">
              {money(String(max - (i / 3) * (max - min)), 0)}
            </text>
          </g>
        ))}
        {series.map((s) => {
          const segments: string[][] = [[]];
          for (const p of s.points) {
            if (p.value === null || p.hasMissing) {
              if (segments.at(-1)!.length) segments.push([]);
            } else segments.at(-1)!.push(`${x(p.at)},${y(p.value)}`);
          }
          return (
            <g key={s.portfolio}>
              {segments
                .filter((s) => s.length)
                .map((points, i) => (
                  <polyline
                    key={i}
                    points={points.join(' ')}
                    fill="none"
                    stroke={colors[s.portfolio]}
                    strokeWidth={s.portfolio === 'BASELINE' ? 1.5 : 2.8}
                    strokeDasharray={s.portfolio === 'BASELINE' ? '6 5' : undefined}
                    strokeLinejoin="round"
                  />
                ))}
            </g>
          );
        })}
        <text x="68" y="281" className="chart-label">
          {time(new Date(first).toISOString())}
        </text>
        <text x="930" y="281" textAnchor="end" className="chart-label">
          {time(new Date(last).toISOString())} UTC
        </text>
      </svg>
      <div className="chart-foot">
        <span>
          <i style={{ background: colors[selected] }} />
          {labels[selected]}
        </span>
        <span>
          <i style={{ background: colors.BASELINE }} />
          Cash baseline
        </span>
        <small>Observed bucket closes · missing samples create gaps</small>
      </div>
    </>
  );
}
const Provenance = z.object({
  snapshots: z.array(z.object({ hash: z.string(), at: z.string() })),
  selectedHash: z.string().optional(),
  nodes: z.array(
    z.object({
      id: z.string(),
      articleId: z.string(),
      articleVersionId: z.string(),
      sourceId: z.string(),
      polarity: z.string(),
    }),
  ),
  edges: z.array(z.record(z.string(), z.json())),
  contradictions: z
    .array(
      z.object({
        id: z.string(),
        affirmed: z.array(z.string()),
        negated: z.array(z.string()),
        active: z.boolean(),
      }),
    )
    .default([]),
  events: z.array(z.record(z.string(), z.json())),
  timeline: z.array(z.record(z.string(), z.json())).optional(),
  limitation: z.string(),
});

export default function Dashboard({ view }: { view: View }) {
  const drawer = useRef<HTMLElement>(null);
  const [overview, setOverview] = useState<OpsOverview | null>(null),
    [curve, setCurve] = useState<OpsCurve | null>(null),
    [signals, setSignals] = useState<OpsSignal[]>([]),
    [selected, setSelected] = useState<keyof typeof labels>('FUSION'),
    [trace, setTrace] = useState<OpsTrace | null>(null),
    [role, setRole] = useState<'READ' | 'ADMIN'>('READ'),
    [token, setToken] = useState(''),
    [locked, setLocked] = useState(true),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [report, setReport] = useState<EvaluationReport | null>(null),
    [provenance, setProvenance] = useState<z.infer<typeof Provenance> | null>(null),
    [trades, setTrades] = useState<z.infer<typeof PaperFillSchema>[]>([]),
    [alerts, setAlerts] = useState<Record<string, z.infer<ReturnType<typeof z.json>>>[]>([]),
    [reason, setReason] = useState('Operator review of source coverage');
  const [controlNotice, setControlNotice] = useState('');
  const [accessMode, setAccessMode] = useState<'UNKNOWN' | 'DEMO' | 'TOKEN'>('UNKNOWN');
  useEffect(() => {
    if (!trace) return;
    const prior = document.activeElement as HTMLElement | null;
    drawer.current?.querySelector('button')?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTrace(null);
      if (e.key === 'Tab') {
        const list = drawer.current?.querySelectorAll<HTMLElement>('button, a[href]');
        if (!list?.length) return;
        if (e.shiftKey && document.activeElement === list[0]) {
          e.preventDefault();
          list[list.length - 1]?.focus();
        } else if (!e.shiftKey && document.activeElement === list[list.length - 1]) {
          e.preventDefault();
          list[0]?.focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      prior?.focus();
    };
  }, [trace]);
  async function load() {
    setLoading(true);
    setError('');
    try {
      const access = await api(
        '/ready',
        z.object({ ready: z.literal(true), demoAutoLogin: z.boolean().default(false) }),
      );
      setAccessMode(access.demoAutoLogin ? 'DEMO' : 'TOKEN');
      const sessionSchema = z.object({ role: z.enum(['READ', 'ADMIN']) });
      let session: z.infer<typeof sessionSchema>;
      try {
        session = await api('/session', sessionSchema);
      } catch (e) {
        if (!(e instanceof Error) || e.message !== 'AUTH_REQUIRED' || !access.demoAutoLogin)
          throw e;
        await api(
          '/session',
          z.object({ role: z.enum(['READ', 'ADMIN']), expiresInSeconds: z.number() }),
          { token: 'fixture-read-0000000000000000000000' },
        );
        session = await api('/session', sessionSchema);
      }
      if (
        view === 'market-test' ||
        view === 'market-strategy-tests' ||
        view === 'sol-xrp-lab' ||
        view === 'long-short-tests' ||
        view === 'live-paper' ||
        view === 'news-engine' ||
        view === 'news-paper' ||
        view === 'news-strategy-tests'
      ) {
        setRole(session.role);
        setLocked(false);
        return;
      }
      const [o, c, s] = await Promise.all([
        api('/overview', OpsOverviewSchema),
        api('/curve', OpsCurveSchema),
        api('/signals?limit=100', opsPageSchema(OpsSignalSchema)),
      ]);
      setOverview(o);
      setCurve(c);
      setSignals(s.items);
      setRole(session.role);
      setLocked(false);
      if (view === 'analytics') setReport(await api('/reports', EvaluationReportSchema));
      if (view === 'provenance') setProvenance(await api('/provenance', Provenance));
      if (view === 'trades') {
        const r = await api('/trades?limit=100', opsPageSchema(PaperFillSchema.strip()));
        setTrades(r.items);
      }
      if (view === 'operations') {
        const r = await api('/alerts?limit=100', opsPageSchema(z.record(z.string(), z.json())));
        setAlerts(r.items);
      }
    } catch (e) {
      if (e instanceof Error && e.message === 'AUTH_REQUIRED') setLocked(true);
      else setError(e instanceof Error ? e.message : 'Research service unavailable.');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, [view]); // Source state is fetched from the validated API; no portfolio math runs in the UI.
  async function login(value: string) {
    try {
      await api(
        '/session',
        z.object({ role: z.enum(['READ', 'ADMIN']), expiresInSeconds: z.number() }),
        { token: value },
      );
      setToken('');
      await load();
    } catch {
      setError('Access token was not accepted.');
    }
  }
  async function inspect(id: string) {
    try {
      setTrace(await api(`/signals/${encodeURIComponent(id)}`, OpsTraceSchema));
    } catch {
      setError('This evidence trace is unavailable.');
    }
  }
  async function control(action: 'PAUSE' | 'RESUME' | 'STOP' | 'KILL') {
    if (!overview) return;
    try {
      const result = await api(
        '/controls',
        z.object({
          status: z.string(),
          execution: z.literal('SIMULATED'),
          logHead: z.string(),
          queued: z.boolean(),
        }),
        { action, reason, manifestHash: overview.manifestHash },
      );
      await load();
      setControlNotice(
        result.queued
          ? 'Control queued for the worker; refresh to inspect its committed event.'
          : 'Control committed to the immutable paper log.',
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Paper control failed.');
    }
  }
  if (locked && accessMode === 'TOKEN' && !loading)
    return (
      <main className="login">
        <div className="login-brand">
          CI<span>RESEARCH CONSOLE</span>
        </div>
        <div className="login-panel">
          <span className="eyebrow">CRYPTO INTELLIGENCE</span>
          <h1>Evidence before conviction.</h1>
          <p>
            Inspect independent signals, source provenance and four simulated portfolios. Virtual
            capital only.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void login(token);
            }}
          >
            <label htmlFor="access-token">Workspace access token</label>
            <input
              id="access-token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
              required
            />
            <button className="primary" type="submit">
              Enter workspace <span>→</span>
            </button>
          </form>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <small>SIMULATED · Research only · No exchange account connected</small>
        </div>
      </main>
    );
  return (
    <div className="shell">
      <aside className="sidebar">
        <Link href="/" className="brand">
          <b>CI</b>
          <span>
            Crypto
            <br />
            <strong>Intelligence</strong>
          </span>
        </Link>
        <div className="workspace-label">RESEARCH WORKSPACE</div>
        <nav>
          {paths.map(([key, href, label], i) => (
            <Link key={key} href={href} className={view === key ? 'active' : ''}>
              <span className="nav-symbol">
                {['◈', '◉', '▦', '◷', '⌘', '⇄', '◫', '⚙', '₿', '▥', '◎', '⇅'][i]}
              </span>
              {label}
              {key === 'operations' && overview && (
                <span className="nav-count">{overview.counts.alerts}</span>
              )}
            </Link>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="mode-dot" />
          Paper environment
          <p>
            Virtual capital. Immutable evidence.
            <br />
            No real-money execution.
          </p>
          <span className="role-label">{role === 'ADMIN' ? 'Operator access' : 'Read access'}</span>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <span>
            Workspace <span className="slash">/</span> Research
          </span>
          <div>
            <span className="simulated">SIMULATED</span>
            <span className="avatar">{role === 'ADMIN' ? 'OP' : 'RE'}</span>
          </div>
        </header>
        <main className="content" aria-busy={loading}>
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                {view === 'news-strategy-tests'
                  ? 'HISTORICAL NEWS / EXPLORATORY STRATEGIES'
                  : view === 'news-paper'
                    ? 'LIVE NEWS / SIMULATED FORWARD TRADING'
                    : view === 'news-engine'
                      ? 'LIVE NEWS / COLLECTION AND ANALYSIS'
                      : view === 'live-paper'
                        ? 'PUBLIC LIVE DATA / VIRTUAL EXECUTION'
                        : view === 'long-short-tests'
                          ? 'MARKET RESEARCH / LONG AND SHORT'
                          : view === 'sol-xrp-lab'
                            ? 'COIN-SPECIFIC RESEARCH / SOL & XRP'
                            : view === 'market-strategy-tests'
                              ? 'MARKET RESEARCH / STRATEGY COMPARISON'
                              : view === 'market-test'
                                ? 'MARKET RESEARCH / REAL BTC HISTORY'
                                : 'PAPER RESEARCH / FOUR INDEPENDENT ARMS'}
              </div>
              <h1>{paths.find((p) => p[0] === view)![2]}</h1>
              <p>
                {view === 'news-strategy-tests'
                  ? 'Study news reactions and hypothetical long/short positions across all tokens, with honest history and evaluation gates.'
                  : view === 'news-engine'
                    ? 'Read collected news, inspect AI analysis and manage source collection.'
                    : view === 'news-paper'
                      ? 'Follow a separate news-only 24-hour paper test across ten tokens and five exchanges, with fees on.'
                      : view === 'live-paper'
                        ? 'Track a 24-hour forward test across Binance, Bybit, OKX, Bitget and MEXC.'
                        : view === 'long-short-tests'
                          ? 'Compare both directions, trace borrowing and retain every original long-only result.'
                          : view === 'sol-xrp-lab'
                            ? 'Separate SOL and XRP v5 profiles, with V1–V5 comparisons and the V4 archive.'
                            : view === 'market-strategy-tests'
                              ? 'Compare three strategies across real crypto history and understand every result.'
                              : view === 'market-test'
                                ? 'Load real candles, run a fixed strategy and trace every virtual decision.'
                                : view === 'overview'
                                  ? 'A clear view of decisions, costs and the evidence behind them.'
                                  : view === 'provenance'
                                    ? 'Attribution, dependencies and corrections stay separate from return predictions.'
                                    : 'Every result belongs to a frozen source snapshot and a simulated ledger.'}
              </p>
            </div>
            {view !== 'news-strategy-tests' &&
              view !== 'news-engine' &&
              view !== 'news-paper' &&
              view !== 'market-test' &&
              view !== 'live-paper' &&
              view !== 'long-short-tests' &&
              view !== 'market-strategy-tests' &&
              view !== 'sol-xrp-lab' && (
                <a className="button export" href="/api/exports/json">
                  ↓ Export report
                </a>
              )}
          </div>
          {error && (
            <div className="notice error" role="alert">
              {error}
            </div>
          )}
          {view !== 'news-strategy-tests' &&
            view !== 'news-engine' &&
            view !== 'news-paper' &&
            view !== 'market-test' &&
            view !== 'live-paper' &&
            view !== 'long-short-tests' &&
            view !== 'market-strategy-tests' &&
            view !== 'sol-xrp-lab' &&
            overview && (
              <div className="context-bar">
                <span className="context-dot" />
                <strong>
                  {overview.origin === 'SYNTHETIC'
                    ? 'Synthetic research scenario'
                    : 'Public data · virtual execution'}
                </strong>
                <span>As of {time(overview.asOf)} UTC</span>
                <span className="context-status">{overview.status}</span>
              </div>
            )}
          {['market-test', 'market-strategy-tests', 'sol-xrp-lab'].includes(view) && (
            <div className="notice">
              <Link href={`/long-short-tests${view === 'market-test' ? '?asset=BTC' : ''}`}>
                Long + short tests are now available for all ten tokens →
              </Link>
            </div>
          )}
          {view === 'news-strategy-tests' ? (
            loading || locked ? (
              <div className="panel empty">Opening historical news research�</div>
            ) : (
              <NewsStrategyTests role={role} />
            )
          ) : view === 'news-paper' ? (
            loading || locked ? (
              <div className="panel empty">Connecting news paper trading…</div>
            ) : (
              <NewsPaperWorkspace />
            )
          ) : view === 'news-engine' ? (
            loading || locked ? (
              <div className="panel empty">Opening live news…</div>
            ) : (
              <NewsWorkspace role={role} />
            )
          ) : view === 'live-paper' ? (
            loading || locked ? (
              <div className="panel empty">Connecting live paper workspace…</div>
            ) : (
              <LiveWorkspace />
            )
          ) : view === 'long-short-tests' ? (
            loading || locked ? (
              <div className="panel empty">Opening long and short research…</div>
            ) : (
              <DirectionalTests />
            )
          ) : view === 'sol-xrp-lab' ? (
            loading || locked ? (
              <div className="panel empty">Opening SOL and XRP research…</div>
            ) : (
              <SpecialistTests />
            )
          ) : view === 'market-strategy-tests' ? (
            loading || locked ? (
              <div className="panel empty">Opening market strategy research…</div>
            ) : (
              <MarketStrategyTests />
            )
          ) : view === 'market-test' ? (
            loading || locked ? (
              <div className="panel empty">Opening BTC research…</div>
            ) : (
              <BtcTest />
            )
          ) : loading && !overview ? (
            <div className="panel empty">Loading validated research evidence…</div>
          ) : !overview ? (
            <section className="panel empty">
              <p>The dashboard could not load its research data.</p>
              <button
                className="button"
                onClick={() => {
                  void load();
                }}
              >
                Retry
              </button>
            </section>
          ) : (
            overview && (
              <>
                {(view === 'overview' || view === 'runs') && (
                  <>
                    <div className="portfolio-grid">
                      {overview.portfolios.map((p) => (
                        <button
                          key={p.portfolio}
                          className={`portfolio-card ${selected === p.portfolio ? 'selected' : ''}`}
                          onClick={() => setSelected(p.portfolio)}
                        >
                          <div>
                            <i style={{ background: colors[p.portfolio] }} />
                            {labels[p.portfolio]}
                            <span>↗</span>
                          </div>
                          <strong>{money(p.equity)}</strong>
                          <small>{overview.quoteCurrency} virtual equity</small>
                          <div className={`pnl ${Number(p.netPnl) < 0 ? 'negative' : ''}`}>
                            {p.netPnl === null
                              ? 'Unknown valuation'
                              : `${Number(p.netPnl) > 0 ? '+' : ''}${money(p.netPnl)} ${overview.quoteCurrency}`}
                            <span>net of costs</span>
                          </div>
                        </button>
                      ))}
                    </div>
                    <div className="overview-grid">
                      <section className="panel">
                        <div className="panel-title">
                          <div>
                            <h2>Portfolio equity</h2>
                            <p>
                              {money(overview.initialCapitalPerArm, 0)} {overview.quoteCurrency}{' '}
                              virtual per arm · shared inputs and assumptions
                            </p>
                          </div>
                          <span className="neutral-badge">{labels[selected]}</span>
                        </div>
                        {curve && <EquityChart curve={curve} selected={selected} />}
                      </section>
                      <section className="panel health-panel">
                        <h2>Research readiness</h2>
                        <div className="evidence-status">
                          <span>!</span>
                          <div>
                            <strong>Evidence incomplete</strong>
                            <p>
                              {overview.report?.recommendation ?? 'Pending evaluation'} · no alpha
                              established
                            </p>
                          </div>
                        </div>
                        <div className="stat-row">
                          <span>Candidate decisions</span>
                          <b>{overview.counts.candidates}</b>
                        </div>
                        <div className="stat-row">
                          <span>HOLD outcomes</span>
                          <b>{overview.counts.holds}</b>
                        </div>
                        <div className="stat-row">
                          <span>Virtual fills</span>
                          <b>{overview.counts.fills}</b>
                        </div>
                        <div className="stat-row">
                          <span>Risk vetoes</span>
                          <b>{overview.counts.riskVetoes}</b>
                        </div>
                        <p className="small-note">
                          Evidence corroboration and directional model calibration are different
                          questions. Uncalibrated confidence never raises the risk ceiling.
                        </p>
                      </section>
                    </div>
                  </>
                )}
                {(view === 'overview' || view === 'runs') && (
                  <section className="panel">
                    <div className="panel-title">
                      <div>
                        <h2>Decision journal</h2>
                        <p>LONG, SHORT and HOLD are candidates. Risk can veto every arm.</p>
                      </div>
                      <span className="neutral-badge">Immutable</span>
                    </div>
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Decision / UTC</th>
                            <th>Arm</th>
                            <th>Asset</th>
                            <th>Candidate</th>
                            <th>Risk gate</th>
                            <th>Calibration</th>
                            <th />
                          </tr>
                        </thead>
                        <tbody>
                          {signals.map((s) => (
                            <tr key={s.id}>
                              <td>{time(s.at)}</td>
                              <td>{labels[s.portfolio]}</td>
                              <td>{s.symbol}</td>
                              <td>
                                <span className={`tag ${s.side === 'LONG' ? 'green' : 'muted'}`}>
                                  {s.side}
                                </span>
                              </td>
                              <td>
                                {s.allowed
                                  ? 'Admitted'
                                  : s.side === 'HOLD'
                                    ? 'Abstained'
                                    : 'Vetoed'}
                              </td>
                              <td>
                                <span className="tag muted">
                                  {s.calibration === 'UNCALIBRATED'
                                    ? 'Uncalibrated'
                                    : 'Bound artifact'}
                                </span>
                              </td>
                              <td>
                                <button
                                  className="text-button"
                                  onClick={() => {
                                    void inspect(s.id);
                                  }}
                                >
                                  Trace evidence →
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                )}
                {view === 'overview' && (
                  <div className="source-grid">
                    {overview.sources.map((s) => (
                      <section className="panel source-card" key={s.id}>
                        <span
                          className={`status-dot ${s.status === 'READY_IN_REPLAY' ? 'ready' : ''}`}
                        />
                        <div>
                          <h3>{s.kind === 'MARKET' ? 'Market source' : 'News source'}</h3>
                          <p>{s.id}</p>
                          <strong>{s.status.replaceAll('_', ' ')}</strong>
                        </div>
                        <Link href="/operations">Inspect →</Link>
                      </section>
                    ))}
                  </div>
                )}
                {view === 'provenance' && provenance && (
                  <>
                    <section className="panel">
                      <div className="panel-title">
                        <div>
                          <h2>Versioned event archive</h2>
                          <p>
                            Reference scenario · inspect original and later knowledge without
                            rewriting history.
                          </p>
                        </div>
                        <div className="segmented">
                          {provenance.snapshots.map((s, i) => (
                            <button
                              key={s.hash}
                              className={s.hash === provenance.selectedHash ? 'on' : ''}
                              onClick={() => {
                                void api(
                                  `/provenance?snapshot=${encodeURIComponent(s.hash)}`,
                                  Provenance,
                                )
                                  .then(setProvenance)
                                  .catch(() => setError('Snapshot unavailable.'));
                              }}
                            >
                              {i === 0 ? 'Original' : 'Corrected'} · {time(s.at)}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="notice">
                        Factual corroboration is not the probability of a profitable trade. Archive
                        events are not silently joined to earlier accounting decisions.
                      </div>
                      <div className="provenance-grid">
                        <div>
                          <h3>Source dependency graph</h3>
                          <svg
                            viewBox="0 0 680 280"
                            className="provenance-graph"
                            role="img"
                            aria-label="Source nodes and evidence dependence links"
                          >
                            {provenance.edges.map((e, i) => {
                              const a = provenance.nodes
                                  .slice(0, 12)
                                  .findIndex((n) => n.id === e.from),
                                b = provenance.nodes.slice(0, 12).findIndex((n) => n.id === e.to);
                              return a < 0 || b < 0 ? null : (
                                <line
                                  key={i}
                                  x1={80 + (a % 4) * 170}
                                  y1={65 + Math.floor(a / 4) * 90}
                                  x2={80 + (b % 4) * 170}
                                  y2={65 + Math.floor(b / 4) * 90}
                                  stroke="#789c91"
                                  strokeWidth="2"
                                >
                                  <title>{textValue(e.relationship)}</title>
                                </line>
                              );
                            })}
                            {provenance.contradictions
                              .filter((c) => c.active)
                              .flatMap((c) =>
                                c.affirmed.flatMap((a) =>
                                  c.negated.map((b) => {
                                    const x = provenance.nodes
                                        .slice(0, 12)
                                        .findIndex((n) => n.id === a),
                                      y = provenance.nodes
                                        .slice(0, 12)
                                        .findIndex((n) => n.id === b);
                                    return x < 0 || y < 0 ? null : (
                                      <line
                                        key={`${a}-${b}`}
                                        x1={80 + (x % 4) * 170}
                                        y1={65 + Math.floor(x / 4) * 90}
                                        x2={80 + (y % 4) * 170}
                                        y2={65 + Math.floor(y / 4) * 90}
                                        stroke="#b95c50"
                                        strokeDasharray="5 4"
                                      >
                                        <title>Active contradiction</title>
                                      </line>
                                    );
                                  }),
                                ),
                              )}
                            {provenance.nodes.slice(0, 12).map((n, i) => {
                              const x = 80 + (i % 4) * 170,
                                y = 65 + Math.floor(i / 4) * 90;
                              return (
                                <g key={n.id}>
                                  <circle
                                    cx={x}
                                    cy={y}
                                    r="23"
                                    fill={n.polarity === 'NEGATED' ? '#fae8e4' : '#e2eeea'}
                                    stroke={n.polarity === 'NEGATED' ? '#b95c50' : '#2e8074'}
                                  />
                                  <text
                                    x={x}
                                    y={y + 4}
                                    textAnchor="middle"
                                    fontSize="12"
                                    fill="#23443f"
                                  >
                                    {i + 1}
                                  </text>
                                  <text
                                    x={x}
                                    y={y + 39}
                                    textAnchor="middle"
                                    fontSize="10"
                                    fill="#64746e"
                                  >
                                    {n.polarity}
                                  </text>
                                </g>
                              );
                            })}
                          </svg>
                          <p className="small-note">
                            {provenance.nodes.length} source assertions · {provenance.edges.length}{' '}
                            recorded dependencies. Reposts do not create independent corroboration.
                            Green lines: dependence; dashed red: active contradiction. First 12
                            nodes shown; full graph is available from the API.
                          </p>
                        </div>
                        <div>
                          <h3>Knowledge timeline</h3>
                          {provenance.timeline?.slice(-6).map((t, i) => (
                            <div className="timeline-row" key={i}>
                              <span className="timeline-dot" />
                              <div>
                                <strong>{textValue(t.kind, 'UPDATE')}</strong>
                                <p>
                                  {typeof t.knownAt === 'string' ? time(t.knownAt) : 'Unknown time'}{' '}
                                  UTC
                                </p>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </section>
                    <section className="panel">
                      <h2>Preserved article versions</h2>
                      <div className="table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th>Source</th>
                              <th>Polarity</th>
                              <th>Article version</th>
                            </tr>
                          </thead>
                          <tbody>
                            {provenance.nodes.map((n) => (
                              <tr key={n.id}>
                                <td>{n.sourceId}</td>
                                <td>
                                  <span className="tag muted">{n.polarity}</span>
                                </td>
                                <td className="hash">{n.articleVersionId}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <p className="small-note">
                        Original copyrighted text is not republished. The exact content/version
                        hashes remain traceable.
                      </p>
                    </section>
                  </>
                )}
                {view === 'trades' && (
                  <section className="panel">
                    <div className="panel-title">
                      <div>
                        <h2>Virtual execution journal</h2>
                        <p>Observed evidence, modeled costs and actual simulated gap outcomes.</p>
                      </div>
                      <span className="simulated">SIMULATED</span>
                    </div>
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Fill / UTC</th>
                            <th>Arm</th>
                            <th>Side</th>
                            <th>Quantity</th>
                            <th>Price</th>
                            <th>Fee</th>
                            <th>Trigger</th>
                            <th>Realized net</th>
                          </tr>
                        </thead>
                        <tbody>
                          {trades.map((f) => (
                            <tr key={f.fill.id}>
                              <td>{time(f.fill.filledAt)}</td>
                              <td>{labels[f.fill.portfolio]}</td>
                              <td>{f.fill.side}</td>
                              <td>{f.fill.quantity}</td>
                              <td>{money(f.fill.price)}</td>
                              <td>{money(f.fill.fee, 4)}</td>
                              <td>
                                <span className={`tag ${f.trigger === 'STOP' ? 'red' : 'muted'}`}>
                                  {f.trigger ?? 'ENTRY'}
                                </span>
                              </td>
                              <td className={Number(f.realizedNetPnl) < 0 ? 'negative' : ''}>
                                {money(f.realizedNetPnl)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="small-note">
                      Stops are triggers, not guaranteed prices. Limit execution requires
                      trade-through and assumed queue evidence.
                    </p>
                  </section>
                )}
                {view === 'analytics' && report && (
                  <>
                    <section className="panel">
                      <div className="panel-title">
                        <div>
                          <h2>Four-arm comparison</h2>
                          <p>Fixed primary comparison: news only minus market only.</p>
                        </div>
                        <span className="amber-badge">{report.memo.recommendation}</span>
                      </div>
                      <div className="table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th>Arm</th>
                              <th>Net PnL</th>
                              <th>Net return</th>
                              <th>Trades</th>
                              <th>Fees</th>
                              <th>Max drawdown</th>
                              <th>Coverage</th>
                            </tr>
                          </thead>
                          <tbody>
                            {report.metrics.map((m) => (
                              <tr key={m.portfolio}>
                                <td>{labels[m.portfolio]}</td>
                                <td className={Number(m.netPnl) < 0 ? 'negative' : ''}>
                                  {money(m.netPnl)}
                                </td>
                                <td>{pct(m.netReturn)}</td>
                                <td>{m.closedTrades}</td>
                                <td>{money(m.fees, 4)}</td>
                                <td>{pct(m.maxDrawdown)}</td>
                                <td>{pct(m.knownValuationFraction)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </section>
                    <div className="two-col">
                      <section className="panel">
                        <h2>Paired uncertainty</h2>
                        {report.pairedComparisons.map((p) => (
                          <div className="analysis-row" key={`${p.left}-${p.right}`}>
                            <strong>
                              {labels[p.left]} − {labels[p.right]}
                            </strong>
                            <p>
                              {p.pairedDays} complete paired days · {p.blockCount} dependence blocks
                            </p>
                            <span className="tag muted">{p.status.replaceAll('_', ' ')}</span>
                            <p>
                              Interval: {pct(p.lower)} to {pct(p.upper)}
                            </p>
                          </div>
                        ))}
                        <p className="small-note">
                          Contiguous day blocks; declared-search correction. Missing coverage does
                          not become zero return.
                        </p>
                      </section>
                      <section className="panel">
                        <h2>Decision memo</h2>
                        <div className="memo-title">
                          {report.memo.recommendation === 'STOP'
                            ? 'Stop and investigate.'
                            : report.memo.recommendation === 'REVISE'
                              ? 'Revise and freeze a new test.'
                              : 'Continue forward research.'}
                        </div>
                        {report.memo.reasons.slice(0, 7).map((r) => (
                          <div className="memo-reason" key={r}>
                            <span>·</span>
                            {r.replaceAll('_', ' ').toLowerCase()}
                          </div>
                        ))}
                        <p className="small-note">
                          No alpha established. No real-money authorization. Positive PnL alone is
                          not an acceptance criterion.
                        </p>
                      </section>
                    </div>
                    <section className="panel">
                      <h2>Predeclared execution sensitivity</h2>
                      <div className="table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th>Scenario</th>
                              <th>News net PnL</th>
                              <th>Market net PnL</th>
                              <th>Fusion net PnL</th>
                              <th>Producer decisions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {report.sensitivity.map((s) => (
                              <tr key={s.id}>
                                <td>{s.id.replaceAll('_', ' ')}</td>
                                {(['NEWS_ONLY', 'MARKET_ONLY', 'FUSION'] as const).map((a) => (
                                  <td key={a}>
                                    {money(s.metrics.find((m) => m.portfolio === a)!.netPnl)}
                                  </td>
                                ))}
                                <td>Unchanged fingerprint</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </section>
                    <ResearchDetails />
                  </>
                )}
                {view === 'operations' && (
                  <>
                    <div className="two-col">
                      <section className="panel">
                        <h2>Paper run controls</h2>
                        {controlNotice && (
                          <p className="notice" role="status">
                            {controlNotice}
                          </p>
                        )}
                        <p className="small-note">
                          {role === 'ADMIN'
                            ? 'Controls append immutable events. A killed or completed manifest cannot be rewritten.'
                            : 'Read access. Operator authentication is required to change a paper run.'}
                        </p>
                        <label htmlFor="control-reason">Reason recorded in the audit log</label>
                        <input
                          id="control-reason"
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                          maxLength={500}
                          disabled={role !== 'ADMIN'}
                        />
                        <div className="controls">
                          {(['PAUSE', 'RESUME', 'STOP', 'KILL'] as const).map((action) => (
                            <button
                              key={action}
                              className={action === 'KILL' ? 'danger button' : 'button'}
                              disabled={
                                role !== 'ADMIN' || overview.status === 'STOPPED' || !reason
                              }
                              onClick={() => {
                                void control(action);
                              }}
                            >
                              {action === 'KILL'
                                ? 'Kill switch'
                                : action[0] + action.slice(1).toLowerCase()}
                            </button>
                          ))}
                        </div>
                        <p className="small-note">
                          Virtual execution only. This workspace has no real order channel.
                        </p>
                      </section>
                      <section className="panel">
                        <h2>Frozen evidence</h2>
                        <dl className="data-list">
                          <dt>Manifest</dt>
                          <dd className="hash">{overview.manifestHash}</dd>
                          <dt>Current snapshot</dt>
                          <dd className="hash">{overview.runHash}</dd>
                          <dt>Research report</dt>
                          <dd className="hash">{overview.report?.hash ?? 'Not attached'}</dd>
                        </dl>
                        <div className="export-links">
                          <a href="/api/exports/json">JSON</a>
                          <a href="/api/exports/csv">CSV</a>
                          <a href="/api/exports/md">Markdown</a>
                        </div>
                      </section>
                    </div>
                    <section className="panel">
                      <h2>Operational alerts</h2>
                      {alerts.map((a, i) => (
                        <div className="alert-row" key={i}>
                          <span className="tag amber">{textValue(a.code, '')}</span>
                          <span>{typeof a.at === 'string' ? time(a.at) : 'Unknown'} UTC</span>
                          <span className="hash">{textValue(a.sourceId, 'Run supervisor')}</span>
                        </div>
                      ))}
                    </section>
                  </>
                )}
              </>
            )
          )}
          <footer>
            Research evidence, not investment advice.{' '}
            <span>SIMULATED · No exchange balance · UTC clocks</span>
          </footer>
        </main>
      </div>
      {trace && (
        <div className="drawer-backdrop" onClick={() => setTrace(null)}>
          <aside
            ref={drawer}
            className="trace-drawer"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Decision evidence trace"
          >
            <button
              className="close-drawer"
              onClick={() => setTrace(null)}
              aria-label="Close evidence trace"
            >
              ×
            </button>
            <span className="eyebrow">IMMUTABLE DECISION TRACE</span>
            <h2>
              {labels[trace.candidate.portfolio]} · {trace.candidate.side}
            </h2>
            <p>
              {trace.candidate.symbol} · {time(trace.candidate.decisionAt)} UTC
            </p>
            <div className="notice">
              SIMULATED ·{' '}
              {trace.decision.risk.decision.allowed ? 'Risk admitted' : 'Risk abstained/vetoed'}
            </div>
            <dl className="data-list">
              <dt>Feature cutoff</dt>
              <dd>{time(trace.candidate.dataCutoff)} UTC</dd>
              <dt>Regime known at decision</dt>
              <dd>{trace.decision.request.regime.kind}</dd>
              <dt>Model calibration</dt>
              <dd>{trace.decision.calibration}</dd>
              <dt>Authorized quantity</dt>
              <dd>{trace.decision.risk.decision.sizing.quantity}</dd>
              <dt>Realized net outcome</dt>
              <dd className={Number(trace.realizedNetPnl) < 0 ? 'negative' : ''}>
                {money(trace.realizedNetPnl)} {overview?.quoteCurrency}
              </dd>
            </dl>
            <h3>Deterministic reasons</h3>
            {trace.decision.finalReasons.map((r, i) => (
              <p className="reason" key={i}>
                {r}
              </p>
            ))}
            <h3>Source and evidence</h3>
            {trace.decision.request.evidence.map((e) => (
              <a
                className="evidence-link"
                key={e.id}
                href={`/api/evidence/${encodeURIComponent(e.id)}`}
                target="_blank"
                rel="noreferrer"
              >
                <strong>{e.id}</strong>
                <small>{e.contentHash}</small>
                <span>Available {time(e.availableAt)} UTC ↗</span>
              </a>
            ))}
            <h3>Execution chain</h3>
            {trace.fills.map((f) => (
              <div className="fill-line" key={f.fill.id}>
                <strong>
                  {f.fill.side} {f.fill.quantity} @ {money(f.fill.price)}
                </strong>
                <span>
                  {time(f.fill.filledAt)} UTC · fee {money(f.fill.fee, 4)}
                </span>
                <small>{f.fidelity.replaceAll('_', ' ')}</small>
              </div>
            ))}
            <p className="small-note">
              Predictive feature vectors and original source text require their exact
              producer/source bundles. Missing content is never invented.
            </p>
          </aside>
        </div>
      )}
    </div>
  );
}

function ResearchDetails() {
  const [studies, setStudies] = useState<z.infer<typeof EventStudyResultSchema>[]>([]),
    [parameters, setParameters] = useState<unknown>(null),
    [correlations, setCorrelations] = useState<
      { left: string; right: string; pairedDays: number; value: number | null }[]
    >([]),
    [failure, setFailure] = useState(false);
  useEffect(() => {
    void Promise.all([
      api('/studies', opsPageSchema(EventStudyResultSchema.extend({ hash: z.string() }))),
      api('/parameters', z.json()),
      api(
        '/correlations',
        z.object({
          pairs: z.array(
            z.object({
              left: z.string(),
              right: z.string(),
              pairedDays: z.number(),
              value: z.number().nullable(),
            }),
          ),
        }),
      ),
    ])
      .then(([s, p, c]) => {
        setStudies(s.items);
        setParameters(p);
        setCorrelations(c.pairs);
      })
      .catch(() => setFailure(true));
  }, []);
  return (
    <>
      <section className="panel">
        <h2>Historical event studies</h2>
        <p className="small-note">
          Synthetic archive context · descriptive association, no causal or executable claim.
          Missing windows remain N/A.
        </p>
        {failure && <p>Research detail is unavailable.</p>}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Asset</th>
                <th>Window</th>
                <th>Observed bars</th>
                <th>Status</th>
                <th>Net response</th>
                <th>Benchmark adjusted</th>
              </tr>
            </thead>
            <tbody>
              {studies.flatMap((s) =>
                s.events.flatMap((e) =>
                  e.responses.flatMap((r) =>
                    r.windows
                      .filter((w) => ['+1m', '+5m', '+1h', '+24h'].includes(w.label))
                      .map((w) => (
                        <tr
                          key={`${s.inputHash}-${e.event.identity.id}-${r.series.asset}-${w.label}`}
                        >
                          <td>{r.series.asset}</td>
                          <td>{w.label}</td>
                          <td>
                            {w.observedBars}/{w.expectedBars}
                          </td>
                          <td>{w.status}</td>
                          <td>{pct(w.netReturn)}</td>
                          <td>{pct(w.benchmarkAdjustedReturn)}</td>
                        </tr>
                      )),
                  ),
                ),
              )}
            </tbody>
          </table>
        </div>
        {!studies.length && <p className="small-note">No verified study attached.</p>}
        {studies.map((s) => (
          <p key={s.inputHash} className="hash">
            Input {s.inputHash} · config {s.configHash}
          </p>
        ))}
      </section>
      <section className="panel">
        <h2>Return correlation audit</h2>
        <p className="small-note">
          Complete daily arm returns only; at least three variable paired days required. Cross-asset
          correlations are unavailable without an aligned price panel.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Pair</th>
                <th>Complete days</th>
                <th>Pearson correlation</th>
              </tr>
            </thead>
            <tbody>
              {correlations.map((c) => (
                <tr key={`${c.left}-${c.right}`}>
                  <td>
                    {c.left} / {c.right}
                  </td>
                  <td>{c.pairedDays}</td>
                  <td>
                    {c.value === null ? 'N/A · insufficient or constant' : c.value.toFixed(4)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel">
        <h2>Frozen strategy and risk parameters</h2>
        <p className="small-note">
          The validated manifest and exact risk policies are read-only. Producer settings require
          their hashed bundles.
        </p>
        <details>
          <summary>Inspect versioned configuration</summary>
          <pre style={{ overflowX: 'auto', maxHeight: 400 }}>
            {JSON.stringify(parameters, null, 2)}
          </pre>
        </details>
      </section>
    </>
  );
}
