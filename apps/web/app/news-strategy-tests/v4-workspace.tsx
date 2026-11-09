'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { z } from 'zod';
import { NewsV5Report } from '../../../../packages/contracts/src/news-research-v5';
import type { V5Report } from '../../../../packages/contracts/src/news-research-v5';
import V5Panels from './v5-panels';
import { NewsV6Report } from '../../../../packages/contracts/src/news-research-v6';
import type { V6Report } from '../../../../packages/contracts/src/news-research-v6';
import V6Panels from './v6-panels';
import Link from 'next/link';
import {
  NewsV4Status,
  NewsV4Report,
  NewsV4Run,
} from '../../../../packages/contracts/src/news-research-v4';
import type { V4Report } from '../../../../packages/contracts/src/news-research-v4';
import { NEWS_RESEARCH_ASSETS } from '../../../../packages/contracts/src/news-research';
const money = (n: string | number) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const date = (n: number | null) =>
  n === null ? 'Unknown' : new Date(n).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
const percent = (n: number) => `${(n * 100).toFixed(2)}%`;
async function api<T>(path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
  const r = await fetch('/api/news/research' + path, {
    cache: 'no-store',
    credentials: 'same-origin',
    signal: AbortSignal.timeout(90000),
    ...(body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
  if (!r.ok)
    throw new Error(
      r.status === 409
        ? 'A completed parent study is required, the frozen parent conflicts, or the daily research budget was reached.'
        : r.status === 401
          ? 'Sign in to the dashboard.'
          : r.status === 403
            ? 'Operator access is required.'
            : 'The research service is unavailable.',
    );
  return schema.parse(await r.json());
}
export default function V4Workspace({
  role,
  generation = 'v4',
}: {
  role: 'READ' | 'ADMIN';
  generation?: 'v4' | 'v5' | 'v6';
}) {
  const current = generation.toUpperCase();
  const [status, setStatus] = useState<z.infer<typeof NewsV4Status> | null>(null),
    [runId, setRunId] = useState(''),
    [report, setReport] = useState<V4Report | V5Report | V6Report | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [asset, setAsset] = useState<string>('BTC'),
    [version, setVersion] = useState('LEARNED_' + current),
    [phase, setPhase] = useState('TEST'),
    [direction, setDirection] = useState('ALL'),
    [outcome, setOutcome] = useState('ALL'),
    [source, setSource] = useState('ALL'),
    [sort, setSort] = useState('date'),
    [page, setPage] = useState(0),
    [eventPage, setEventPage] = useState(0),
    [eventGate, setEventGate] = useState('ALL'),
    [caseId, setCaseId] = useState('SELECTED');
  const load = useCallback(async () => {
    try {
      const next = await api('/' + generation + '/status', NewsV4Status);
      setStatus(next);
      setRunId((old) => old || next.runs[0]?.id || '');
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, [generation]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      void load();
    }, 5000);
    return () => clearInterval(timer);
  }, [load]);
  const run = status?.runs.find((r) => r.id === runId),
    active = status?.runs.some((r) => ['QUEUED', 'RUNNING'].includes(r.state));
  useEffect(() => {
    let live = true;
    setReport(null);
    if (runId && run?.state === 'COMPLETE')
      void api(
        '/' + generation + '/reports/' + runId,
        z.discriminatedUnion('version', [NewsV4Report, NewsV5Report, NewsV6Report]),
      )
        .then((r) => {
          if (live) setReport(r);
        })
        .catch((e) => {
          if (live) setError((e as Error).message);
        });
    return () => {
      live = false;
    };
  }, [runId, run?.state, generation]);
  useEffect(() => {
    setPage(0);
  }, [asset, version, phase, direction, outcome, source, sort, caseId]);
  useEffect(() => {
    setEventPage(0);
  }, [asset, eventGate]);
  const eventsById = useMemo(
    () =>
      new Map(
        [
          ...(report?.legacyEvents ?? []),
          ...(report?.events ?? []),
          ...(report && 'replayEventsV5' in report ? report.replayEventsV5 : []),
          ...(report && 'replayEventsV6' in report ? report.replayEventsV6 : []),
        ].map((e) => [e.id, e]),
      ),
    [report],
  );
  const row = report?.rows.find((r) => r.asset === asset),
    selectedModel = row?.models.find((m) => m.version === version),
    model =
      selectedModel?.version === 'LEARNED_V6' && caseId !== 'SELECTED'
        ? selectedModel.ablations.find((a) => a.id === caseId)?.model
        : selectedModel,
    evaluation = model?.evaluations.find((e) => e.phase === phase);
  const trades = useMemo(
    () =>
      (evaluation?.trades ?? [])
        .filter(
          (t) =>
            (direction === 'ALL' || t.side === direction) &&
            (outcome === 'ALL' || t.status === outcome) &&
            (source === 'ALL' || eventsById.get(t.eventId)?.sourceId === source),
        )
        .sort((a, b) =>
          sort === 'pnl' ? Number(b.netPnl) - Number(a.netPnl) : b.entryAt - a.entryAt,
        ),
    [evaluation, direction, outcome, source, sort, eventsById],
  );
  const events = useMemo(
    () =>
      (report?.events ?? []).filter(
        (e) => e.assets.some((a) => a === asset) && (eventGate === 'ALL' || e.gate === eventGate),
      ),
    [report, asset, eventGate],
  );
  async function start() {
    setBusy(true);
    setError('');
    try {
      const r = await api('/' + generation + '/run', NewsV4Run, {});
      setRunId(r.id);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const versions = [
    'RULES_V1',
    'LEARNED_V2',
    'LEARNED_V3',
    'LEARNED_V4',
    ...(generation !== 'v4' ? ['LEARNED_V5'] : []),
    ...(generation === 'v6' ? ['LEARNED_V6'] : []),
  ];
  return (
    <div className="news-history">
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      <div className="context-bar">
        <span className="context-dot" />
        <strong>{current} · frozen public history · fees on</strong>
        <span>10 tokens + USDT cash · 36 months · hourly simulated positions</span>
      </div>
      <section className="panel">
        <h2>Common news history · compare V1–{current}</h2>
        <p>
          24 months training · six months validation · six months final evaluation. Every
          token/version/split starts with its own 10,000 virtual USDT. All versions use the same
          corpus and prices; each new version preserves its parent results. Original six-month
          reports remain in the other tab.
        </p>
        <p>
          Historical content and first-availability remain unverified. These results are descriptive
          research; a positive P&amp;L does not enable live trading.
        </p>
        <div className="news-history-toolbar">
          <select
            aria-label="36-month study run"
            value={runId}
            onChange={(e) => setRunId(e.target.value)}
          >
            <option value="">No {current} study yet</option>
            {status?.runs.map((r) => (
              <option key={r.id} value={r.id}>
                {date(r.createdAt)} · {r.state}
              </option>
            ))}
          </select>
          {role === 'ADMIN' && (
            <button
              className="button primary"
              disabled={busy || active}
              onClick={() => void start()}
            >
              {busy ? 'Queuing…' : `Run / open ${current} comparison`}
            </button>
          )}
          <Link className="button" href="/news-engine">
            News and source management
          </Link>
        </div>
        <p>
          Research worker: {status?.workerHealthy ? 'healthy' : 'waiting / unavailable'} ·{' '}
          {run?.state ?? 'Not started'} ·{' '}
          {run?.stage ?? 'Start the bounded study to collect free archives and verify prices.'}
        </p>
        {run?.error && <p role="alert">{run.error}</p>}
        {report && (
          <>
            <p>
              {date(report.plan.from)} → {date(report.plan.to)} · final evaluation{' '}
              {date(report.plan.validationEnd)} → {date(report.plan.to)}
            </p>
            <div className="news-history-toolbar">
              {['json', 'csv', 'md'].map((f) => (
                <a
                  key={f}
                  className="button"
                  href={`/api/news/research/${generation}/export/${runId}/${f}`}
                >
                  Export whole study · {f.toUpperCase()}
                </a>
              ))}
            </div>
          </>
        )}
      </section>
      {report && (
        <>
          <section className="panel">
            <h2>Common-history results · net USDT after fees</h2>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Token</th>
                    {versions.map((v) => (
                      <th key={v}>
                        {v.replace('RULES_', '').replace('LEARNED_', '')} final P&amp;L
                      </th>
                    ))}
                    <th>{current} trades / wins</th>
                    <th>{current} fees</th>
                    <th>{current} drawdown</th>
                  </tr>
                </thead>
                <tbody>
                  {report.rows.map((r) => {
                    const v4 = r.models.find((m) => m.version === 'LEARNED_' + current)
                      ?.evaluations[2];
                    return (
                      <tr
                        key={r.asset}
                        className={r.asset === asset ? 'news-history-selected' : ''}
                      >
                        <td>
                          <button className="button" onClick={() => setAsset(r.asset)}>
                            {r.asset}
                          </button>
                        </td>
                        {versions.map((v) => (
                          <td key={v}>
                            {money(
                              r.models.find((m) => m.version === v)?.evaluations[2]?.netPnl ?? 0,
                            )}
                          </td>
                        ))}
                        <td>{v4 ? `${v4.trades.length} / ${v4.wins}` : 'Cash'}</td>
                        <td>{money(v4?.fees ?? 0)}</td>
                        <td>{v4 ? percent(v4.maxDrawdown) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p>
              Zero trades means HOLD. The +100 USDT research target is not guaranteed. Token
              accounts are separate and must not be added into a single 10,000-USDT portfolio.
            </p>
          </section>
          {report.version === 'news-history-comparison.v5' && (
            <V5Panels report={report} asset={asset} />
          )}
          {report.version === 'news-history-comparison.v6' && (
            <V6Panels
              report={report}
              asset={asset}
              onCase={(id) => {
                setVersion('LEARNED_V6');
                setCaseId(id);
              }}
            />
          )}
          <section className="panel">
            <h2>Actual source coverage</h2>
            <p>
              The requested window is three years; each provider’s available history can be shorter.
              Scanned counts precede token/time filters. Bybit retention is limited to this study’s
              ten-token universe. GDELT is discovery-only and never supplies trade labels.
            </p>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Source</th>
                    <th>Status</th>
                    <th>Requests / scanned</th>
                    <th>Retained / dated</th>
                    <th>Earliest / latest</th>
                    <th>Limits and errors</th>
                  </tr>
                </thead>
                <tbody>
                  {report.coverage.map((c) => (
                    <tr key={c.sourceId}>
                      <td>{c.sourceId}</td>
                      <td>{c.status}</td>
                      <td>
                        {c.attempts} / {c.scanned}
                      </td>
                      <td>
                        {c.records} / {c.dated}
                      </td>
                      <td>
                        {date(c.earliest)}
                        <small>{date(c.latest)}</small>
                      </td>
                      <td>{c.notes.join(' ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p>
              Prices:{' '}
              {report.markets
                .map((m) => `${m.asset} ${m.bars.toLocaleString('en-US')} hourly bars`)
                .join(' · ')}
              .
            </p>
          </section>
          <section className="panel">
            <h2>What V4 changes</h2>
            <p>
              V4 learns a separate reaction relationship for each token and event type. It combines
              opposite feature signs within an event type, without counting ten token responses as
              ten independent news releases.
            </p>
            <p>
              Macro features compare an actual release with the median of the previous three
              original releases. This is a lagged-release deviation, not market consensus. The sign
              alone never dictates a trade: training evidence and validation must support the
              reaction after costs.
            </p>
            <p>
              Routine posts, rumors, resolutions, planned protocol changes, duplicate reports and
              unknown publication times remain HOLD. Official listing/delisting announcements and
              validated activations are distinguished from the later operational event. The model
              still needs 12/20 training observations, a 95% approximate uncertainty margin, twice
              estimated costs and five validation trades.
            </p>
            <p>
              Each fill charges 0.1%; adverse slippage is 0.05%. Exposure is capped at 20%, stop
              2.5%, target 5%. Shorts keep the baseline assumed borrowing cost; actual borrow
              availability is unknown.
            </p>
          </section>
          <section className="panel">
            <h2>{asset} · model evidence and trades</h2>
            <div className="news-history-toolbar">
              <select
                aria-label="Study token"
                value={asset}
                onChange={(e) => setAsset(e.target.value)}
              >
                {NEWS_RESEARCH_ASSETS.map((a) => (
                  <option key={a}>{a}</option>
                ))}
              </select>
              <select
                aria-label="Strategy version"
                value={version}
                onChange={(e) => setVersion(e.target.value)}
              >
                {versions.map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
              <select
                aria-label="Evaluation split"
                value={phase}
                onChange={(e) => setPhase(e.target.value)}
              >
                {['TRAIN', 'VALIDATION', 'TEST'].map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
              {selectedModel?.version === 'LEARNED_V6' && (
                <select
                  aria-label="V6 isolated case"
                  value={caseId}
                  onChange={(e) => setCaseId(e.target.value)}
                >
                  <option value="SELECTED">Validation-selected V6</option>
                  {selectedModel.ablations.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.id}
                    </option>
                  ))}
                </select>
              )}
              <select
                aria-label="Trade direction"
                value={direction}
                onChange={(e) => setDirection(e.target.value)}
              >
                {['ALL', 'LONG', 'SHORT'].map((d) => (
                  <option key={d}>{d}</option>
                ))}
              </select>
              <select
                aria-label="Trade outcome"
                value={outcome}
                onChange={(e) => setOutcome(e.target.value)}
              >
                {['ALL', 'WIN', 'LOSS', 'FLAT'].map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
              <select
                aria-label="Trade source"
                value={source}
                onChange={(e) => setSource(e.target.value)}
              >
                <option value="ALL">All sources</option>
                {[...new Set([...eventsById.values()].map((e) => e.sourceId))].sort().map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
              <select
                aria-label="Trade sorting"
                value={sort}
                onChange={(e) => setSort(e.target.value)}
              >
                <option value="date">Newest first</option>
                <option value="pnl">Highest P&amp;L first</option>
              </select>
            </div>
            <p>
              Policy: {model?.config.id ?? 'USDT cash control'} · {evaluation?.trades.length ?? 0}{' '}
              total trades · net {money(evaluation?.netPnl ?? 0)} USDT · commission{' '}
              {money(evaluation?.fees ?? 0)} · financing {money(evaluation?.financing ?? 0)}.
            </p>
            {model && (
              <p>
                Holding limit {model.config.horizonHours}h · minimum training samples{' '}
                {model.config.minSamples} · cost margin ×{model.config.edgeBuffer} · uncertainty
                multiplier {model.config.uncertaintyZ}.
              </p>
            )}
            <p>
              Eligible V4 events: {row?.v4Coverage.eligible ?? 0} · historically timely:{' '}
              {row?.v4Coverage.historicallyTimely ?? 0}.
            </p>
            {model && (
              <details>
                <summary>Rules, candidates and rejection reasons</summary>
                <p>{model.rejectionReasons.join(' ')}</p>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Event feature</th>
                        <th>Training samples</th>
                        <th>Learned opinion</th>
                        <th>Mean controlled reaction</th>
                      </tr>
                    </thead>
                    <tbody>
                      {model.rules.map((r) => (
                        <tr key={r.group}>
                          <td>{r.group}</td>
                          <td>{r.count}</td>
                          <td>{r.side}</td>
                          <td>{percent(r.meanExcessReturn)}</td>
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
                        <th>Validation P&amp;L</th>
                        <th>Trades</th>
                        <th>Selection score</th>
                      </tr>
                    </thead>
                    <tbody>
                      {model.candidates.map((c) => (
                        <tr key={c.config.id}>
                          <td>{c.config.id}</td>
                          <td>{money(c.validationPnl)}</td>
                          <td>{c.validationTrades}</td>
                          <td>{c.score <= -1e9 ? 'Insufficient trades' : money(c.score)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {'fitEvidence' in model && (
                  <>
                    <p>
                      {Object.entries(model.holdReasons)
                        .map(([k, v]) => `${k}: ${v}`)
                        .join(' · ')}
                    </p>
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>Group</th>
                            <th>Samples / minimum</th>
                            <th>Lower estimated edge</th>
                            <th>Required cost margin</th>
                          </tr>
                        </thead>
                        <tbody>
                          {model.fitEvidence.map((f) => (
                            <tr key={f.group}>
                              <td>{f.group}</td>
                              <td>
                                {f.count} / {f.minimum}
                              </td>
                              <td>{percent(f.lowerEdge)}</td>
                              <td>{percent(f.requiredEdge)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <h3>Walk-forward diagnostics · separate accounts</h3>
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>Training ends</th>
                            <th>Validation ends</th>
                            <th>Test ends</th>
                            <th>Test P&amp;L</th>
                            <th>Trades</th>
                          </tr>
                        </thead>
                        <tbody>
                          {model.walkForward.map((f) => (
                            <tr key={f.testEnd}>
                              <td>{date(f.trainEnd)}</td>
                              <td>{date(f.validationEnd)}</td>
                              <td>{date(f.testEnd)}</td>
                              <td>{money(f.evaluation.netPnl)}</td>
                              <td>{f.evaluation.trades.length}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
                <p>
                  Doubled-cost final P&amp;L: {money(model.doubleCostTestPnl)} · +1h delay:{' '}
                  {money(model.delayedTestPnl)}.
                </p>
              </details>
            )}
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>News / source</th>
                    <th>Direction</th>
                    <th>Entry / exit</th>
                    <th>Quantity</th>
                    <th>Entry / exit price</th>
                    <th>Stop / target</th>
                    <th>Fees / financing</th>
                    <th>Net P&amp;L</th>
                    <th>Outcome / exit</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.slice(page * 20, (page + 1) * 20).map((t) => {
                    const e = eventsById.get(t.eventId);
                    return (
                      <tr key={t.eventId}>
                        <td>
                          {e ? (
                            <>
                              <a href={e.url} target="_blank" rel="noreferrer">
                                {e.title}
                              </a>
                              <small>{e.publisher}</small>
                            </>
                          ) : (
                            t.eventId
                          )}
                        </td>
                        <td>{t.side}</td>
                        <td>
                          {date(t.entryAt)}
                          <small>{date(t.exitAt)}</small>
                        </td>
                        <td>{t.quantity}</td>
                        <td>
                          {t.entryPrice}
                          <small>{t.exitPrice}</small>
                        </td>
                        <td>
                          {t.stop}
                          <small>{t.target}</small>
                        </td>
                        <td>
                          {money(t.fees)} / {money(t.financing)}
                        </td>
                        <td>{money(t.netPnl)}</td>
                        <td>
                          {t.status}
                          <small>{t.reason}</small>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!trades.length && (
              <p>No matching positions. Inspect evidence and HOLD reasons above.</p>
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
                disabled={(page + 1) * 20 >= trades.length}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </button>
            </div>
          </section>
          <section className="panel">
            <h2>{asset} · V4 event interpretation</h2>
            <select
              aria-label="V4 event gate"
              value={eventGate}
              onChange={(e) => setEventGate(e.target.value)}
            >
              <option value="ALL">All event gates</option>
              {[...new Set(report.events.map((e) => e.gate))].sort().map((g) => (
                <option key={g}>{g}</option>
              ))}
            </select>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>News and source</th>
                    <th>Kind / stage</th>
                    <th>Feature</th>
                    <th>Gate</th>
                    <th>Publication / actual collection</th>
                    <th>Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {events.slice(eventPage * 20, (eventPage + 1) * 20).map((e) => (
                    <tr key={e.id}>
                      <td>
                        <a href={e.url} target="_blank" rel="noreferrer">
                          {e.title}
                        </a>
                        <small>{e.publisher}</small>
                      </td>
                      <td>
                        {e.kind}
                        <small>{e.stage}</small>
                      </td>
                      <td>
                        {e.featureKind}
                        <small>Sign: {e.featureSign}</small>
                        {e.baseline && (
                          <small>
                            Actual {e.macro?.actual} vs previous-three median {e.baseline.value};
                            latest prior {date(e.baseline.latestPriorPublicationAt)}. Not consensus.
                          </small>
                        )}
                      </td>
                      <td>{e.gate.replaceAll('_', ' ')}</td>
                      <td>
                        {date(e.publishedAt)}
                        <small>{date(e.availableAt)}</small>
                      </td>
                      <td>
                        <details>
                          <summary>Original evidence quotes</summary>
                          {e.evidenceQuotes.map((q, i) => (
                            <p key={i}>{q}</p>
                          ))}
                        </details>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="news-history-toolbar">
              <button
                className="button"
                disabled={!eventPage}
                onClick={() => setEventPage((p) => p - 1)}
              >
                Previous
              </button>
              <span>
                {events.length} matching events · page {eventPage + 1}
              </span>
              <button
                className="button"
                disabled={(eventPage + 1) * 20 >= events.length}
                onClick={() => setEventPage((p) => p + 1)}
              >
                Next
              </button>
            </div>
          </section>
          <section className="panel">
            <details>
              <summary>Frozen input hashes and study limitations</summary>
              <p className="news-history-hash">
                Engine {report.engineHash}
                <br />
                Corpus {report.corpusHash}
                <br />
                Original V3 report {report.referenceV3ReportHash}
                <br />
                Original V1/V2 report {report.referenceLegacyReportHash}
              </p>
              {report.limitations.map((s) => (
                <p key={s}>{s}</p>
              ))}
            </details>
          </section>
        </>
      )}
    </div>
  );
}
