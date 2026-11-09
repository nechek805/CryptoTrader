'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  NewsResearchStatus,
  NewsResearchReport,
  NewsResearchRun,
  NEWS_RESEARCH_ASSETS,
} from '../../../../packages/contracts/src/news-research';
import type { ResearchReport } from '../../../../packages/contracts/src/news-research';
import type { z } from 'zod';
import {
  NewsV3Status,
  NewsV3Run,
  NewsV3Report,
} from '../../../../packages/contracts/src/news-research-v3';
import type { V3Report } from '../../../../packages/contracts/src/news-research-v3';
import V3Panels from './v3-panels';
import V4Workspace from './v4-workspace';
import './workspace.css';

const at = (n: number | null) =>
  n === null ? 'Unknown' : new Date(n).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
const cash = (n: string | number) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (n: number) => (100 * n).toFixed(2) + '%';
async function api<T>(path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
  const response = await fetch('/api/news/research' + path, {
    credentials: 'same-origin',
    cache: 'no-store',
    signal: AbortSignal.timeout(30000),
    ...(body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
  if (!response.ok)
    throw new Error(
      response.status === 401
        ? 'Sign in to the dashboard.'
        : response.status === 403
          ? 'Operator access is required.'
          : 'Research service unavailable or request rejected.',
    );
  return schema.parse(await response.json());
}
export default function NewsStrategyTests({ role }: { role: 'READ' | 'ADMIN' }) {
  const [study, setStudy] = useState('v6');
  return (
    <>
      <div className="news-history-toolbar panel">
        <button className="button" aria-pressed={study === 'v6'} onClick={() => setStudy('v6')}>
          V1-V6 / single-factor V2 tests
        </button>
        <button className="button" aria-pressed={study === 'v5'} onClick={() => setStudy('v5')}>
          V1–V5 · same history · fees on
        </button>
        <button className="button" aria-pressed={study === 'v4'} onClick={() => setStudy('v4')}>
          V1–V4 · 36-month study
        </button>
        <button
          className="button"
          aria-pressed={study === 'original'}
          onClick={() => setStudy('original')}
        >
          Original V1–V3 · six months
        </button>
      </div>
      {study !== 'original' ? (
        <V4Workspace
          key={study}
          role={role}
          generation={study === 'v6' ? 'v6' : study === 'v5' ? 'v5' : 'v4'}
        />
      ) : (
        <OriginalNewsStrategyTests role={role} />
      )}
    </>
  );
}
function OriginalNewsStrategyTests({ role }: { role: 'READ' | 'ADMIN' }) {
  const [status, setStatus] = useState<z.infer<typeof NewsResearchStatus> | null>(null),
    [report, setReport] = useState<ResearchReport | V3Report | null>(null);
  const [v3Status, setV3Status] = useState<z.infer<typeof NewsV3Status> | null>(null);
  const [runId, setRunId] = useState(''),
    [asset, setAsset] = useState<string>('BTC'),
    [version, setVersion] = useState('LEARNED_V3');
  const [phase, setPhase] = useState('TEST'),
    [side, setSide] = useState('ALL'),
    [outcome, setOutcome] = useState('ALL'),
    [source, setSource] = useState('ALL');
  const [sort, setSort] = useState('date'),
    [page, setPage] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      const [s, v3] = await Promise.all([
        api('/status', NewsResearchStatus),
        api('/v3/status', NewsV3Status),
      ]);
      setStatus(s);
      setV3Status(v3);
      setRunId((old) => old || v3.runs[0]?.id || s.runs[0]?.id || '');
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      void load();
    }, 5000);
    return () => clearInterval(timer);
  }, [load]);
  const runs = [
    ...(v3Status?.runs ?? []).map((r) => ({ ...r, kind: 'v3' as const })),
    ...(status?.runs ?? []).map((r) => ({ ...r, kind: 'legacy' as const })),
  ];
  const run = runs.find((r) => r.id === runId);
  const isV3 = run?.kind === 'v3';
  const v3Report = report?.version === 'news-history-comparison.v3' ? report : null;
  useEffect(() => {
    let alive = true;
    setReport(null);
    if (runId && run?.state === 'COMPLETE')
      void (
        isV3
          ? api('/v3/reports/' + runId, NewsV3Report)
          : api('/reports/' + runId, NewsResearchReport)
      )
        .then((r) => {
          if (alive) setReport(r);
        })
        .catch((e) => {
          if (alive) setError((e as Error).message);
        });
    return () => {
      alive = false;
    };
  }, [runId, run?.state, isV3]);
  useEffect(() => {
    if (report?.version === 'news-history-report.v1' && version === 'LEARNED_V3')
      setVersion('LEARNED_V2');
  }, [report, version]);
  useEffect(() => {
    setPage(0);
  }, [asset, version, phase, side, outcome, source, sort]);
  const eventMap = useMemo(() => new Map(report?.events.map((e) => [e.id, e]) ?? []), [report]);
  const row = report?.rows.find((r) => r.asset === asset),
    model = row?.models.find((m) => m.version === version),
    evaluation = model?.evaluations.find((e) => e.phase === phase);
  const trades = useMemo(
    () =>
      (evaluation?.trades ?? [])
        .filter(
          (t) =>
            (side === 'ALL' || t.side === side) &&
            (outcome === 'ALL' || t.status === outcome) &&
            (source === 'ALL' || eventMap.get(t.eventId)?.sourceId === source),
        )
        .sort((a, b) =>
          sort === 'pnl' ? Number(b.netPnl) - Number(a.netPnl) : b.entryAt - a.entryAt,
        ),
    [evaluation, side, outcome, source, sort, eventMap],
  );
  async function start() {
    setBusy(true);
    setError('');
    try {
      const r = await api('/run', NewsResearchRun, {});
      setRunId(r.id);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function startV3() {
    setBusy(true);
    setError('');
    try {
      const baselineRunId =
        run?.kind === 'v3' ? run.baselineRunId : run?.state === 'COMPLETE' ? run.id : undefined;
      const r = await api('/v3/run', NewsV3Run, baselineRunId ? { baselineRunId } : {});
      setRunId(r.id);
      setVersion('LEARNED_V3');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const active = runs.some((r) => ['QUEUED', 'RUNNING'].includes(r.state));
  return (
    <div className="news-history">
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      <div className="context-bar">
        <span className="context-dot" />
        <strong>Real historical data · virtual positions</strong>
        <span>10 tokens + USDT cash · hourly candles · fees on</span>
      </div>
      <div className="panel news-history-warning">
        <strong>Exploratory history — not qualified for live trading</strong>
        <p>
          Old feed articles were collected recently. Publication times are assumptions for this
          study, not proof that our system could trade that information historically. Undated
          articles are excluded. No archive is backdated into a tradable training dataset.
        </p>
      </div>
      <div className="news-history-toolbar">
        <div>
          <strong>
            {status?.workerHealthy
              ? 'Research worker ready'
              : 'Research worker waiting / unavailable'}
          </strong>
          <small>Frozen V1/V2 plus structured V3; losing and cash-only results stay visible.</small>
        </div>
        {role === 'ADMIN' && (
          <button
            className="button primary"
            disabled={busy || active || !status?.workerHealthy}
            onClick={() => {
              void start();
            }}
          >
            {active
              ? 'Research running…'
              : status?.runs.length
                ? 'Open frozen study'
                : 'Run six-month news study'}
          </button>
        )}
        {role === 'ADMIN' && (
          <button
            className="button primary"
            disabled={
              busy ||
              active ||
              !v3Status?.workerHealthy ||
              !status?.runs.some((r) => r.state === 'COMPLETE')
            }
            onClick={() => {
              void startV3();
            }}
          >
            Run / open V3 comparison
          </button>
        )}
        <select
          aria-label="Research version"
          value={runId}
          onChange={(e) => setRunId(e.target.value)}
        >
          <option value="">Research versions</option>
          {runs.map((r) => (
            <option key={r.id} value={r.id}>
              {at(r.createdAt)} · {r.state}
            </option>
          ))}
        </select>
      </div>
      {run && (
        <div className="panel">
          <strong>
            {run.state}: {run.stage}
          </strong>
          <p>
            Frozen window: {at(run.plan.from)} → {at(run.plan.to)}
          </p>
          {run.error && <p role="alert">{run.error}</p>}
        </div>
      )}
      {!report ? (
        <div className="panel empty">
          {active
            ? 'Collecting market history and testing the frozen protocol. You can leave this page and return.'
            : 'Run the study to inspect source coverage, news reactions and hypothetical trades.'}
        </div>
      ) : (
        <>
          <div className="news-history-metrics">
            <div className="panel">
              <span>Available archive records</span>
              <strong>{report.coverage.collected}</strong>
              <small>{report.coverage.datedInWindow} permitted and dated in this window</small>
            </div>
            <div className="panel">
              <span>First collected by our system</span>
              <strong>{at(report.coverage.earliestFirstSeen)}</strong>
              <small>{report.coverage.undated} permitted records have no usable date</small>
            </div>
            <div className="panel">
              <span>Historically timely records</span>
              <strong>{report.coverage.eligibleHistoricalVersions}</strong>
              <small>Required for a tradable historical fit</small>
            </div>
            <div className="panel">
              <span>Research target</span>
              <strong>+100 / 10,000 USDT</strong>
              <small>Per token, final split; profit is not guaranteed</small>
            </div>
          </div>
          {v3Report && <V3Panels report={v3Report} asset={asset} onAssetChange={setAsset} />}
          <section className="panel">
            <div className="news-history-toolbar">
              <h2>
                {v3Report ? 'Frozen V1/V2 reference' : 'All-token comparison'} · final two months
              </h2>
              <div>
                {(['json', 'csv', 'md'] as const).map((f) => (
                  <a
                    key={f}
                    className="button"
                    href={`/api/news/research${isV3 ? '/v3' : ''}/export/${runId}/${f}`}
                  >
                    Export whole report · {f.toUpperCase()}
                  </a>
                ))}
              </div>
            </div>
            <p>
              Learn: {at(report.plan.from)} → {at(report.plan.trainEnd)}. Select on validation:{' '}
              {at(report.plan.trainEnd)} → {at(report.plan.validationEnd)}. Final evaluation:{' '}
              {at(report.plan.validationEnd)} → {at(report.plan.to)}.
            </p>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Token</th>
                    <th>Aligned news</th>
                    <th>Fixed rules V1 P&L</th>
                    <th>Learned V2 P&L</th>
                    <th>V2 trades / wins</th>
                    <th>V2 drawdown</th>
                    <th>Live qualification</th>
                  </tr>
                </thead>
                <tbody>
                  {report.rows.map((r) => {
                    const a = r.models.find((m) => m.version === 'RULES_V1')?.evaluations[2],
                      b = r.models.find((m) => m.version === 'LEARNED_V2')?.evaluations[2];
                    return (
                      <tr
                        key={r.asset}
                        className={asset === r.asset ? 'news-history-selected' : ''}
                      >
                        <td>
                          <button className="button" onClick={() => setAsset(r.asset)}>
                            {r.asset}
                          </button>
                        </td>
                        <td>{r.eventCount}</td>
                        <td>
                          {a
                            ? cash(a.netPnl)
                            : r.status === 'CASH_CONTROL'
                              ? '0.00'
                              : 'Unavailable'}
                        </td>
                        <td>
                          {b
                            ? cash(b.netPnl)
                            : r.status === 'CASH_CONTROL'
                              ? '0.00'
                              : 'Unavailable'}
                        </td>
                        <td>{b ? `${b.trades.length} / ${b.wins}` : '—'}</td>
                        <td>{b ? pct(b.maxDrawdown) : '—'}</td>
                        <td>
                          {r.status === 'CASH_CONTROL'
                            ? 'Cash baseline'
                            : 'Blocked: historical evidence'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p>
              Each cell starts with its own 10,000 USDT. The ten accounts are separate. V2 chooses
              cash when validation does not support a positive model. USDT has no USDT/USDT trade.
            </p>
          </section>
          <section className="panel">
            <div className="news-history-toolbar">
              <h2>Inspect a strategy</h2>
              <select aria-label="Token" value={asset} onChange={(e) => setAsset(e.target.value)}>
                {NEWS_RESEARCH_ASSETS.map((a) => (
                  <option key={a}>{a}</option>
                ))}
              </select>
              <select
                aria-label="News strategy"
                value={version}
                onChange={(e) => setVersion(e.target.value)}
              >
                <option value="RULES_V1">V1 · fixed news rules</option>
                <option value="LEARNED_V2">V2 · learned event reactions</option>
              </select>
            </div>
            <p>
              {version === 'LEARNED_V3'
                ? 'V3 distinguishes routine posts, proposals, testnet announcements, activations and delays. Macro signals require verified pre-release expectations. It uses 12/20 examples, uncertainty and cost margins, a 72-hour purge and five validation trades. Cash means abstention.'
                : version === 'RULES_V1'
                  ? 'V1 uses predefined headline rules: adverse security/incidents imply SHORT, protocol/adoption announcements imply LONG, ambiguous/negated news implies HOLD. A 24-hour horizon is fixed before the test.'
                  : 'V2 estimates directions separately for each token and event group using training-era reactions versus matched control periods. It searches 36 horizon/sample/edge configurations on validation only. Final prices cannot select the model.'}
            </p>
            {model ? (
              <>
                <p>
                  <strong>Selected:</strong> {model.config.id} · {model.config.horizonHours}h
                  holding limit · {model.config.minSamples} minimum examples · {model.trials}{' '}
                  declared trials.
                </p>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Split</th>
                        <th>Ending USDT</th>
                        <th>Net P&L</th>
                        <th>Trades / wins</th>
                        <th>Fees</th>
                        <th>Financing</th>
                        <th>Drawdown</th>
                      </tr>
                    </thead>
                    <tbody>
                      {model.evaluations.map((e) => (
                        <tr key={e.phase}>
                          <td>{e.phase}</td>
                          <td>{cash(e.endingUsdt)}</td>
                          <td>{cash(e.netPnl)}</td>
                          <td>
                            {e.trades.length} / {e.wins}
                          </td>
                          <td>{cash(e.fees)}</td>
                          <td>{cash(e.financing)}</td>
                          <td>{pct(e.maxDrawdown)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p>
                  Final sensitivity: double costs{' '}
                  <strong>{cash(model.doubleCostTestPnl)} USDT</strong>; one-hour extra news delay{' '}
                  <strong>{cash(model.delayedTestPnl)} USDT</strong>.
                </p>
                <p>
                  <strong>Why it cannot qualify:</strong> {model.rejectionReasons.join(' ')}
                </p>
                <details>
                  <summary>Learned rules and all development candidates</summary>
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>News group</th>
                          <th>Training examples</th>
                          <th>Mean excess return</th>
                          <th>Standard error</th>
                          <th>Opinion</th>
                        </tr>
                      </thead>
                      <tbody>
                        {model.rules.map((r) => (
                          <tr key={r.group}>
                            <td>{r.group}</td>
                            <td>{r.count}</td>
                            <td>{pct(r.meanExcessReturn)}</td>
                            <td>{pct(r.standardError)}</td>
                            <td>{r.side}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Candidate</th>
                          <th>Validation P&L</th>
                          <th>Trades</th>
                          <th>Selection score</th>
                        </tr>
                      </thead>
                      <tbody>
                        {model.candidates.map((c) => (
                          <tr key={c.config.id}>
                            <td>{c.config.id}</td>
                            <td>{cash(c.validationPnl)}</td>
                            <td>{c.validationTrades}</td>
                            <td>{c.score <= -1e9 ? 'Insufficient trades' : cash(c.score)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              </>
            ) : (
              <p>
                {asset === 'USDT'
                  ? 'USDT remains the 10,000 USDT cash control.'
                  : (row?.error ?? 'No model available.')}
              </p>
            )}
          </section>
          <section className="panel">
            <h2>{asset} · which news was followed by a move?</h2>
            <p>
              Descriptive associations across all six months. Positive excess means a larger move
              than matched control periods. These tables include the final period for explanation;
              the learner receives training-period rows only.
            </p>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>News group</th>
                    <th>Horizon</th>
                    <th>Independent samples</th>
                    <th>Moved up</th>
                    <th>Mean return</th>
                    <th>Excess vs controls</th>
                    <th>95% interval (approx.)</th>
                    <th>Example</th>
                  </tr>
                </thead>
                <tbody>
                  {row?.effects.map((e) => (
                    <tr key={e.group + e.horizonHours}>
                      <td>{e.group}</td>
                      <td>{e.horizonHours}h</td>
                      <td>{e.count}</td>
                      <td>{pct(e.upFraction)}</td>
                      <td>{pct(e.meanReturn)}</td>
                      <td>{pct(e.meanExcessReturn)}</td>
                      <td>
                        {e.count > 1
                          ? `${pct(e.meanExcessReturn - 1.96 * e.standardError)} to ${pct(e.meanExcessReturn + 1.96 * e.standardError)}`
                          : 'Insufficient examples'}
                      </td>
                      <td>
                        {eventMap.get(e.examples[0]!) && (
                          <a
                            href={eventMap.get(e.examples[0]!)!.url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Publisher ↗
                          </a>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!row?.effects.length && (
              <p>
                No adequately aligned event/control samples for this token. Missing evidence stays
                missing.
              </p>
            )}
          </section>
          <section className="panel">
            <h2>Hypothetical long / short positions</h2>
            <div className="news-history-toolbar">
              <select aria-label="Split" value={phase} onChange={(e) => setPhase(e.target.value)}>
                {['TRAIN', 'VALIDATION', 'TEST'].map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
              <select
                aria-label="Position direction"
                value={side}
                onChange={(e) => setSide(e.target.value)}
              >
                {['ALL', 'LONG', 'SHORT'].map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
              <select
                aria-label="Position outcome"
                value={outcome}
                onChange={(e) => setOutcome(e.target.value)}
              >
                {['ALL', 'WIN', 'LOSS', 'FLAT'].map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
              <select
                aria-label="News publisher"
                value={source}
                onChange={(e) => setSource(e.target.value)}
              >
                <option value="ALL">All publishers</option>
                {report.coverage.bySource
                  .filter((s) => s.datedInWindow)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </select>
              <select
                aria-label="Sort positions"
                value={sort}
                onChange={(e) => setSort(e.target.value)}
              >
                <option value="date">Newest entry first</option>
                <option value="pnl">Highest profit first</option>
              </select>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Entry / exit</th>
                    <th>Position</th>
                    <th>Entry / exit price</th>
                    <th>Quantity</th>
                    <th>Stop / target</th>
                    <th>Net P&L</th>
                    <th>Exit</th>
                    <th>News evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.slice(page * 25, (page + 1) * 25).map((t) => {
                    const e = eventMap.get(t.eventId);
                    return (
                      <tr key={t.eventId + t.entryAt}>
                        <td>
                          {at(t.entryAt)}
                          <small>{at(t.exitAt)}</small>
                        </td>
                        <td>
                          {t.side}
                          <small>{t.status}</small>
                        </td>
                        <td>
                          {cash(t.entryPrice)}
                          <small>{cash(t.exitPrice)}</small>
                        </td>
                        <td>{t.quantity}</td>
                        <td>
                          {cash(t.stop)}
                          <small>{cash(t.target)}</small>
                        </td>
                        <td>
                          {cash(t.netPnl)}
                          <small>
                            Fees {cash(t.fees)} · borrow {cash(t.financing)}
                          </small>
                        </td>
                        <td>{t.reason}</td>
                        <td>
                          {e && (
                            <>
                              <a href={e.url} target="_blank" rel="noreferrer">
                                {e.title}
                              </a>
                              <small>
                                {e.publisher} · {e.scope}
                              </small>
                              <small>Published {at(e.publishedAt)}</small>
                              <small>Actually available to us {at(e.availableAt)}</small>
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!trades.length && (
              <p>
                No matching trades.{' '}
                {Object.entries(evaluation?.skipped ?? {})
                  .map(([k, n]) => `${k.replaceAll('_', ' ')}: ${n}`)
                  .join(' · ')}
              </p>
            )}
            <div className="news-history-toolbar">
              <button className="button" disabled={!page} onClick={() => setPage((p) => p - 1)}>
                Previous
              </button>
              <span>
                {trades.length} matching positions · page {page + 1}
              </span>
              <button
                className="button"
                disabled={(page + 1) * 25 >= trades.length}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </button>
            </div>
          </section>
          <details className="panel">
            <summary>Coverage, frozen hashes and limitations</summary>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Source</th>
                    <th>Collected</th>
                    <th>Permitted / dated in window</th>
                    <th>Historically timely</th>
                  </tr>
                </thead>
                <tbody>
                  {report.coverage.bySource
                    .filter((s) => s.total)
                    .map((s) => (
                      <tr key={s.id}>
                        <td>{s.name}</td>
                        <td>{s.total}</td>
                        <td>{s.datedInWindow}</td>
                        <td>{s.eligible}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            <p>
              Unknown publication dates: {report.coverage.undated}. Permission exclusions:{' '}
              {report.coverage.permissionExcluded}. Irrelevant: {report.coverage.irrelevant}.
              Duplicate issuer/category updates: {report.coverage.deduplicated}.
            </p>
            <ul>
              {report.limitations.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
            <p className="news-history-hash">
              Engine {report.engineHash}
              <br />
              Snapshot {report.snapshotHash}
              <br />
              Protocol {report.planHash}
            </p>
          </details>
        </>
      )}
    </div>
  );
}
