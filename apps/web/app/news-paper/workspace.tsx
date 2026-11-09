'use client';
import { useEffect, useState } from 'react';
import type { z } from 'zod';
import {
  LIVE_EXCHANGES,
  LIVE_ASSETS,
  ForwardOverview as LiveOverviewSchema,
  ForwardPage as LivePageSchema,
} from '../../../../packages/contracts/src/news-forward';
import type { LivePosition } from '../../../../packages/contracts/src/news-forward';
type LiveOverview = z.infer<typeof LiveOverviewSchema>;
import '../live-paper/workspace.css';

const money = (v: string | number) =>
  Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const stamp = (v: number | null) =>
  v === null ? '—' : new Date(v).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
async function request(path: string, body?: unknown) {
  const send = () =>
    fetch('/api' + path, {
      signal: AbortSignal.timeout(45000),
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
  let response = await send();
  if (response.status === 401) {
    const access = (await fetch('/api/ready', { cache: 'no-store' }).then((r) => r.json())) as {
      demoAutoLogin?: boolean;
    };
    if (access.demoAutoLogin) {
      await fetch('/api/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'fixture-read-0000000000000000000000' }),
      });
      response = await send();
    }
  }
  if (!response.ok) {
    const message =
      response.status === 404
        ? 'News paper trading is not enabled in this environment.'
        : response.status === 409
          ? 'The frozen news run could not accept this control. Refresh its status and try again.'
          : 'Live paper service is unavailable; check the dashboard process and PostgreSQL.';
    throw new Error(message);
  }
  return response.json() as Promise<unknown>;
}
export default function NewsPaperWorkspace() {
  const [overview, setOverview] = useState<LiveOverview | null>(null),
    [page, setPage] = useState<z.infer<typeof LivePageSchema> | null>(null),
    [filters, setFilters] = useState<Record<string, string>>({
      sort: 'openedAt',
      direction: 'desc',
      page: '1',
      pageSize: '25',
    }),
    [selectedRun, setSelectedRun] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [refresh, setRefresh] = useState(0),
    [clock, setClock] = useState(0),
    [detail, setDetail] = useState<LivePosition | null>(null);
  const query = new URLSearchParams(
    Object.entries({ ...filters, ...(selectedRun ? { runId: selectedRun } : {}) }).filter(
      ([, v]) => v !== '',
    ),
  );
  const key = query.toString();
  useEffect(() => {
    setClock(Date.now());
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let cancelled = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      try {
        const o = LiveOverviewSchema.parse(
          await request(
            '/news-paper' + (selectedRun ? '?runId=' + encodeURIComponent(selectedRun) : ''),
          ),
        );
        const q = new URLSearchParams(key);
        if (!q.has('runId') && o.run) q.set('runId', o.run.id);
        const p = LivePageSchema.parse(await request('/news-paper/positions?' + q.toString()));
        if (!cancelled) {
          setOverview(o);
          setPage(p);
          setError('');
          setDetail((old) => (old ? (p.positions.find((p) => p.id === old.id) ?? old) : null));
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Live service unavailable.');
      } finally {
        if (!cancelled)
          timer = setTimeout(() => {
            void load();
          }, 5000);
      }
    }
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [key, selectedRun, refresh]);
  const run = overview?.run;
  function filter(k: string, v: string) {
    setFilters((old) => ({ ...old, [k]: v, page: '1' }));
  }
  async function control(action: 'START' | 'PAUSE' | 'RESUME' | 'STOP') {
    setBusy(true);
    try {
      await request(
        action === 'START' ? '/news-paper/start' : '/news-paper/control',
        action === 'START' ? {} : { action },
      );
      setSelectedRun('');
      setRefresh((v) => v + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Control failed.');
    } finally {
      setBusy(false);
    }
  }
  const exportQuery = new URLSearchParams(key);
  if (!exportQuery.has('runId') && run) exportQuery.set('runId', run.id);
  const now = clock || overview?.asOf || 0;
  const remaining = run ? Math.max(0, run.deadlineAt - now) : 0;
  const ready = overview?.worker === 'RUNNING' && !overview.error && !error;
  return (
    <div className="live-workspace">
      <div className="context-bar">
        <span className="context-dot" />
        <strong>Real public quotes · internal paper positions</strong>
        <span>Ten tokens · frozen news V6 rules · five independent exchanges</span>
      </div>
      <div className="notice">
        EXPLORATORY PAPER TEST · Historical results are descriptive and do not establish
        profitability. Only fresh post-start news can create candidates. Frozen V6 uses
        deterministic news categories; AI extraction is monitored separately.
      </div>
      {run && (
        <section className="panel">
          <h2>News decisions and frozen token rules</h2>
          <p>
            {run.processed.length} new article versions inspected ·{' '}
            {Object.keys(run.pending).length} pending exchange candidates. Entries wait at least
            five minutes, then the next UTC hour, for a fresh executable book.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Token</th>
                  <th>Selected V6 case</th>
                  <th>Active rules</th>
                  <th>Holding horizon</th>
                </tr>
              </thead>
              <tbody>
                {LIVE_ASSETS.map((asset) => (
                  <tr key={asset}>
                    <td>{asset}</td>
                    <td>{run.config.profiles[asset].selectedCase}</td>
                    <td>
                      {run.config.profiles[asset].rules
                        .filter((r) => r.side !== 'HOLD')
                        .map((r) => r.group + ': ' + r.side)
                        .join('; ') || 'HOLD / cash'}
                    </td>
                    <td>{run.config.profiles[asset].config.horizonHours}h</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            {Object.entries(run.counters)
              .map(([key, count]) => `${key.replaceAll('_', ' ')}: ${count}`)
              .join(' · ') || 'Waiting for new news.'}
          </p>
        </section>
      )}
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      {overview?.error && (
        <div className="notice error" role="alert">
          {overview.error}
        </div>
      )}
      <section className="panel live-run">
        <div>
          <div className="eyebrow">24-HOUR FORWARD TEST</div>
          <h2>
            {run
              ? run.status === 'ENDED'
                ? 'Run complete'
                : run.status === 'STOPPING'
                  ? 'Closing positions; waiting for fresh liquidity'
                  : `${run.status} · ${Math.floor(remaining / 3600000)}h ${Math.floor((remaining % 3600000) / 60000)}m remaining`
              : 'Ready for a new live paper run'}
          </h2>
          <p>
            10,000 virtual USDT per exchange · 50,000 total. All ten tokens share each exchange
            account. Fees are on.
          </p>
          {run ? (
            <p>
              Started {stamp(run.startedAt)}
              <br />
              Deadline {stamp(run.deadlineAt)}
              {run.endedAt && (
                <>
                  <br />
                  Finished {stamp(run.endedAt)}
                </>
              )}
              <br />
              <small>
                Run {run.id} · worker heartbeat {stamp(run.heartbeatAt)}
              </small>
            </p>
          ) : (
            <p>
              The service is ready once the frozen V6 report and durable queue are loaded. No
              historical news is replayed into this forward account.
            </p>
          )}
        </div>
        <div className="live-controls">
          <label>
            Run
            <select
              value={selectedRun}
              onChange={(e) => {
                setSelectedRun(e.target.value);
                filter('page', '1');
              }}
            >
              <option value="">Latest / active run</option>
              {overview?.runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {stamp(r.startedAt)} · {r.status}
                </option>
              ))}
            </select>
          </label>
          {!run || run.status === 'ENDED' ? (
            <button
              className="button"
              disabled={busy || !ready}
              onClick={() => {
                void control('START');
              }}
            >
              Start 24-hour paper run
            </button>
          ) : (
            <>
              <button
                className="button"
                disabled={busy || run.status === 'STOPPING'}
                onClick={() => {
                  void control(run.status === 'PAUSED' ? 'RESUME' : 'PAUSE');
                }}
              >
                {run.status === 'PAUSED' ? 'Resume entries' : 'Pause entries'}
              </button>
              <button
                className="button"
                disabled={busy || run.status === 'STOPPING'}
                onClick={() => {
                  void control('STOP');
                }}
              >
                End run and close positions
              </button>
            </>
          )}
          <small>
            Pause keeps stop and target monitoring active. The server must stay running and the VPS
            online.
          </small>
        </div>
      </section>
      <div className="live-venues">
        {LIVE_EXCHANGES.map((exchange) => {
          const feeds = overview?.feeds.filter((f) => f.exchange === exchange) ?? [],
            s = overview?.summaries.find((s) => s.exchange === exchange),
            a = run?.accounts.find((a) => a.exchange === exchange);
          return (
            <section className="panel live-venue" key={exchange}>
              <h3>{exchange}</h3>
              {s && (
                <>
                  <strong className={Number(s.netPnl) < 0 ? 'negative' : 'positive'}>
                    {money(s.equity)} USDT
                  </strong>
                  <p>
                    Net P&amp;L {money(s.netPnl)} USDT {s.stale && <b>· stale valuation</b>}
                  </p>
                  <small>
                    Booked P&amp;L {money(s.realized)}
                    <br />
                    Unrealized / estimated exit costs {money(s.unrealized)}
                    <br />
                    Open value {money(s.openNotional)}
                    <br />
                    Fees {money(a?.fees ?? '0')} · borrow {money(a?.financing ?? '0')}
                    <br />
                    Assumed fee {Number(run?.config.feeRates[exchange] ?? 0) * 100}% per fill
                  </small>
                </>
              )}
              {feeds.map((f) => {
                const age = f.book ? now - f.book.source.receivedAt : Infinity,
                  healthy = !f.error && age <= 15000;
                return (
                  <div className="live-feed" key={f.asset}>
                    <b>
                      {f.asset} ·{' '}
                      {healthy
                        ? 'LIVE'
                        : f.error
                          ? 'UNAVAILABLE'
                          : f.book
                            ? 'STALE'
                            : 'WAITING FOR NEWS'}
                    </b>
                    <span>
                      {f.book
                        ? `${f.book.bids[0]![0]} / ${f.book.asks[0]![0]}`
                        : 'Quotes requested when a news candidate or position needs them.'}
                    </span>
                    <small>
                      News-driven quotes ·{' '}
                      {Number.isFinite(age)
                        ? `${Math.max(0, Math.floor(age / 1000))}s ago`
                        : 'no quote'}
                      <br />
                      {f.book?.source.providerAt === null
                        ? 'Exchange time unavailable; receipt clock'
                        : f.book
                          ? 'Exchange timestamp verified'
                          : ''}
                    </small>
                    {f.error && <small className="negative">{f.error}</small>}
                    <small>
                      {run?.decisions[`${exchange}:${f.asset}`] ??
                        'HOLD: waiting for fresh supported news.'}
                    </small>
                  </div>
                );
              })}
            </section>
          );
        })}
      </div>
      <section className="panel">
        <div className="live-table-heading">
          <div>
            <div className="eyebrow">PERSISTED POSITIONS</div>
            <h2>Open and closed trades</h2>
            <p>
              {page?.total ?? 0} matching positions · snapshot {stamp(page?.asOf ?? null)}
            </p>
          </div>
          <div className="live-export">
            {(['json', 'csv', 'tsv', 'md'] as const).map((f) => (
              <a key={f} className="button" href={`/api/news-paper/export/${f}?${exportQuery}`}>
                ↓ {f.toUpperCase()}
              </a>
            ))}
          </div>
        </div>
        <div className="live-filters">
          {(
            [
              ['exchange', 'Exchange', LIVE_EXCHANGES],
              ['asset', 'Token', LIVE_ASSETS],
              ['side', 'Direction', ['LONG', 'SHORT']],
              ['status', 'Result', ['WORKING', 'WIN', 'LOSS', 'BREAKEVEN']],
              ['lifecycle', 'Position', ['OPEN', 'CLOSING', 'CLOSED']],
            ] as const
          ).map(([key, label, options]) => (
            <label key={key}>
              {label}
              <select value={filters[key] ?? ''} onChange={(e) => filter(key, e.target.value)}>
                <option value="">All</option>
                {options.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
            </label>
          ))}
          <label>
            Date field
            <select
              value={filters.dateField ?? 'openedAt'}
              onChange={(e) => filter('dateField', e.target.value)}
            >
              <option value="openedAt">Opened</option>
              <option value="closedAt">Closed</option>
            </select>
          </label>
          {(['from', 'to'] as const).map((k) => (
            <label key={k}>
              {k === 'from' ? 'From' : 'To'} (UTC)
              <input
                type="datetime-local"
                value={filters[k] ? new Date(Number(filters[k])).toISOString().slice(0, 16) : ''}
                onChange={(e) =>
                  filter(k, e.target.value ? String(Date.parse(e.target.value + 'Z')) : '')
                }
              />
            </label>
          ))}
          <label>
            Min net P&amp;L
            <input
              type="number"
              step="any"
              value={filters.minPnl ?? ''}
              onChange={(e) => filter('minPnl', e.target.value)}
            />
          </label>
          <label>
            Max net P&amp;L
            <input
              type="number"
              step="any"
              value={filters.maxPnl ?? ''}
              onChange={(e) => filter('maxPnl', e.target.value)}
            />
          </label>
          <label>
            Sort
            <select value={filters.sort} onChange={(e) => filter('sort', e.target.value)}>
              {[
                'openedAt',
                'closedAt',
                'netPnl',
                'notional',
                'fees',
                'exchange',
                'asset',
                'side',
                'status',
              ].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          <label>
            Order
            <select value={filters.direction} onChange={(e) => filter('direction', e.target.value)}>
              <option value="desc">Descending</option>
              <option value="asc">Ascending</option>
            </select>
          </label>
          <button
            className="button"
            onClick={() =>
              setFilters({ sort: 'openedAt', direction: 'desc', page: '1', pageSize: '25' })
            }
          >
            Reset filters
          </button>
        </div>
        <p className="live-note">
          WORKING means the position remains open, even if its current P&amp;L is positive or
          negative. WIN / LOSS is assigned after the final close. Open P&amp;L includes estimated
          exit costs; stale marks are not fresh profit. Exports contain all matching rows in the
          selected order.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {[
                  'Opened / closed UTC',
                  'Exchange',
                  'Token',
                  'Side',
                  'Result / position',
                  'Quantity / remaining',
                  'Entry / mark USDT',
                  'Value USDT',
                  'Net P&L USDT',
                  'Fees / borrow',
                  'Stop / target',
                  'Details',
                ].map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {page?.positions.map((p) => (
                <tr key={p.id}>
                  <td>
                    {stamp(p.openedAt)}
                    <br />
                    <small>{stamp(p.closedAt)}</small>
                  </td>
                  <td>{p.exchange}</td>
                  <td>{p.asset}</td>
                  <td>{p.side}</td>
                  <td>
                    {p.status}
                    <br />
                    <small>{p.lifecycle}</small>
                  </td>
                  <td>
                    {p.quantity}
                    <br />
                    <small>{p.remaining}</small>
                  </td>
                  <td>
                    {Number(p.entry).toFixed(5)} / {Number(p.mark).toFixed(5)}
                    <br />
                    <small>Mark {stamp(p.markAt)}</small>
                  </td>
                  <td>{money(p.notional)}</td>
                  <td className={Number(p.netPnl) < 0 ? 'negative' : 'positive'}>
                    {money(p.netPnl)}
                    {p.lifecycle !== 'CLOSED' && now - p.markAt > 15000 && <small> STALE</small>}
                  </td>
                  <td>
                    {money(p.fees)} / {money(p.financing)}
                  </td>
                  <td>
                    {p.stop}
                    <br />
                    {p.target}
                  </td>
                  <td>
                    <button className="button" onClick={() => setDetail(p)}>
                      Inspect
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!page?.positions.length && (
            <div className="empty">
              {run
                ? 'No positions match. News V6 waits for fresh supported news and risk approval; no trades are forced.'
                : 'Start a run when the service is ready. Positions appear only after eligible new events.'}
            </div>
          )}
        </div>
        <div className="live-pages">
          <button
            className="button"
            disabled={Number(filters.page) <= 1}
            onClick={() => setFilters((f) => ({ ...f, page: String(Number(f.page) - 1) }))}
          >
            Previous
          </button>
          <span>
            Page {filters.page} /{' '}
            {Math.max(1, Math.ceil((page?.total ?? 0) / Number(filters.pageSize)))}
          </span>
          <button
            className="button"
            disabled={Number(filters.page) * Number(filters.pageSize) >= (page?.total ?? 0)}
            onClick={() => setFilters((f) => ({ ...f, page: String(Number(f.page) + 1) }))}
          >
            Next
          </button>
        </div>
      </section>
      {detail && (
        <section className="panel live-detail">
          <button className="button" onClick={() => setDetail(null)}>
            Close details
          </button>
          <h2>
            {detail.exchange} · {detail.asset} · {detail.side} · {detail.status}
          </h2>
          <p>
            Position {detail.id}
            <br />
            Exit reason: {detail.exitReason ?? 'Still open'} · Net {money(detail.netPnl)} USDT
          </p>
          <h3>Decision evidence</h3>
          <pre>{JSON.stringify(detail.decision, null, 2)}</pre>
          <h3>Simulated fills</h3>
          {detail.fills.map((f, i) => (
            <p key={i}>
              {stamp(f.at)} · {f.kind} · {f.quantity} @ {f.price} · fee {f.fee} · slippage{' '}
              {f.slippage}
              <br />
              {f.reason} ·{' '}
              <a
                target="_blank"
                rel="noreferrer"
                href={`/api/news-paper/evidence/${detail.runId}/${f.quoteId}`}
              >
                Original exchange quote
              </a>
            </p>
          ))}
        </section>
      )}
      <section className="panel live-note">
        <h3>How this forward test works</h3>
        <p>
          V6 uses completed hourly MA20/50 crossovers, a MA200 trend filter, ATR risk limits and
          separate SOL/XRP short filters. Recent candles initialize indicators only. Entries use the
          first fresh public quote received after a new decision. Positions and fills are internal
          records in PostgreSQL.
        </p>
        <p>
          Each entry risks up to 0.25% of exchange equity, uses up to 10% of it, and shares a 20%
          exposure cap with the other token. A 2% daily loss limit blocks entries and requests
          closure. Orders use at most 10% of the visible quantity at each of five book levels, with
          spread, 0.05% adverse slippage and lot/tick rounding. Partial entries cancel the
          remainder; partial exits wait for a new book.
        </p>
        <p>
          These are fully collateralized, cash-settled paper exposures priced from public spot
          books. Shorts assume 0.0003% hourly simple borrowing; actual exchange borrow availability,
          perpetual funding and liquidation are not modeled. Fee tiers are estimates, not
          account-specific quotes. OKX uses an internal 5 USDT minimum; MEXC precision minima are
          conservative. Fifteen-second polling can miss price moves between samples. News V6 was
          selected using historical results; this new forward test measures what happens from now.
        </p>
        <p>
          The browser can be closed. The independent Docker service continues on the VPS. Restarting
          resumes the saved run and original deadline; missed time is not backfilled with invented
          trades. A stale exchange waits for fresh data before closing at the deadline. JSON
          includes full position and fill evidence; CSV, TSV and Markdown provide flat analysis
          tables.
        </p>
      </section>
    </div>
  );
}
