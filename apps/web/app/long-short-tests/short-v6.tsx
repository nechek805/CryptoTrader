'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { z } from 'zod';
import {
  ShortV6MatrixSchema,
  ShortV6StateSchema,
  ShortV6ViewSchema,
  ShortV6JobSchema,
  DEFAULT_SHORT_V6_FEES,
} from '@crypto/contracts';
import type { DirectionMode, MarketAsset, ShortV6Key, ShortV6Candidate } from '@crypto/contracts';
import '../market-strategy-tests/market-strategy-tests.css';
import './directional-tests.css';
const Matrix = z.strictObject({ id: z.string(), matrix: ShortV6MatrixSchema });
type State = z.infer<typeof ShortV6StateSchema>;
type Detail = z.infer<typeof ShortV6ViewSchema>;
const keys = ['V1', 'V2', 'V3', 'V4', 'V5', 'V6'] as const,
  assets = ['BTC', 'ETH', 'SOL', 'TRX', 'BNB', 'XRP', 'DOGE', 'ADA', 'LINK', 'AVAX'] as const;
const modes: Record<DirectionMode, string> = {
  LONG_ONLY: 'Long only · original',
  SHORT_ONLY: 'Short only',
  LONG_SHORT: 'Long + short',
};
const money = (v: string | number) =>
    Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  pct = (v: string) => `${(Number(v) * 100).toFixed(2)}%`,
  stamp = (v: number) => new Date(v).toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
  color = (v: string) => (Number(v) < 0 ? 'strategy-loss' : 'strategy-profit');
const describeRules = (c: ShortV6Candidate) =>
  c.kind === 'BASELINE'
    ? 'Keep the original V5 short rules.'
    : c.asset === 'SOL'
      ? `Require MA200 to fall at least ${c.minSlopeAtr} ATR over 24 hours; short target ${c.targetAtr} ATR; stop stays 2.5 ATR; ${c.trailDistanceAtr ? 'trailing distance ' + c.trailDistanceAtr + ' ATR after a completed close reaches 3 ATR profit' : 'no trailing stop'}.`
      : `Require signal close ${c.minDistanceAtr}–${c.maxDistanceAtr} ATR below MA200; short target ${c.targetAtr} ATR; stop stays 2 ATR. Retain V5 candle-quality and impulse gates.`;
