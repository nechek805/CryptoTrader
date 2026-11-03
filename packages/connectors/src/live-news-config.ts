import { NewsPollConfigSchema } from '@crypto/contracts';

/** Reviewed exact endpoints only. Runtime CLI flags are a second, separate enable gate. */
export function liveNewsConfig() {
  const knownAt = '2026-10-31T00:00:00Z';
  const sources = [false, true].map((aggregation) => ({
    schemaVersion: 'news-source.v1',
    id: aggregation ? 'gdelt:cisa' : 'cisa:alerts',
    version: 1,
    providerId: aggregation ? 'gdelt-rss' : 'cisa-rss',
    owner: aggregation
      ? 'GDELT Project (index); CISA (publisher)'
      : 'Cybersecurity and Infrastructure Security Agency',
    region: 'US',
    reliabilityNotes: aggregation
      ? 'Discovery index of CISA publications; not independent confirmation.'
      : 'Official primary security notices; attribution does not verify every underlying claim.',
    publicationType: aggregation ? 'SYNDICATED' : 'OFFICIAL_SECURITY',
    independenceGroup: 'publisher:cisa',
    languages: ['en'],
    feedUrl: aggregation
      ? 'https://api.gdeltproject.org/api/v2/doc/doc?query=domainis%3Acisa.gov+sourcelang%3Aenglish&mode=artlist&format=rss&maxrecords=10&timespan=1day&sort=datedesc'
      : 'https://www.cisa.gov/cybersecurity-advisories/alerts.xml',
    articleOrigins: ['https://www.cisa.gov', 'https://cisa.gov'],
    format: 'RSS2',
    accessMethod: 'PUBLIC_HTTPS',
    updateCadenceSeconds: 900,
    polling: { minIntervalSeconds: 900, maxRequestsPerDay: 96 },
    allowedFields: ['id', 'url', 'title', 'language', 'publishedAt', 'updatedAt'],
    licensing: {
      policy: aggregation ? 'METADATA_ONLY' : 'OFFICIAL_PUBLIC',
      reference: aggregation
        ? 'https://gdeltproject.org/about.html#terms'
        : 'https://www.copyright.gov/title17/92chap1.html#105',
      restrictions:
        'Local research metadata only; attribute CISA/GDELT. No excerpts, page bodies, logos or third-party media. Do not infer historical first availability from dates.',
      permitsSnippet: false,
      maxSnippetChars: 0,
      permitsRawStorage: false,
      approvedForLive: true,
    },
    limits: { maxBytes: 262144, maxItems: aggregation ? 10 : 100, timeoutMs: 5000 },
    knownAt,
  }));
  return NewsPollConfigSchema.parse({
    schemaVersion: 'news-poll-config.v1',
    registry: {
      schemaVersion: 'news-registry.v1',
      providers: [
        {
          schemaVersion: 'news-provider.v1',
          id: 'cisa-rss',
          version: 'cisa-alerts-rss.v1',
          kind: 'RSS_ATOM',
          enabled: true,
          reference: 'https://www.cisa.gov/cybersecurity-advisories/alerts.xml',
          knownAt,
        },
        {
          schemaVersion: 'news-provider.v1',
          id: 'gdelt-rss',
          version: 'gdelt-doc-rss.v1',
          kind: 'GDELT',
          enabled: true,
          reference: 'https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/',
          knownAt,
        },
      ],
      sources,
    },
    gates: sources.map((s) => ({
      sourceId: s.id,
      role: s.providerId === 'gdelt-rss' ? 'AGGREGATION' : 'OFFICIAL',
      reviewedAt: knownAt,
      expiresAt: '2026-11-30T00:00:00Z',
      references:
        s.providerId === 'gdelt-rss'
          ? [
              'https://gdeltproject.org/about.html#terms',
              'https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/',
            ]
          : [
              'https://www.cisa.gov/cybersecurity-advisories/alerts.xml',
              'https://www.cisa.gov/robots.txt',
              'https://www.copyright.gov/title17/92chap1.html#105',
            ],
      rationale:
        s.providerId === 'gdelt-rss'
          ? 'Documented public RSS API, metadata restricted to CISA origins; article crawling disabled. Robots endpoint unavailable during review; this is an explicitly documented API request only.'
          : 'Official published RSS; robots permits advisory path. US-government-authored metadata only, no third-party material or full text retained.',
      citation:
        'CISA https://www.cisa.gov/; indexed discoveries also cite GDELT https://www.gdeltproject.org/',
    })),
    maxAttempts: 3,
    baseBackoffMs: 1000,
    maxBackoffMs: 60000,
    minGlobalIntervalMs: 1000,
  });
}
