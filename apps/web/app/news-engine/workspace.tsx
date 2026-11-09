'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { z } from 'zod';
import {
  LiveNewsSourceView,
  LiveNewsSourceInput,
  LiveNewsPage,
  LiveNewsAiProfile,
  LiveNewsVersionSchema,
} from '../../../../packages/contracts/src/live-news';
import type { LiveNewsSource } from '../../../../packages/contracts/src/live-news';
import './workspace.css';

const Sources = z.object({ sources: z.array(LiveNewsSourceView) });
const Status = z.object({
  asOf: z.number(),
  articleCount: z.number(),
  sources: z.number(),
  enabled: z.number(),
  healthy: z.number(),
  collector: z.object({ heartbeatAt: z.number(), healthy: z.boolean() }).nullable(),
  analyzer: z.object({ heartbeatAt: z.number(), healthy: z.boolean() }).nullable(),
  ai: LiveNewsAiProfile.nullable(),
  queues: z.object({
    connected: z.boolean(),
    collection: z.record(z.string(), z.number()).optional(),
    analysis: z.record(z.string(), z.number()).optional(),
  }),
});
const stamp = (n: number | null | undefined) =>
  n == null ? '—' : new Date(n).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
async function request<T>(path: string, schema: z.ZodType<T>, body?: unknown, method = 'POST') {
  const r = await fetch('/api/news' + path, {
    cache: 'no-store',
    credentials: 'same-origin',
    signal: AbortSignal.timeout(15000),
    ...(body === undefined
      ? {}
      : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!r.ok) {
    const error = z.object({ error: z.string() }).safeParse(await r.json().catch(() => null));
    throw new Error(
      error.success
        ? error.data.error.replaceAll('_', ' ')
        : r.status === 404
          ? 'Live news service is not enabled in this environment.'
          : 'News request failed.',
    );
  }
  return schema.parse(await r.json());
}
type SourceView = z.infer<typeof LiveNewsSourceView>;
type SourceInput = z.infer<typeof LiveNewsSourceInput>;
const editable = (s: LiveNewsSource): SourceInput => LiveNewsSourceInput.strip().parse(s);
const newSource: SourceInput = {
  name: '',
  homepage: 'https://',
  category: 'PUBLICATION',
  adapter: 'RSS_ATOM',
  feedUrl: 'https://',
  articleOrigins: [],
  enabled: false,
  pollIntervalSeconds: 300,
  independenceGroup: 'custom-news',
  language: 'en',
  collectionApproved: false,
  aiAllowed: false,
  maxExcerptChars: 0,
  permissionReference: '',
  notes: '',
};
export default function NewsWorkspace({ role }: { role: 'READ' | 'ADMIN' }) {
  const [tab, setTab] = useState<'feed' | 'sources' | 'ai'>('feed'),
    [sources, setSources] = useState<SourceView[]>([]),
    [status, setStatus] = useState<z.infer<typeof Status> | null>(null),
    [page, setPage] = useState<z.infer<typeof LiveNewsPage> | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [filters, setFilters] = useState({
      source: '',
      search: '',
      asset: '',
      analysis: '',
      sort: 'observed',
      direction: 'desc',
      page: 1,
    }),
    [editing, setEditing] = useState<{
      id: string | null;
      revision: number | null;
      config: SourceInput;
      origins: string;
    } | null>(null),
    [history, setHistory] = useState<z.infer<typeof LiveNewsVersionSchema>[]>([]),
    [historyId, setHistoryId] = useState('');
  const query = new URLSearchParams(
    Object.entries(filters)
      .filter(([, v]) => v !== '')
      .map(([k, v]) => [k, String(v)]),
  ).toString();
  const load = useCallback(async () => {
    try {
      const [s, r, p] = await Promise.all([
        request('/sources', Sources),
        request('/status', Status),
        request('/articles?' + query, LiveNewsPage),
      ]);
      setSources(s.sources);
      setStatus(r);
      setPage(p);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'News service unavailable.');
    }
  }, [query]);
  useEffect(() => {
    void load();
    const t = setInterval(() => {
      void load();
    }, 15000);
    return () => clearInterval(t);
  }, [load]);
  const change = (key: keyof typeof filters, value: string) =>
    setFilters((f) => ({ ...f, [key]: value, page: 1 }));
  async function action(path: string, body: unknown = {}) {
    setBusy(true);
    setNotice('');
    try {
      await request(path, z.unknown(), body);
      setNotice('Job queued. Source limits, backoff and the AI daily budget still apply.');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Operation failed.');
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!editing) return;
    setBusy(true);
    try {
      const config = {
        ...editing.config,
        feedUrl: editing.config.feedUrl || null,
        articleOrigins: editing.origins
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean),
      };
      LiveNewsSourceInput.parse(config);
      await request(
        editing.id ? '/sources/' + editing.id : '/sources',
        z.unknown(),
        editing.id ? { expectedRevision: editing.revision, config } : config,
        editing.id ? 'PATCH' : 'POST',
      );
      setEditing(null);
      setNotice('Source settings saved. Its schedule updates automatically within 30 seconds.');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Source could not be saved.');
    } finally {
      setBusy(false);
    }
  }
  async function toggle(s: LiveNewsSource) {
    setBusy(true);
    try {
      const config = editable(s);
      await request(
        '/sources/' + s.id,
        z.unknown(),
        { expectedRevision: s.revision, config: { ...config, enabled: !s.enabled } },
        'PATCH',
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Source could not be updated.');
    } finally {
      setBusy(false);
    }
  }
  async function inspect(id: string) {
    try {
      const r = await request(
        '/articles/' + id,
        z.object({ versions: z.array(LiveNewsVersionSchema) }),
      );
      setHistory(r.versions);
      setHistoryId(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Revision history unavailable.');
    }
  }
  return (
    <div className="news-workspace">
      <div className="notice">
        <Link href="/news-paper">Open news-driven paper trading →</Link>
      </div>
      <div className="context-bar">
        <span className="context-dot" />
        <strong>Real public news · scheduled collection</strong>
        <span>Publisher links and short permitted excerpts · AI labels remain unverified</span>
      </div>
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}
      <div className="news-summary">
        <div className="panel">
          <span>Collected articles</span>
          <strong>{status?.articleCount ?? '—'}</strong>
        </div>
        <div className="panel">
          <span>Healthy / enabled sources</span>
          <strong>{status ? `${status.healthy} / ${status.enabled}` : '—'}</strong>
          <small>{status?.sources ?? 0} candidates retained</small>
        </div>
        <div className="panel">
          <span>BullMQ collection worker</span>
          <strong>{status?.collector?.healthy ? 'Running' : 'Waiting / unavailable'}</strong>
          <small>Last heartbeat {stamp(status?.collector?.heartbeatAt)}</small>
        </div>
        <div className="panel">
          <span>AI requests today</span>
          <strong>
            {status?.ai ? `${status.ai.requestsToday} / ${status.ai.dailyLimit}` : 'Not configured'}
          </strong>
          <small>{status?.ai?.model ?? 'Provider settings are private'}</small>
        </div>
      </div>
      <div className="news-toolbar">
        <div className="news-tabs">
          {(['feed', 'sources', 'ai'] as const).map((t) => (
            <button
              key={t}
              type="button"
              className={tab === t ? 'active' : ''}
              aria-pressed={tab === t}
              onClick={() => setTab(t)}
            >
              {t === 'feed'
                ? 'Collected news'
                : t === 'sources'
                  ? 'Manage sources'
                  : 'AI & queue status'}
            </button>
          ))}
        </div>
        <button
          className="button"
          onClick={() => {
            void load();
          }}
        >
          Refresh
        </button>
        {role === 'ADMIN' && (
          <button
            className="button primary"
            disabled={busy}
            onClick={() => {
              void action('/collect');
            }}
          >
            Collect enabled sources
          </button>
        )}
      </div>
      {tab === 'feed' && (
        <>
          <section className="panel news-filters">
            <label>
              Search headlines
              <input
                value={filters.search}
                placeholder="SOL, XRP, regulation…"
                onChange={(e) => change('search', e.target.value)}
              />
            </label>
            <label>
              Source
              <select value={filters.source} onChange={(e) => change('source', e.target.value)}>
                <option value="">All sources</option>
                {sources.map((s) => (
                  <option key={s.config.id} value={s.config.id}>
                    {s.config.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Asset
              <select value={filters.asset} onChange={(e) => change('asset', e.target.value)}>
                <option value="">All assets</option>
                {['BTC', 'ETH', 'SOL', 'XRP', 'USDT', 'TRX', 'BNB', 'OTHER'].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
            <label>
              AI status
              <select value={filters.analysis} onChange={(e) => change('analysis', e.target.value)}>
                <option value="">All statuses</option>
                {['PENDING', 'ANALYZED', 'REVIEW_REQUIRED', 'FAILED', 'NOT_PERMITTED'].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
            <label>
              Sort
              <select value={filters.sort} onChange={(e) => change('sort', e.target.value)}>
                <option value="observed">Collection time</option>
                <option value="published">Publication time</option>
              </select>
            </label>
            <label>
              Order
              <select
                value={filters.direction}
                onChange={(e) => change('direction', e.target.value)}
              >
                <option value="desc">Newest first</option>
                <option value="asc">Oldest first</option>
              </select>
            </label>
            <div className="news-export">
              <a className="button" href={'/api/news/export/json?' + query}>
                Export JSON
              </a>
              <a className="button" href={'/api/news/export/csv?' + query}>
                Export CSV
              </a>
            </div>
          </section>
          <p className="news-help">
            First seen is when our collector received the item. Publication dates do not make it
            available to earlier trading decisions. AI direction describes the news text and is not
            a trading instruction.
          </p>
          {!page?.items.length ? (
            <div className="panel empty">
              {page
                ? 'No articles match these filters. Collection status is available under Manage sources.'
                : 'Connecting to the live news service…'}
            </div>
          ) : (
            <div className="news-list">
              {page.items.map(({ version: v, analysis: a, analysisState, duplicateCount }) => (
                <article className="panel news-card" key={v.id}>
                  <div className="news-card-meta">
                    <strong>{v.publisher}</strong>
                    <span>Revision {v.revision}</span>
                    <span className="news-badge">{analysisState.replaceAll('_', ' ')}</span>
                    {duplicateCount > 1 && (
                      <span className="news-badge">
                        {duplicateCount} similar headlines · possible dependency
                      </span>
                    )}
                  </div>
                  <h2>
                    <a href={v.url} target="_blank" rel="noopener noreferrer">
                      {v.title} ↗
                    </a>
                  </h2>
                  {v.excerpt && <p className="news-excerpt">{v.excerpt}</p>}
                  <div className="news-times">
                    <span>Published {stamp(v.publishedAt)}</span>
                    <span>First seen {stamp(v.firstSeenAt)}</span>
                    <span>Version available {stamp(v.availableAt)}</span>
                  </div>
                  {v.captureKind === 'INITIAL_SNAPSHOT' && (
                    <small>
                      Initial feed snapshot · earlier publication does not imply earlier collection
                    </small>
                  )}
                  {a?.result && (
                    <div className="news-analysis">
                      <div className="news-card-meta">
                        <strong>AI interpretation · {a.evidenceStatus.replaceAll('_', ' ')}</strong>
                        <span>{a.result.eventType.replaceAll('_', ' ')}</span>
                        <span>{a.result.direction}</span>
                        <span>Severity {a.result.severity}</span>
                        <span>{a.result.assets.join(' · ') || 'Assets unclear'}</span>
                        {a.result.negated && <span>Negated event</span>}
                      </div>
                      <p>{a.result.summary}</p>
                      <details>
                        <summary>Evidence and limitations</summary>
                        {a.result.evidenceQuotes.map((q, i) => (
                          <blockquote key={i}>{q}</blockquote>
                        ))}
                        <ul>
                          {a.result.uncertainties.map((u, i) => (
                            <li key={i}>{u}</li>
                          ))}
                        </ul>
                        <small>
                          {a.model} · {a.promptVersion} · analyzed {stamp(a.processedAt)} ·{' '}
                          {a.promptTokens === null || a.completionTokens === null
                            ? 'usage unavailable'
                            : `${a.promptTokens + a.completionTokens} tokens`}
                        </small>
                      </details>
                    </div>
                  )}
                  {a?.error && (
                    <p className="notice">{a.error.replaceAll('_', ' ')} · retained for review</p>
                  )}
                  <div className="news-card-footer">
                    <button
                      className="button"
                      onClick={() => {
                        void inspect(v.id);
                      }}
                    >
                      Revision history
                    </button>
                    {role === 'ADMIN' && v.aiAllowed && analysisState !== 'ANALYZED' && (
                      <button
                        className="button"
                        disabled={busy || !status?.ai?.enabled}
                        onClick={() => {
                          void action('/articles/' + v.id + '/analyze');
                        }}
                      >
                        Analyze with AI
                      </button>
                    )}
                    <small>
                      Attribution: {v.publisher} · group {v.independenceGroup}
                    </small>
                  </div>
                  {historyId === v.id && (
                    <div className="news-history">
                      {history.map((h) => (
                        <div key={h.id}>
                          <strong>
                            v{h.revision}: {h.title}
                          </strong>
                          <small>
                            Available {stamp(h.availableAt)} · content {h.contentHash.slice(0, 16)}…
                          </small>
                        </div>
                      ))}
                      <button className="button" onClick={() => setHistoryId('')}>
                        Close history
                      </button>
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
          <div className="news-pagination">
            <button
              className="button"
              disabled={filters.page <= 1}
              onClick={() => setFilters((f) => ({ ...f, page: f.page - 1 }))}
            >
              Previous
            </button>
            <span>
              Page {filters.page} · {page?.total ?? 0} articles
            </span>
            <button
              className="button"
              disabled={!page || filters.page * page.pageSize >= page.total}
              onClick={() => setFilters((f) => ({ ...f, page: f.page + 1 }))}
            >
              Next
            </button>
          </div>
        </>
      )}
      {tab === 'sources' && (
        <>
          <div className="news-toolbar">
            <p>
              Configure RSS/Atom feeds, permissions and polling. Disabled candidates retain their
              setup requirements.
            </p>
            {role === 'ADMIN' && (
              <button
                className="button primary"
                onClick={() =>
                  setEditing({ id: null, revision: null, config: { ...newSource }, origins: '' })
                }
              >
                Add RSS / Atom source
              </button>
            )}
          </div>
          {editing && (
            <section className="panel news-editor">
              <h2>{editing.id ? 'Edit source' : 'Add source'}</h2>
              <div className="news-editor-fields">
                {(
                  [
                    'name',
                    'homepage',
                    'feedUrl',
                    'independenceGroup',
                    'permissionReference',
                    'notes',
                  ] as const
                ).map((key) => (
                  <label key={key}>
                    {
                      {
                        name: 'Source name',
                        homepage: 'Homepage',
                        feedUrl: 'HTTPS feed URL',
                        independenceGroup: 'Publisher / independence group',
                        permissionReference: 'Permission or public-feed reference',
                        notes: 'Notes and setup requirements',
                      }[key]
                    }
                    <input
                      value={editing.config[key] ?? ''}
                      onChange={(e) =>
                        setEditing({
                          ...editing,
                          config: { ...editing.config, [key]: e.target.value },
                        })
                      }
                    />
                  </label>
                ))}
                <label>
                  Allowed article origins (comma separated)
                  <input
                    placeholder="https://publisher.example"
                    value={editing.origins}
                    onChange={(e) => setEditing({ ...editing, origins: e.target.value })}
                  />
                </label>
                <label>
                  Poll interval (seconds, minimum 300)
                  <input
                    type="number"
                    min="300"
                    max="86400"
                    value={editing.config.pollIntervalSeconds}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        config: { ...editing.config, pollIntervalSeconds: Number(e.target.value) },
                      })
                    }
                  />
                </label>
                <label>
                  Adapter
                  <select
                    value={editing.config.adapter}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        config: {
                          ...editing.config,
                          adapter: e.target.value as SourceInput['adapter'],
                        },
                      })
                    }
                  >
                    <option value="RSS_ATOM">RSS / Atom</option>
                    <option value="XRPL_BLOG">XRPL blog index (official URL only)</option>
                    <option value="BYBIT_JSON">Bybit public announcements</option>
                    <option value="STATUSPAGE_JSON">Official incident updates</option>
                    <option value="GDELT_DOC">GDELT discovery metadata</option>
                    <option value="XRPL_LEDGER">Validated XRPL amendments</option>
                    <option value="GOV_ARCHIVE">Government release archive</option>
                    <option value="SETUP_REQUIRED">External API / setup required</option>
                  </select>
                </label>
                <label>
                  Category
                  <select
                    value={editing.config.category}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        config: {
                          ...editing.config,
                          category: e.target.value as SourceInput['category'],
                        },
                      })
                    }
                  >
                    {['PUBLICATION', 'OFFICIAL', 'MACRO', 'AGGREGATOR', 'TELEGRAM', 'RESEARCH'].map(
                      (c) => (
                        <option key={c}>{c}</option>
                      ),
                    )}
                  </select>
                </label>
                <label>
                  Maximum permitted excerpt (characters)
                  <input
                    type="number"
                    min="0"
                    max="500"
                    value={editing.config.maxExcerptChars}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        config: { ...editing.config, maxExcerptChars: Number(e.target.value) },
                      })
                    }
                  />
                </label>
                {(['collectionApproved', 'aiAllowed', 'enabled'] as const).map((key) => (
                  <label className="news-check" key={key}>
                    <input
                      type="checkbox"
                      checked={editing.config[key]}
                      onChange={(e) =>
                        setEditing({
                          ...editing,
                          config: { ...editing.config, [key]: e.target.checked },
                        })
                      }
                    />
                    {key === 'collectionApproved'
                      ? 'Permission permits automated feed collection'
                      : key === 'aiAllowed'
                        ? 'Permission permits AI processing'
                        : 'Enable scheduled collection'}
                  </label>
                ))}
              </div>
              <div className="news-toolbar">
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() => {
                    void save();
                  }}
                >
                  Save source
                </button>
                <button className="button" onClick={() => setEditing(null)}>
                  Cancel
                </button>
              </div>
            </section>
          )}
          <div className="panel table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Status</th>
                  <th>Last success / next eligible request</th>
                  <th>Articles</th>
                  <th>Collection / AI</th>
                  <th>Manage</th>
                </tr>
              </thead>
              <tbody>
                {sources.map(({ config: s, health: h }) => (
                  <tr key={s.id}>
                    <td>
                      <strong>{s.name}</strong>
                      <small>
                        {s.category} · every {Math.round(s.pollIntervalSeconds / 60)} min
                      </small>
                      <p className="news-source-note">{s.notes}</p>
                      <a href={s.homepage} target="_blank" rel="noopener noreferrer">
                        Publisher ↗
                      </a>
                    </td>
                    <td>
                      <span className={'news-badge ' + (h.state === 'ERROR' ? 'error' : '')}>
                        {h.state.replaceAll('_', ' ')}
                      </span>
                      {h.lastError && (
                        <small>
                          {h.lastError} {h.lastHttpStatus ? 'HTTP ' + h.lastHttpStatus : ''}
                        </small>
                      )}
                      <small>{h.consecutiveFailures} consecutive failures</small>
                    </td>
                    <td>
                      <small>{stamp(h.lastSuccessAt)}</small>
                      <small>
                        {h.nextAllowedAt > Date.now()
                          ? stamp(h.nextAllowedAt)
                          : 'Normal schedule / eligible'}
                      </small>
                    </td>
                    <td>
                      {h.totalArticles}
                      <small>{h.lastItemCount} in latest feed</small>
                      <small>{h.requestsToday} requests today</small>
                    </td>
                    <td>
                      <small>
                        {s.collectionApproved ? 'Collection approved' : 'Collection needs setup'}
                      </small>
                      <small>{s.aiAllowed ? 'AI permitted' : 'AI disabled'}</small>
                    </td>
                    <td>
                      {role === 'ADMIN' && (
                        <div className="news-source-actions">
                          <button
                            className="button"
                            onClick={() => {
                              const config = editable(s);
                              setEditing({
                                id: s.id,
                                revision: s.revision,
                                config,
                                origins: s.articleOrigins.join(', '),
                              });
                            }}
                          >
                            Edit
                          </button>
                          <button
                            className="button"
                            disabled={
                              busy || !s.collectionApproved || s.adapter === 'SETUP_REQUIRED'
                            }
                            onClick={() => {
                              void toggle(s);
                            }}
                          >
                            {s.enabled ? 'Disable' : 'Enable'}
                          </button>
                          <button
                            className="button"
                            disabled={busy || !s.enabled}
                            onClick={() => {
                              void action('/sources/' + s.id + '/collect');
                            }}
                          >
                            Collect now
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {tab === 'ai' && (
        <section className="panel news-ai-settings">
          <h2>AI connection and job status</h2>
          <dl>
            <dt>Provider</dt>
            <dd>{status?.ai?.provider ?? 'Waiting for analyzer worker'}</dd>
            <dt>Model</dt>
            <dd>{status?.ai?.model ?? '—'}</dd>
            <dt>Credential</dt>
            <dd>
              {status?.ai?.configured ? 'Configured privately on the server' : 'Not configured'}
            </dd>
            <dt>Daily request limit</dt>
            <dd>{status?.ai?.dailyLimit ?? '—'} · failed requests also consume the local limit</dd>
            <dt>Analyzer worker</dt>
            <dd>{status?.analyzer?.healthy ? 'Running' : 'Waiting / unavailable'}</dd>
            <dt>Provider cooldown</dt>
            <dd>
              {status?.ai?.nextAllowedAt && status.ai.nextAllowedAt > Date.now()
                ? stamp(status.ai.nextAllowedAt)
                : 'None'}
            </dd>
            <dt>Last provider error</dt>
            <dd>{status?.ai?.lastError ?? 'None'}</dd>
            <dt>Redis</dt>
            <dd>{status?.queues.connected ? 'Connected' : 'Unavailable'}</dd>
          </dl>
          <div className="news-queue-grid">
            {(['collection', 'analysis'] as const).map((q) => (
              <div key={q}>
                <h3>{q === 'collection' ? 'Collection queue' : 'Analysis queue'}</h3>
                {Object.entries(status?.queues[q] ?? {}).map(([name, count]) => (
                  <p key={name}>
                    {name}: <strong>{count}</strong>
                  </p>
                ))}
              </div>
            ))}
          </div>
          <p>
            AI receives the headline and only the excerpt allowed by that source. It has no browsing
            or trading tools. Its summary, direction and severity require judgment; repeated
            headlines do not prove independent confirmation.
          </p>
          <p>
            Automatic analysis covers recent publications and newly observed updates. Undated
            articles from an initial archive require manual analysis. Some public feeds collect
            headline notifications with AI disabled; source settings show their access limits.
          </p>
          <p>
            Provider URL, model and API key are configurable in the private server environment. Any
            compatible Chat Completions provider can replace DeepSeek. Keys never appear in this
            dashboard.
          </p>
        </section>
      )}
    </div>
  );
}