async function api<T>(path: string, schema: z.ZodType<T>, body?: unknown) {
  const r = await fetch('/api/short-v6' + path, {
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
        ? 'Refresh to reconnect your session.'
        : r.status === 409
          ? 'Wait for the active comparison.'
          : 'Could not read the directional comparison. Retry or check the local API.',
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
  onChange: (on: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = mixed;
  }, [mixed]);
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
export default function ShortV6Tests() {
  const [state, setState] = useState<State | null>(null),
    [matrix, setMatrix] = useState<z.infer<typeof Matrix> | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [saving, setSaving] = useState(false),
    [mode, setMode] = useState<DirectionMode>('LONG_SHORT'),
    [tab, setTab] = useState<'Results' | 'V6 research' | 'Trade explorer' | 'Rules & assumptions'>(
      'Results',
    ),
    [asset, setAsset] = useState<MarketAsset>('SOL'),
    [strategy, setStrategy] = useState<ShortV6Key>('V6'),
    [detail, setDetail] = useState<Detail | null>(null),
    [hour, setHour] = useState(0),
    [page, setPage] = useState(0),
    [detailLoading, setDetailLoading] = useState(false),
    [verified, setVerified] = useState(''),
    [verifying, setVerifying] = useState(false);
  const fees = state?.fees ?? DEFAULT_SHORT_V6_FEES,
    busy = loading || saving || state?.job?.status === 'RUNNING',
    all = Object.values(fees).every(Boolean),
    mixed = Object.values(fees).some(Boolean) && !all,
    cell = matrix?.matrix.cells.find(
      (c) =>
        c.asset === asset &&
        c.strategy === strategy &&
        c.mode === mode &&
        c.feeMode === (fees[strategy] ? 'STANDARD' : 'ZERO'),
    ),
    reportId = cell?.reportId;
  async function load() {
    setLoading(true);
    setError('');
    try {
      const s = await api('', ShortV6StateSchema);
      setState(s);
      setMatrix(s.matrixId ? await api('/matrix', Matrix) : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load comparison.');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    const query = new URLSearchParams(window.location.search);
    if (assets.includes(query.get('asset') as MarketAsset)) {
      setAsset(query.get('asset') as MarketAsset);
      if (!['SOL', 'XRP'].includes(query.get('asset')!)) setStrategy('V3');
    }
  }, []);
  useEffect(() => {
    if (state?.job?.status !== 'RUNNING') return;
    let active = true;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const s = await api('', ShortV6StateSchema);
          if (!active) return;
          setState(s);
          if (s.job?.status !== 'RUNNING' && s.matrixId) {
            const m = await api('/matrix', Matrix);
            if (active) setMatrix(m);
          }
        } catch (e) {
          if (active) setError(e instanceof Error ? e.message : 'Could not read progress.');
        }
      })();
    }, 1800);
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
    setVerified('');
    void api(`/report?asset=${asset}&strategy=${strategy}&mode=${mode}`, ShortV6ViewSchema)
      .then((r) => {
        if (active) {
          setDetail(r);
          setHour(
            r.report.decisions.find((d) => d.action === 'LONG' || d.action === 'SHORT')?.index ?? 0,
          );
        }
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : 'Could not load report.');
      })
      .finally(() => {
        if (active) setDetailLoading(false);
      });
    return () => {
      active = false;
    };
  }, [asset, strategy, mode, tab, reportId]);
  async function run() {
    setSaving(true);
    setError('');
    try {
      const job = await api('/run', ShortV6JobSchema, {});
      setState((prev) => ({
        matrixId: prev?.matrixId ?? null,
        fees: prev?.fees ?? DEFAULT_SHORT_V6_FEES,
        job,
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start.');
    } finally {
      setSaving(false);
    }
  }
  async function setFees(next: State['fees']) {
    setSaving(true);
    setError('');
    try {
      setState(await api('/fees', ShortV6StateSchema, { fees: next }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save fees.');
    } finally {
      setSaving(false);
    }
  }
  const decision = detail?.report.decisions[hour],
    bar = detail?.bars[hour],
    directional =
      detail?.report.version === 'directional-replay.v1' ||
      detail?.report.version === 'short-v6-replay.v1'
        ? detail.report
        : null;
  return (
    <div className="strategy-tests directional-tests short-v6-tests">
      <div className="context-bar">
        <span className="context-dot" />
        <strong>All ten tokens · simulated shorts</strong>
        <span>Same real hourly candles · 10,000 virtual USDT per account</span>
        <span className="context-status">ASSUMED BORROW MODEL</span>
      </div>
      <section className="panel strategy-intro">
        <div>
          <div className="eyebrow">MARKET STRATEGIES / BOTH DIRECTIONS</div>
          <h2>Compare long and short trading</h2>
          <p>
            V1–V3 cover BTC, ETH, SOL, TRX, BNB, XRP, DOGE, ADA, LINK and AVAX. SOL and XRP also
            retain their separate V4/V5 profiles and now have separate short-focused V6 rules. Every
            V1–V5 report remains unchanged. V6 preserves the V5 long-only rules.
          </p>
          <p className="muted">
            Shorts use spot-price proxies, 1x collateral, a fixed 10% annual borrowing-cost
            assumption and conservative stops. Historical borrow availability and rates are unknown.
            Fees and slippage remain separate costs.
          </p>
          {matrix && (
            <p>
              {stamp(matrix.matrix.from)} → {stamp(matrix.matrix.to)} · end exclusive
            </p>
          )}
        </div>
        <div className="strategy-actions">
          <button className="primary" disabled={busy} onClick={() => void run()}>
            {state?.job?.status === 'RUNNING'
              ? 'Comparison running…'
              : matrix
                ? 'Rerun SOL & XRP V6 research'
                : 'Run SOL & XRP V6 research'}
          </button>
          {matrix && (
            <a className="button" href="/api/short-v6/export">
              ↓ Export full comparison
            </a>
          )}
        </div>
      </section>
      <section className="panel">
        <h2>Position direction</h2>
        <div className="strategy-tabs" role="group" aria-label="Position direction">
          {(Object.keys(modes) as DirectionMode[]).map((m) => (
            <button
              key={m}
              aria-pressed={mode === m}
              className={mode === m ? 'selected' : ''}
              onClick={() => {
                setMode(m);
                setVerified('');
              }}
            >
              {modes[m]}
            </button>
          ))}
        </div>
        <p>
          Combined mode shares one 10,000-USDT account per coin/version, with one position at a
          time. Reversals close the old position before opening the new one. USDT remains a cash
          baseline.
        </p>
      </section>
      <section className="panel strategy-fee-controls">
        <h2>Trading fees</h2>
        <p>
          One switch for all coins, versions and positions, plus per-version switches. Settings are
          saved for this comparison. Borrowing charges and 0.05% adverse slippage per side remain
          enabled when trading fees are off.
        </p>
        <div className="strategy-fee-switches">
          <FeeSwitch
            label="Fees for all versions"
            checked={all}
            mixed={mixed}
            disabled={busy}
            onChange={(on) => void setFees({ V1: on, V2: on, V3: on, V4: on, V5: on, V6: on })}
          />
          {keys.map((k) => (
            <FeeSwitch
              key={k}
              label={`${k} fees`}
              checked={fees[k]}
              disabled={busy}
              onChange={(on) => void setFees({ ...fees, [k]: on })}
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
          <button className="button" onClick={() => void load()}>
            Reload
          </button>
        </div>
      )}
      <div className="strategy-tabs" role="group" aria-label="Directional research section">
        {(['Results', 'V6 research', 'Trade explorer', 'Rules & assumptions'] as const).map((t) => (
          <button
            key={t}
            aria-pressed={tab === t}
            className={tab === t ? 'selected' : ''}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      {loading ? (
        <section className="panel empty">Opening saved direction tests…</section>
      ) : !matrix ? (
        <section className="panel empty">
          <h2>Prepare the separate V6 short profiles</h2>
          <p>
            Retain the original ten-token V1–V5 comparison and develop separate SOL/XRP short rules
            on the same saved history, with every candidate and later check visible.
          </p>
          <button className="primary" disabled={busy} onClick={() => void run()}>
            Run V6 research
          </button>
        </section>
      ) : (
        <>
          {tab === 'Results' && (
            <section className="panel">
              <h2>{modes[mode]} · net P&amp;L after selected costs</h2>
              <p>
                Every result is a separate 10,000-USDT account. Select a result to inspect signals,
                borrowing, collateral and fills. Missing V4/V5/V6 cells mean that a coin-specific
                profile was never developed.
              </p>
              <div className="table-wrap">
                <table className="directional-matrix short-v6-matrix">
                  <thead>
                    <tr>
                      <th>Token / USDT</th>
                      {keys.map((k) => (
                        <th key={k}>
                          {k}
                          <small>Fees {fees[k] ? 'on' : 'off'}</small>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {assets.map((a) => (
                      <tr key={a}>
                        <th>{a}</th>
                        {keys.map((k) => {
                          const c = matrix.matrix.cells.find(
                            (c) =>
                              c.asset === a &&
                              c.strategy === k &&
                              c.mode === mode &&
                              c.feeMode === (fees[k] ? 'STANDARD' : 'ZERO'),
                          );
                          return (
                            <td key={k}>
                              {c ? (
                                <button
                                  className="strategy-result"
                                  onClick={() => {
                                    setAsset(a);
                                    setStrategy(k);
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
                                  <span>DD {pct(c.summary.maxDrawdown)}</span>
                                  {'short' in c.summary && (
                                    <>
                                      <span>
                                        Long {money(c.summary.long.net)} / Short{' '}
                                        {money(c.summary.short.net)}
                                      </span>
                                      <span>Borrowing {money(c.summary.financing)}</span>
                                      {c.summary.insolvent && (
                                        <span className="strategy-loss">
                                          Insolvent · trading halted
                                        </span>
                                      )}
                                    </>
                                  )}
                                  <span>
                                    Fees {money(c.summary.fees)} · Slip {money(c.summary.slippage)}
                                  </span>
                                  <span className="strategy-link">Inspect decisions ↗</span>
                                </button>
                              ) : (
                                <span className="muted">Not developed</span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="muted">
                Long/short subtotals show closed-trade net profit, including fees and borrowing.
                Final equity also includes any open-position contribution. Combined returns are not
                the sum of the independent long-only and short-only tests. Cash baseline: 10,000
                USDT.
              </p>
            </section>
          )}
          {tab === 'V6 research' && (
            <>
              <section className="panel">
                <h2>Separate short strategies, fixed long rules and risk</h2>
                <p>
                  All research evidence here uses fees on (0.10% per fill), 0.05% adverse slippage
                  plus tick rounding, and the same 10% annual borrowing assumption. The fee switches
                  select comparison scenarios without retuning V6.
                </p>
                <p>
                  Development: {stamp(matrix.matrix.from)} →{' '}
                  {stamp(matrix.matrix.from + matrix.matrix.splitIndex * 3600000)}. Later checks
                  reset capital and positions at that split. Both periods were previously seen; the
                  later slice is an exploratory check.
                </p>
                {matrix.matrix.searchNotes.map((note) => (
                  <p className="muted" key={note}>
                    {note}
                  </p>
                ))}
              </section>
              {matrix.matrix.research.map((r) => (
                <div key={r.asset}>
                  <section className="panel">
                    <div className="eyebrow">{r.asset} / V6 SHORT PROFILE</div>
                    <h2>
                      {r.asset === 'SOL'
                        ? 'Avoid shallow downtrends; take nearer short profits'
                        : 'Avoid MA200 whipsaws and extended short entries'}
                    </h2>
                    <p>
                      <strong>{describeRules(r.selected)}</strong>
                    </p>
                    {r.diagnosis.map((line) => (
                      <p key={line}>{line}</p>
                    ))}
                    <h3>Same full history · fees on · net USDT</h3>
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Direction</th>
                            <th>V5</th>
                            <th>V6</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(['LONG_ONLY', 'SHORT_ONLY', 'LONG_SHORT'] as const).map((m) => (
                            <tr key={m}>
                              <th>{modes[m]}</th>
                              {(['V5', 'V6'] as const).map((v) => {
                                const c = matrix.matrix.cells.find(
                                  (c) =>
                                    c.asset === r.asset &&
                                    c.strategy === v &&
                                    c.mode === m &&
                                    c.feeMode === 'STANDARD',
                                )!;
                                return (
                                  <td className={color(c.summary.netPnl)} key={v}>
                                    {money(c.summary.netPnl)}
                                    <small>
                                      {c.summary.closedTrades} closed · {c.summary.wins} wins
                                    </small>
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p>
                      Long-only rules are unchanged. Combined results share capital: different short
                      entries and exits can change later quantities and opportunities.
                    </p>
                  </section>
                  <section className="panel">
                    <h2>{r.asset}: earlier choice and later check</h2>
                    <p>
                      Rank earlier short-only net profit with fees on; require at least two closed
                      trades and hourly drawdown ≤2%. Full-period and combined profits never choose
                      the candidate. Slice profits are not additive.
                    </p>
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Period / direction</th>
                            <th>V5 net USDT</th>
                            <th>V6 net USDT</th>
                            <th>V6 closed / wins</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(['development', 'check'] as const).flatMap((period) =>
                            ['Short', 'Combined'].map((kind) => {
                              const slice = r[period],
                                a = kind === 'Short' ? slice.v5Short : slice.v5Combined,
                                b = kind === 'Short' ? slice.v6Short : slice.v6Combined;
                              return (
                                <tr key={period + kind}>
                                  <th>
                                    {period === 'development' ? 'Earlier' : 'Later'} /{' '}
                                    {kind.toLowerCase()}
                                  </th>
                                  <td>{money(a.summary.netPnl)}</td>
                                  <td className={color(b.summary.netPnl)}>
                                    {money(b.summary.netPnl)}
                                  </td>
                                  <td>
                                    {b.summary.closedTrades} / {b.summary.wins}
                                  </td>
                                </tr>
                              );
                            }),
                          )}
                        </tbody>
                      </table>
                    </div>
                  </section>
                  <section className="panel">
                    <h2>
                      {r.asset}: all {r.search.length} development candidates
                    </h2>
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Short rule tested</th>
                            <th>Net USDT</th>
                            <th>Hourly drawdown</th>
                            <th>Closed / wins</th>
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
                            .map((t, i) => (
                              <tr key={i} className={t.selected ? 'specialist-selected' : ''}>
                                <td>{describeRules(t.candidate)}</td>
                                <td className={color(t.development.summary.netPnl)}>
                                  {money(t.development.summary.netPnl)}
                                </td>
                                <td>{pct(t.development.summary.maxDrawdown)}</td>
                                <td>
                                  {t.development.summary.closedTrades} /{' '}
                                  {t.development.summary.wins}
                                </td>
                                <td>
                                  {t.selected
                                    ? 'Selected V6'
                                    : t.eligible
                                      ? 'Retained candidate'
                                      : 'Eligibility gate failed'}
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                  <section className="panel">
                    <h2>{r.asset}: why V5 shorts won or lost</h2>
                    <p>
                      Excursions use complete candles before the exit candle and are diagnostic
                      only. They do not establish an achievable stop or limit fill. Trading fees,
                      slippage and borrowing are already included in net P&amp;L.
                    </p>
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Entry UTC / hour</th>
                            <th>Net USDT</th>
                            <th>Fees / borrow / slip</th>
                            <th>Prior favorable ATR</th>
                            <th>24h MA200 fall / ATR</th>
                            <th>Distance below MA200 / ATR</th>
                            <th>Exit</th>
                          </tr>
                        </thead>
                        <tbody>
                          {r.v5ShortTrades.map((t) => (
                            <tr key={t.entryIndex}>
                              <td>
                                {stamp(t.entryAt)}
                                <small>Hour {t.entryIndex}</small>
                              </td>
                              <td className={color(t.net)}>{money(t.net)}</td>
                              <td>
                                {money(t.fees)} / {money(t.financing)} / {money(t.slippage)}
                              </td>
                              <td>{money(t.mfeBeforeExitAtr)}</td>
                              <td>{money(t.slopeAtr)}</td>
                              <td>{money(t.distanceAtr)}</td>
                              <td>{t.reason}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                  <section className="panel">
                    <h2>{r.asset}: V5 → V6 short-trade changes · fees on</h2>
                    <p>
                      Matched by entry hour. “No closed trade” records filtered opportunities,
                      including removed winners; quantities can differ through compounding. This is
                      a closed-trade comparison; any open contribution remains separate.
                    </p>
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Entry UTC / hour</th>
                            <th>V5 net USDT</th>
                            <th>V6 net USDT</th>
                            <th>Change USDT</th>
                            <th>V5 / V6 exit hour</th>
                          </tr>
                        </thead>
                        <tbody>
                          {r.tradeChanges.map((t) => (
                            <tr key={t.direction + t.entryIndex}>
                              <td>
                                {stamp(t.entryAt)}
                                <small>Hour {t.entryIndex}</small>
                              </td>
                              <td>{t.v5Net === null ? 'No closed trade' : money(t.v5Net)}</td>
                              <td>{t.v6Net === null ? 'No closed trade' : money(t.v6Net)}</td>
                              <td className={color(t.delta)}>{money(t.delta)}</td>
                              <td>
                                {t.v5Exit ?? '—'} / {t.v6Exit ?? '—'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                </div>
              ))}
            </>
          )}
          {tab === 'Trade explorer' && (
            <>
              <section className="panel">
                <div className="strategy-selectors">
                  <label>
                    Token
                    <select
                      value={asset}
                      onChange={(e) => {
                        const a = e.target.value as MarketAsset;
                        setAsset(a);
                        if (a !== 'SOL' && a !== 'XRP' && ['V4', 'V5', 'V6'].includes(strategy))
                          setStrategy('V3');
                      }}
                    >
                      {assets.map((a) => (
                        <option key={a}>{a}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Strategy
                    <select
                      value={strategy}
                      onChange={(e) => setStrategy(e.target.value as ShortV6Key)}
                    >
                      {keys
                        .filter(
                          (k) =>
                            !['V4', 'V5', 'V6'].includes(k) || asset === 'SOL' || asset === 'XRP',
                        )
                        .map((k) => (
                          <option key={k}>{k}</option>
                        ))}
                    </select>
                  </label>
                  <span>
                    {modes[mode]} · Fees {fees[strategy] ? 'on' : 'off'}
                  </span>
                </div>
              </section>
              {detailLoading ? (
                <section className="panel empty">Opening the selected replay…</section>
              ) : (
                detail &&
                detail.id === reportId && (
                  <>
                    <section className="panel">
                      <div className="panel-title">
                        <h2>
                          {asset} {strategy} · {money(detail.report.summary.netPnl)} USDT net
                        </h2>
                        <a
                          className="button"
                          href={`/api/short-v6/report-export?asset=${asset}&strategy=${strategy}&mode=${mode}`}
                        >
                          ↓ Export report
                        </a>
                      </div>
                      {directional && (
                        <div className="strategy-metrics">
                          {[
                            ['Closed long net', directional.summary.long.net],
                            ['Closed short net', directional.summary.short.net],
                            ['Borrowing costs', directional.summary.financing],
                            ['Open contribution', directional.summary.openContribution],
                            ['Reserved collateral', directional.summary.collateral],
                            ['Uncovered default debt', directional.summary.badDebt],
                          ].map(([label, v]) => (
                            <div key={label}>
                              <small>{label}</small>
                              <strong>{money(v!)} USDT</strong>
                            </div>
                          ))}
                        </div>
                      )}
                      {!directional && (
                        <p>
                          Original long-only report, unchanged. No borrowing or short positions.
                        </p>
                      )}
                      <svg
                        className="equity-chart"
                        viewBox="0 0 960 250"
                        role="img"
                        aria-label="Virtual equity over the selected history"
                      >
                        {(() => {
                          const v = detail.report.decisions.map((d) => Number(d.equity)),
                            low = Math.min(10000, ...v) - 5,
                            high = Math.max(10000, ...v) + 5,
                            y = (n: number) => 20 + ((high - n) / (high - low)) * 200;
                          return (
                            <>
                              <line
                                x1="40"
                                x2="940"
                                y1={y(10000)}
                                y2={y(10000)}
                                stroke="#a2aaa7"
                                strokeDasharray="5 5"
                              />
                              <polyline
                                fill="none"
                                stroke="#288c80"
                                strokeWidth="2"
                                points={v
                                  .map((n, i) => `${40 + (i / (v.length - 1)) * 900},${y(n)}`)
                                  .join(' ')}
                              />
                              <text x="40" y="240" className="chart-label">
                                Cash reference: 10,000 USDT · hourly marks
                              </text>
                            </>
                          );
                        })()}
                      </svg>
                    </section>
                    {decision && bar && (
                      <section className="panel">
                        <div className="panel-title">
                          <h2>One completed hour</h2>
                          <strong>{decision.action}</strong>
                        </div>
                        {detail.report.version === 'short-v6-replay.v1' &&
                          detail.report.plan.profile.strategy === 'V6' && (
                            <p>
                              <strong>
                                {describeRules(detail.report.plan.profile.shortRules)}
                              </strong>
                            </p>
                          )}
                        <p>
                          {stamp(bar.at)} → {stamp(decision.at)}
                        </p>
                        <div className="strategy-stepper">
                          <button
                            className="button"
                            disabled={hour === 0}
                            onClick={() => setHour((h) => h - 1)}
                          >
                            ← Previous
                          </button>
                          <button
                            className="button"
                            disabled={hour >= detail.bars.length - 1}
                            onClick={() => setHour((h) => h + 1)}
                          >
                            Next →
                          </button>
                          <button
                            className="button"
                            disabled={
                              !detail.report.decisions
                                .slice(hour + 1)
                                .some((d) => ['LONG', 'SHORT', 'EXIT'].includes(d.action))
                            }
                            onClick={() => {
                              const d = detail.report.decisions
                                .slice(hour + 1)
                                .find((d) => ['LONG', 'SHORT', 'EXIT'].includes(d.action));
                              if (d) setHour(d.index);
                            }}
                          >
                            Next long / short / exit
                          </button>
                          <span>
                            {hour + 1}/{detail.bars.length}
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
                        <div className="strategy-metrics">
                          {[
                            ['Price close', bar.close],
                            ['MA20', decision.fast],
                            ['MA50', decision.slow],
                            ['ATR14', decision.atr],
                            ['Stop', decision.stop],
                            ['Target', decision.target],
                            ['Position quantity', decision.position],
                            ['Available cash', decision.cash],
                            ['Equity', decision.equity],
                          ].map(([label, v]) => (
                            <div key={label}>
                              <small>{label}</small>
                              <strong>{v === null ? 'N/A' : money(v!)}</strong>
                            </div>
                          ))}
                        </div>
                        {'shortSlopeAtr' in decision && (
                          <p>
                            Short diagnostics at this close: MA200 fall / ATR{' '}
                            {decision.shortSlopeAtr === null
                              ? 'N/A'
                              : money(decision.shortSlopeAtr)}{' '}
                            · Distance below MA200 / ATR{' '}
                            {decision.shortDistanceAtr === null
                              ? 'N/A'
                              : money(decision.shortDistanceAtr)}{' '}
                            · Proposed short target {decision.shortTargetAtr} ATR. An open position
                            keeps its entry signal’s target.
                          </p>
                        )}
                        {'shortGate' in decision && (
                          <p>
                            Position: {decision.positionSide ?? 'FLAT'} · Long gate:{' '}
                            {decision.longGate} · Short gate: {decision.shortGate} · Collateral{' '}
                            {money(decision.collateral)} USDT · Borrowed {decision.loan} {asset} ·
                            Cumulative borrowing {money(decision.financing)} USDT
                          </p>
                        )}
                      </section>
                    )}
                    <section className="panel">
                      <h2>Virtual fills</h2>
                      <p>
                        SELL + SHORT opens borrowed exposure; BUY + SHORT covers it. Financing is
                        charged on short positions only, separately from trading fees.
                      </p>
                      <div className="table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th>Time UTC</th>
                              <th>Position / event</th>
                              <th>Order side</th>
                              <th>Quantity {asset}</th>
                              <th>Fill USDT</th>
                              <th>Fee / slippage</th>
                              <th>Closed net USDT</th>
                              <th>Reason</th>
                            </tr>
                          </thead>
                          <tbody>
                            {detail.report.trades.slice(page * 20, page * 20 + 20).map((t, i) => (
                              <tr key={page * 20 + i}>
                                <td>
                                  <button
                                    className="strategy-text-button"
                                    onClick={() => setHour(t.index)}
                                  >
                                    {stamp(t.at)} ↗
                                  </button>
                                </td>
                                <td>
                                  {'direction' in t &&
                                  typeof t.direction === 'string' &&
                                  'kind' in t &&
                                  typeof t.kind === 'string'
                                    ? `${t.direction} · ${t.kind}`
                                    : 'LONG'}
                                </td>
                                <td>{t.side}</td>
                                <td>{t.quantity}</td>
                                <td>{t.price}</td>
                                <td>
                                  {money(t.fee)} / {money(t.slippage)}
                                </td>
                                <td>
                                  {'net' in t && typeof t.net === 'string' ? money(t.net) : '—'}
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
                          onClick={() => setPage((p) => p - 1)}
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
                          onClick={() => setPage((p) => p + 1)}
                        >
                          Next fills
                        </button>
                        <button
                          className="button"
                          disabled={verifying}
                          onClick={() => {
                            setVerifying(true);
                            setVerified('');
                            void api(
                              '/verify',
                              z.strictObject({ verified: z.literal(true), reportId: z.string() }),
                              { asset, strategy, mode },
                            )
                              .then((r) => setVerified(`Exact replay verified: ${r.reportId}`))
                              .catch((e) =>
                                setError(e instanceof Error ? e.message : 'Verification failed.'),
                              )
                              .finally(() => setVerifying(false));
                          }}
                        >
                          {verifying ? 'Verifying…' : 'Verify exact replay'}
                        </button>
                      </div>
                      {verified && <p role="status">{verified}</p>}
                    </section>
                    <section className="panel">
                      <h2>Historical source provenance</h2>
                      <p>
                        Public spot candles; historical short availability and lending rates were
                        not captured. Current tick/lot filters are applied retrospectively. Native
                        forward data gates remain unchanged.
                      </p>
                      {detail.sources.map((s) => (
                        <p key={s.hash}>
                          <a href={s.url} target="_blank" rel="noreferrer">
                            {s.url}
                          </a>
                          <br />
                          <small>
                            Captured {s.receivedAt} · {s.hash}
                          </small>
                        </p>
                      ))}
                    </section>
                  </>
                )
              )}
            </>
          )}
          {tab === 'Rules & assumptions' && (
            <>
              <section className="panel">
                <h2>V6 changes the short side only</h2>
                {matrix.matrix.research.map((r) => (
                  <p key={r.asset}>
                    <strong>{r.asset}:</strong> {describeRules(r.selected)}
                  </p>
                ))}
                <p>
                  The V5 long-side rules, per-entry risk, allocation and costs remain fixed.
                  Selection uses only earlier short-only fees-on results. Later checks and all
                  retained candidates are in V6 research.
                </p>
              </section>
              <section className="panel">
                <h2>How a short is selected and closed</h2>
                <p>
                  V1 mirrors the MA20/MA50 crossover. V2 adds a close below a falling MA200 and the
                  reward-to-cost gate. V3 also requires a lower-half signal close and range no
                  greater than 2 ATR. Long signals keep their original rules. Shorts open at the
                  following candle’s open, never on the signal close.
                </p>
                <p>
                  For SOL V4/V5 retain SOL’s selected 2.5 ATR stop and 5 ATR base target; V5 uses 4
                  ATR when signal ATR/close ≤0.8%. For XRP V4/V5 retain the 2 ATR stop, 0.8–2 ATR
                  range and quality gates; V5 uses a 6 ATR target for signal range/ATR 1.5–1.8,
                  otherwise 3.5 ATR. Targets and stops mirror around short entry prices. These V1–V5
                  profiles were selected in prior long-only research and mirrored for shorts. V6
                  adds the separate short rules shown above, selected on earlier short-only data.
                </p>
                <p>
                  Short stops are above entry; short profit targets are below. A bullish crossover
                  closes a short. Combined mode can close and reverse at the following open,
                  charging both fills. If stop and target both cross inside one candle, the adverse
                  exit wins. Gaps execute at the worse open. No repeated entry without a fresh
                  crossover.
                </p>
              </section>
              <section className="panel">
                <h2>Collateral, borrowing and default</h2>
                <p>
                  Short entry reserves 100% of entry notional as USDT collateral and locks the sale
                  proceeds. Proceeds cannot fund another position. Debt in the borrowed token
                  remains visible. Quantity is capped by 0.25% account risk, 10% notional
                  allocation, 1% prior-candle volume and available collateral; no added leverage is
                  used.
                </p>
                <p>
                  Borrowing is a fixed research assumption: 10% annual simple interest on entry
                  notional, charged in USDT at 1/8,760 per completed holding hour. An intrabar exit
                  is conservatively charged a full exit candle; a next-open exit is not charged
                  another hour. The short cost gate budgets 24 hours of borrowing; actual holding
                  duration may differ. Switching trading fees off keeps borrowing charges enabled.
                </p>
                <p>
                  Forced margin close assumes 0.5% maintenance plus exit fee/slippage reserves.
                  Stops normally trigger sooner. A catastrophic opening gap can exceed account
                  funds: the remaining USDT debt is retained explicitly, equity can be negative, and
                  all further trading halts. Available cash is never silently made negative or
                  topped up without recorded debt.
                </p>
              </section>
              <section className="panel">
                <h2>What these results can establish</h2>
                <p>
                  All modes reuse the same six-month spot history, current instrument filters and a
                  fixed selected universe. Borrow availability, actual borrow rates, lender recalls
                  and market impact are unknown. These are hypothetical short simulations, with no
                  futures funding or exchange-specific perpetual settlement claim. No real orders or
                  exchange accounts are connected.
                </p>
                <p>
                  All history was previously seen. V6 retains all 44 short-rule candidates and does
                  not claim independent validation. More trades can increase costs and losses. Open
                  positions are marked at the final close; no forced final exit costs are
                  fabricated. Hourly drawdown can miss intrabar lows.
                </p>
                <p>
                  <Link href="/market-strategy-tests">Original all-token long-only tests</Link> ·{' '}
                  <Link href="/sol-xrp-lab">SOL &amp; XRP V4/V5 research archive</Link>
                </p>
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}
