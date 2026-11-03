import { describe, expect, it, vi } from 'vitest';
import { NewsOntologySchema } from '@crypto/contracts';
import type { NewsExtractionCandidate } from '@crypto/contracts';
import { canonicalHash, MockClock, utc } from '@crypto/core';
import {
  defaultNewsOntology,
  defaultNewsExtractionConfig,
  DeterministicNewsClaimAdapter,
  deterministicNewsCandidates,
  extractedNewsClaimsAt,
  NewsClaimExtractor,
  newsExtractionFixtures,
  newsExtractionPrompt,
  validateNewsExtractionResult,
} from '@crypto/news';
import type { NewsClaimAdapter } from '@crypto/news';

const all = newsExtractionFixtures();
async function input(id = 'security') {
  return structuredClone((await all).find((c) => c.id === id)!.input);
}
function setup(
  adapter: NewsClaimAdapter = new DeterministicNewsClaimAdapter(),
  config = defaultNewsExtractionConfig(),
) {
  const clock = new MockClock('2026-01-01T00:03:00Z');
  return {
    clock,
    extractor: new NewsClaimExtractor(adapter, config, clock, 'synthetic-extraction-test.v1'),
  };
}
function fake(
  response: (request: Parameters<NewsClaimAdapter['extract']>[0]) => unknown,
): NewsClaimAdapter;
function fake(response: unknown): NewsClaimAdapter;
function fake(response: unknown): NewsClaimAdapter {
  return {
    descriptor: {
      kind: 'INJECTED_STRUCTURED',
      modelVersion: 'synthetic-structured-adapter.v1',
      promptVersion: newsExtractionPrompt.version,
    },
    extract: vi.fn((request) =>
      Promise.resolve(
        typeof response === 'function'
          ? (response as (v: typeof request) => unknown)(request)
          : response,
      ),
    ),
  };
}
function configured(adapter: NewsClaimAdapter) {
  return setup(adapter, { ...defaultNewsExtractionConfig(), minIntervalMs: 1000 });
}
function grounded(request: Parameters<NewsClaimAdapter['extract']>[0]) {
  return {
    schemaVersion: 'news-structured-extraction.v1',
    candidates: deterministicNewsCandidates(request.text, request.language, request.ontology),
  };
}
function spans(candidate: NewsExtractionCandidate) {
  return [
    candidate.evidence,
    candidate.trigger,
    ...(candidate.subject ? [candidate.subject] : []),
    ...candidate.amounts.map((a) => a.evidence),
    ...(candidate.eventTime.evidence ? [candidate.eventTime.evidence] : []),
    ...candidate.entities.map((e) => e.evidence),
    ...candidate.affectedAssets.map((a) => a.evidence),
  ];
}
describe('literal news ontology and evidence extraction', () => {
  it('covers all required event types through separately labelled synthetic evidence', async () => {
    const candidates = (await all).flatMap((c) =>
      deterministicNewsCandidates(
        c.input.article.version.document.title,
        c.input.article.version.document.language,
        defaultNewsOntology(),
      ),
    );
    expect(new Set(candidates.map((c) => c.eventType))).toEqual(
      new Set(defaultNewsOntology().events.map((e) => e.type)),
    );
    expect(
      (await all).every((c) => c.input.article.version.document.provenance.origin === 'FIXTURE'),
    ).toBe(true);
  });
  it('preserves explicit negation without confirming an event', async () => {
    const result = await setup().extractor.extract(await input('negated'));
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]?.candidate.polarity).toBe('NEGATED');
    expect(result.claims[0]?.canonical.verifiedStatus).toBe('UNVERIFIED');
    expect(result.claims[0]?.canonical.confidence.status).toBe('MISSING');
    expect(result.status).toBe('EXTRACTED');
  });
  it('keeps equal numeric amounts with different currencies as distinct assertions', async () => {
    const result = await setup().extractor.extract(await input('currencies'));
    expect(result.claims).toHaveLength(2);
    expect(
      result.claims.map((c) => [c.candidate.amounts[0]?.value, c.candidate.amounts[0]?.unit]),
    ).toEqual([
      ['10', 'USD'],
      ['10', 'EUR'],
    ]);
    expect(result.claims[0]?.id).not.toBe(result.claims[1]?.id);
    expect(result.claims[0]?.canonical.eventId).not.toBe(result.claims[1]?.canonical.eventId);
  });
  it('extracts subject, predicate, quantities, time granularity, mentioned assets and named entities', async () => {
    const result = await setup().extractor.extract(await input()),
      claim = result.claims[0]!.candidate;
    expect(claim).toMatchObject({
      eventType: 'SECURITY_INCIDENT',
      predicate: 'security_incident',
      language: 'en',
      subject: { text: 'Synthetic Vault' },
      eventTime: { granularity: 'DAY', at: null },
      unknownFields: [],
    });
    expect(claim.affectedAssets[0]).toMatchObject({ symbol: 'BTC', relationship: 'MENTIONED' });
    expect(claim.entities.map((e) => e.name)).toEqual(['Synthetic Vault', 'BTC']);
    expect(claim.amounts[0]).toMatchObject({ value: '10', unit: 'USD', kind: 'CURRENCY' });
  });
  it('preserves UTF-16 offsets through Unicode case folding, emoji and decimal values', async () => {
    const value = await input('unicode'),
      result = await setup().extractor.extract(value),
      claim = result.claims[0]!.candidate,
      text = value.article.version.document.title;
    for (const evidence of spans(claim))
      expect(text.slice(evidence.start, evidence.end)).toBe(evidence.text);
    expect(claim.subject?.text).toBe('Synthetic Vault');
    expect(claim.amounts[0]?.value).toBe('1.25');
    expect(claim.eventTime).toMatchObject({
      granularity: 'SECOND',
      at: utc('2026-01-01T08:10:00Z'),
    });
  });
  it('handles Russian negation and aliases without inventing factual confidence', async () => {
    const result = await setup().extractor.extract(await input('russian'));
    expect(result.claims[0]?.candidate).toMatchObject({
      language: 'ru',
      polarity: 'NEGATED',
      subject: { text: 'Вымышленное Хранилище' },
    });
    expect(result.claims[0]?.canonical.verifiedStatus).toBe('UNVERIFIED');
  });
  it('keeps hedging, ambiguous dollar units and relative time explicitly unknown', async () => {
    const result = await setup().extractor.extract(await input('ambiguous')),
      claim = result.claims[0]!.candidate;
    expect(result.status).toBe('REVIEW_NEEDED');
    expect(claim).toMatchObject({
      polarity: 'UNCERTAIN',
      eventTime: { evidence: null, at: null, granularity: 'UNKNOWN' },
    });
    expect(claim.amounts[0]).toMatchObject({ value: null, unit: null, kind: 'UNKNOWN' });
    expect(claim.unknownFields).toEqual(
      expect.arrayContaining(['AMOUNT', 'EVENT_TIME', 'ASSETS', 'POLARITY']),
    );
  });
  it('does not silently expand scaled or localized amounts and preserves the explicit unit', async () => {
    const result = await setup().extractor.extract(await input('scaled'));
    expect(result.claims[0]?.candidate.amounts[0]).toMatchObject({
      value: null,
      unit: 'USD',
      kind: 'CURRENCY',
    });
    expect(result.reviewReasons).toContain('AMBIGUOUS_FIELDS');
    const localized = deterministicNewsCandidates(
      'Synthetic Vault reported a security incident involving 1,000 EUR.',
      'en',
      defaultNewsOntology(),
    );
    expect(localized[0]?.amounts[0]).toMatchObject({ value: null, unit: 'EUR' });
  });
  it.each([
    ['2026', 'YEAR', null],
    ['2026-02', 'MONTH', null],
    ['2026-02-28', 'DAY', null],
    ['2026-02-28T09:10Z', 'MINUTE', '2026-02-28T09:10:00Z'],
    ['2026-02-30', 'UNKNOWN', null],
    ['2026-02-28T09:10:00+03:00', 'UNKNOWN', null],
  ])(
    'keeps declared granularity for %s without inventing sub-day precision',
    (date, granularity, normalized) => {
      const candidate = deterministicNewsCandidates(
        `Synthetic Vault reported a security incident on ${date}.`,
        'en',
        defaultNewsOntology(),
      )[0]!;
      expect(candidate.eventTime.granularity).toBe(granularity);
      expect(candidate.eventTime.at).toBe(normalized ? utc(normalized) : null);
    },
  );
  it('does not treat a four-digit currency amount as an event year', () => {
    const candidate = deterministicNewsCandidates(
      'Synthetic Vault reported a security incident in 2026 USD.',
      'en',
      defaultNewsOntology(),
    )[0]!;
    expect(candidate.eventTime.granularity).toBe('UNKNOWN');
    expect(candidate.amounts[0]?.unit).toBe('USD');
  });
  it('respects token boundaries, literal configurable phrases and mixed-event ambiguity', () => {
    const ontology = defaultNewsOntology(),
      custom = structuredClone(ontology);
    custom.events = [
      {
        type: 'TOKEN_UNLOCK',
        predicate: 'custom_unlock',
        triggers: [{ language: 'en', text: 'token (unlock)' }],
      },
    ];
    expect(
      deterministicNewsCandidates('Synthetic Vault reported a token (unlock).', 'en', custom)[0]
        ?.predicate,
    ).toBe('custom_unlock');
    expect(
      deterministicNewsCandidates('Synthetic Vault announced a delisting.', 'en', ontology)[0]
        ?.eventType,
    ).toBe('DELISTING');
    expect(
      deterministicNewsCandidates(
        'Synthetic Vault reported a security incident and insolvency.',
        'en',
        ontology,
      ),
    ).toHaveLength(0);
    const duplicate = structuredClone(ontology);
    duplicate.units.push(duplicate.units[0]!);
    expect(NewsOntologySchema.safeParse(duplicate).success).toBe(false);
  });
  it.each(['injection', 'unsupported'])(
    'routes %s to review before invoking an adapter',
    async (id) => {
      const adapter = fake(grounded),
        result = await configured(adapter).extractor.extract(await input(id));
      expect(result.status).toBe('REVIEW_NEEDED');
      expect(result.claims).toHaveLength(0);
      expect(adapter.extract).not.toHaveBeenCalled();
    },
  );
  it('returns review-needed for a bulletin with no supported assertion', async () => {
    const result = await setup().extractor.extract(await input('empty-evidence'));
    expect(result).toMatchObject({
      status: 'REVIEW_NEEDED',
      claims: [],
      reviewReasons: ['NO_CANDIDATES'],
    });
  });
});
describe('untrusted structured adapter boundary', () => {
  it.each([
    '',
    'not JSON',
    null,
    undefined,
    {},
    { schemaVersion: 'news-structured-extraction.v1', candidates: [] },
  ])('safely reviews empty or invalid response %j', async (response) => {
    const result = await configured(fake(response)).extractor.extract(await input());
    expect(result.status).toBe('REVIEW_NEEDED');
    expect(result.claims).toHaveLength(0);
  });
  it('accepts grounded structured output and records unknown external cost and pinned model/prompt versions', async () => {
    const result = await configured(fake(grounded)).extractor.extract(await input());
    expect(result.status).toBe('EXTRACTED');
    expect(result.cost).toEqual({ status: 'UNKNOWN', amount: null, currency: 'USD' });
    expect(result.adapter.modelVersion).toBe('synthetic-structured-adapter.v1');
    expect(result.claims[0]?.canonical.provenance.sourceVersion).toBe(
      'synthetic-structured-adapter.v1',
    );
    expect(validateNewsExtractionResult(result).inputHash).toBe(result.inputHash);
  });
  it.each(['offset', 'negation', 'currency', 'entity', 'verified', 'omission'])(
    'rejects fabricated %s even alongside an exact quotation',
    async (mutation) => {
      const adapter = fake((request) => {
        const response = grounded(request),
          candidate = response.candidates[0]!;
        if (mutation === 'offset') candidate.trigger.start++;
        if (mutation === 'negation') candidate.polarity = 'AFFIRMED';
        if (mutation === 'currency') candidate.amounts[0]!.unit = 'EUR';
        if (mutation === 'entity') candidate.subject!.text = 'Invented organization';
        if (mutation === 'verified') return { ...response, verifiedStatus: 'CORROBORATED' };
        if (mutation === 'omission') candidate.amounts = [];
        return response;
      });
      const result = await configured(adapter).extractor.extract(await input('negated'));
      expect(result.status).toBe('REVIEW_NEEDED');
      expect(result.claims).toHaveLength(0);
    },
  );
  it('enforces response byte limits without retaining the raw invalid response', async () => {
    const adapter = fake('x'.repeat(200000)),
      result = await configured(adapter).extractor.extract(await input());
    expect(result.reviewReasons).toContain('INVALID_RESPONSE');
    expect(JSON.stringify(result)).not.toContain('x'.repeat(100));
  });
  it('reserves attempts before errors and enforces interval and session budgets without retries', async () => {
    const adapter = fake('invalid'),
      clock = new MockClock('2026-01-01T00:03:00Z'),
      extractor = new NewsClaimExtractor(
        adapter,
        { ...defaultNewsExtractionConfig(), minIntervalMs: 1000, maxRequests: 2 },
        clock,
        'synthetic.v1',
      ),
      value = await input();
    await extractor.extract(value);
    expect((await extractor.extract(value)).reviewReasons).toContain('RATE_LIMIT');
    clock.advanceBy(1n, 'seconds');
    await extractor.extract(value);
    clock.advanceBy(1n, 'seconds');
    expect((await extractor.extract(value)).reviewReasons).toContain('RATE_LIMIT');
    expect(adapter.extract).toHaveBeenCalledTimes(2);
  });
  it('times out, signals cancellation and stops the session when an adapter ignores abort', async () => {
    let signal: AbortSignal | undefined;
    const adapter = fake(null);
    adapter.extract = (_request, supplied) => {
      signal = supplied;
      return new Promise(() => undefined);
    };
    const { extractor, clock } = setup(adapter, {
      ...defaultNewsExtractionConfig(),
      minIntervalMs: 1000,
      timeoutMs: 10,
    });
    expect((await extractor.extract(await input())).reviewReasons).toContain('TIMEOUT');
    expect(signal?.aborted).toBe(true);
    clock.advanceBy(1n, 'seconds');
    expect((await extractor.extract(await input())).reviewReasons).toContain('RATE_LIMIT');
  });
  it('records model failures as sanitized review reasons', async () => {
    const adapter = fake(null);
    adapter.extract = () => Promise.reject(new Error('secret-provider-error'));
    const result = await configured(adapter).extractor.extract(await input());
    expect(result.reviewReasons).toContain('ADAPTER_ERROR');
    expect(JSON.stringify(result)).not.toContain('secret-provider-error');
  });
});
describe('provenance, temporal and license gates', () => {
  it('blocks public source text at the injected boundary and rejects mismatched fixture provenance', async () => {
    const value = await input(),
      adapter = fake(grounded);
    value.source.accessMethod = 'PUBLIC_HTTPS';
    value.source.licensing.policy = 'OFFICIAL_PUBLIC';
    value.article.version.document.licensing.policy = 'OFFICIAL_PUBLIC';
    value.article.version.sourceHash = canonicalHash(value.source);
    value.article.versionHash = canonicalHash(value.article.version);
    expect((await configured(adapter).extractor.extract(value)).reviewReasons).toContain(
      'INPUT_POLICY',
    );
    value.article.version.document.provenance.origin = 'PUBLIC_READ_ONLY';
    value.article.versionHash = canonicalHash(value.article.version);
    const result = await configured(adapter).extractor.extract(value);
    expect(result.claims).toHaveLength(0);
    expect(result.reviewReasons).toContain('INPUT_POLICY');
    expect(adapter.extract).not.toHaveBeenCalled();
  });
  it('makes claims knowable at extraction completion rather than article publication or receipt', async () => {
    const adapter = fake(grounded),
      { extractor, clock } = configured(adapter),
      extract = adapter.extract;
    adapter.extract = async (request, signal) => {
      const response = await extract(request, signal);
      clock.advanceBy(5n, 'milliseconds');
      return response;
    };
    const result = await extractor.extract(await input());
    expect(result.claims[0]?.canonical.firstKnownAt).toBe(clock.now());
    expect(extractedNewsClaimsAt(result, '2026-01-01T00:03:00Z')).toHaveLength(0);
    expect(extractedNewsClaimsAt(result, clock.now())).toHaveLength(1);
  });
  it.each(['DESCRIPTIVE_ONLY', 'POINT_IN_TIME_ESTIMATED'] as const)(
    'keeps %s evidence out of eligible canonical claims',
    async (temporalClass) => {
      const value = await input();
      value.article.temporalClass = temporalClass;
      value.article.effectiveAvailableAt = null;
      const { extractor, clock } = setup(),
        result = await extractor.extract(value);
      expect(result.claims[0]?.canonical.researchUse).toBe('DESCRIPTIVE_ONLY');
      expect(extractedNewsClaimsAt(result, clock.now())).toHaveLength(0);
    },
  );
  it('rejects future or excluded input without calling the adapter', async () => {
    for (const patch of [
      { excluded: true },
      { effectiveAvailableAt: utc('2026-01-01T00:30:00Z') },
    ]) {
      const value = await input(),
        adapter = fake(grounded);
      Object.assign(value.article, patch);
      const result = await configured(adapter).extractor.extract(value);
      expect(result.reviewReasons).toContain('FUTURE_OR_EXCLUDED');
      expect(adapter.extract).not.toHaveBeenCalled();
    }
  });
  it('checks source/version hashes and snippet permissions before any extraction', async () => {
    const value = await input(),
      adapter = fake(grounded);
    value.article.versionHash = canonicalHash('different');
    expect((await configured(adapter).extractor.extract(value)).reviewReasons).toContain(
      'INPUT_POLICY',
    );
    const absent = await input();
    delete absent.article.version.document.approvedSnippet;
    absent.article.versionHash = canonicalHash(absent.article.version);
    absent.field = 'APPROVED_SNIPPET';
    expect((await configured(adapter).extractor.extract(absent)).reviewReasons).toContain(
      'INPUT_POLICY',
    );
    expect(adapter.extract).not.toHaveBeenCalled();
  });
  it('extracts approved snippets with offsets relative to that field, and records zero external fixture cost', async () => {
    const value = await input();
    value.field = 'APPROVED_SNIPPET';
    const result = await setup().extractor.extract(value);
    expect(result.claims).toHaveLength(1);
    expect(result.cost).toEqual({ status: 'ZERO_EXTERNAL_COST', amount: '0', currency: 'USD' });
    for (const evidence of spans(result.claims[0]!.candidate))
      expect(
        value.article.version.document.approvedSnippet!.slice(evidence.start, evidence.end),
      ).toBe(evidence.text);
  });
  it('reproduces fixed-clock results and rejects tampered claim status or configuration', async () => {
    const value = await input(),
      a = await setup().extractor.extract(value),
      b = await setup().extractor.extract(value);
    expect(canonicalHash(a)).toBe(canonicalHash(b));
    expect(() =>
      validateNewsExtractionResult({ ...a, configHash: canonicalHash('wrong') }),
    ).toThrow();
    const forged = structuredClone(a);
    forged.claims[0]!.canonical.verifiedStatus = 'CORROBORATED';
    expect(() => validateNewsExtractionResult(forged)).toThrow();
    const backdated = structuredClone(a);
    backdated.claims[0]!.canonical.availableAt = utc('2020-01-01T00:00:00Z');
    expect(() => validateNewsExtractionResult(backdated)).toThrow();
  });
});
