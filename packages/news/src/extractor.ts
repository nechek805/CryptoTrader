import {
  EventClaimSchema,
  NewsExtractionConfigSchema,
  NewsExtractionInputSchema,
  NewsExtractionResultSchema,
  NewsExtractorDescriptorSchema,
  NewsStructuredResponseSchema,
  UtcTimestampSchema,
  utcNanoseconds,
} from '@crypto/contracts';
import type {
  NewsExtractionCandidate,
  NewsExtractionInput,
  NewsExtractionResult,
} from '@crypto/contracts';
import type { Clock } from '@crypto/core';
import {
  canonicalHash,
  canonicalJson,
  deepFreeze,
  deterministicId,
  isAvailableAt,
} from '@crypto/core';
import { allowedNewsArticle } from '@crypto/connectors';
import { deterministicNewsCandidates, instructionLikeNews } from './extraction-grammar.js';
import { defaultNewsOntology, newsExtractionPrompt } from './ontology.js';

export interface NewsClaimAdapter {
  descriptor: ReturnType<typeof NewsExtractorDescriptorSchema.parse>;
  extract(
    this: void,
    request: {
      text: string;
      language: string;
      ontology: ReturnType<typeof defaultNewsOntology>;
      prompt: typeof newsExtractionPrompt;
    },
    signal: AbortSignal,
  ): Promise<unknown>;
}
export class DeterministicNewsClaimAdapter implements NewsClaimAdapter {
  readonly descriptor = {
    kind: 'DETERMINISTIC' as const,
    modelVersion: 'literal-news-grammar.v1',
    promptVersion: newsExtractionPrompt.version,
  };
  extract(request: Parameters<NewsClaimAdapter['extract']>[0]): Promise<unknown> {
    return Promise.resolve({
      schemaVersion: 'news-structured-extraction.v1',
      candidates: deterministicNewsCandidates(request.text, request.language, request.ontology),
    });
  }
}
export function defaultNewsExtractionConfig() {
  return NewsExtractionConfigSchema.parse({
    ontology: defaultNewsOntology(),
    maxRequests: 100,
    minIntervalMs: 0,
    timeoutMs: 5000,
    maxResponseBytes: 65536,
  });
}
function policyText(input: NewsExtractionInput) {
  const { article, source } = input,
    { version } = article,
    document = version.document;
  if (
    canonicalHash(version) !== article.versionHash ||
    canonicalHash(source) !== version.sourceHash ||
    version.sourceVersion !== source.version ||
    document.sourceId !== source.id ||
    document.contentHash !== version.contentHash ||
    (document.provenance.origin === 'FIXTURE') !== (source.accessMethod === 'FIXTURE') ||
    source.knownAt > input.dataCutoff ||
    allowedNewsArticle(document.canonicalUrl, source) !== document.canonicalUrl ||
    canonicalHash(document.licensing) !==
      canonicalHash({
        policy: source.licensing.policy,
        reference: source.licensing.reference,
        permitsSnippet: source.licensing.permitsSnippet,
      })
  )
    throw new Error('Input policy');
  if (input.field === 'TITLE') return document.title;
  if (
    !source.allowedFields.includes('snippet') ||
    !source.licensing.permitsSnippet ||
    !document.licensing.permitsSnippet ||
    document.approvedSnippet === undefined ||
    document.approvedSnippet.length > source.licensing.maxSnippetChars
  )
    throw new Error('Snippet policy');
  return document.approvedSnippet;
}
function canonicalClaim(
  candidate: NewsExtractionCandidate,
  input: NewsExtractionInput,
  processedAt: string,
  id: string,
  modelVersion: string,
) {
  const eligible =
    input.article.temporalClass === 'POINT_IN_TIME_VERIFIED' &&
    input.article.effectiveAvailableAt !== null &&
    input.article.effectiveAvailableAt <= input.dataCutoff &&
    !input.article.excluded;
  return EventClaimSchema.parse({
    schemaVersion: 'event-claim.v1',
    id,
    eventId: deterministicId('unclustered-event', id),
    predicate: candidate.predicate,
    subject: candidate.subject?.text ?? 'UNSPECIFIED',
    object: { status: 'KNOWN', value: canonicalJson(candidate) },
    confidence: {
      status: 'MISSING',
      reason: 'Extraction is unverified attribution; no calibrated factual probability.',
    },
    evidenceIds: [input.article.version.versionId],
    contradictionIds: [],
    verifiedStatus: 'UNVERIFIED',
    firstKnownAt: processedAt,
    lastUpdatedAt: processedAt,
    availableAt: eligible ? processedAt : null,
    availabilityBasis: eligible ? 'OBSERVED' : 'UNKNOWN',
    researchUse: eligible ? 'ELIGIBLE' : 'DESCRIPTIVE_ONLY',
    qualityFlags: [
      ...(input.article.version.document.provenance.origin === 'FIXTURE' ? ['SYNTHETIC'] : []),
      ...(candidate.unknownFields.length ? ['MISSING'] : []),
    ],
    provenance: {
      origin:
        input.article.version.document.provenance.origin === 'FIXTURE' ? 'FIXTURE' : 'DERIVED',
      sourceIds: [input.source.id],
      parentIds: [
        input.article.versionHash,
        input.article.version.captureHash,
        input.article.version.sourceHash,
      ],
      sourceVersion: modelVersion,
      capturedAt: processedAt,
      rawTimestamp: null,
    },
  });
}

/** Explicit finite session. Injected adapters have no tools/credentials supplied by this package. */
export class NewsClaimExtractor {
  readonly config: ReturnType<typeof NewsExtractionConfigSchema.parse>;
  readonly descriptor: ReturnType<typeof NewsExtractorDescriptorSchema.parse>;
  #requests = 0;
  #lastAt: bigint | null = null;
  #busy = false;
  #stopped = false;
  constructor(
    private readonly adapter: NewsClaimAdapter,
    config: unknown,
    private readonly clock: Clock,
    private readonly codeVersion: string,
  ) {
    this.config = NewsExtractionConfigSchema.parse(config);
    this.descriptor = NewsExtractorDescriptorSchema.parse(adapter.descriptor);
    if (
      this.descriptor.promptVersion !== newsExtractionPrompt.version ||
      (this.descriptor.kind === 'DETERMINISTIC' &&
        !(adapter instanceof DeterministicNewsClaimAdapter)) ||
      (this.descriptor.kind === 'INJECTED_STRUCTURED' && this.config.minIntervalMs < 1000)
    )
      throw new Error('Invalid adapter policy');
    deepFreeze(this.config);
    deepFreeze(this.descriptor);
  }
  async extract(inputValue: unknown): Promise<NewsExtractionResult> {
    const input = NewsExtractionInputSchema.parse(inputValue),
      startedAt = UtcTimestampSchema.parse(this.clock.now());
    deepFreeze(input);
    const reasons: NewsExtractionResult['reviewReasons'] = [];
    let responseHash: string | null = null,
      candidates: NewsExtractionCandidate[] = [],
      text = '';
    try {
      text = policyText(input);
    } catch {
      reasons.push('INPUT_POLICY');
    }
    if (
      this.descriptor.kind === 'INJECTED_STRUCTURED' &&
      input.article.version.document.provenance.origin !== 'FIXTURE'
    )
      reasons.push('INPUT_POLICY');
    if (
      input.article.version.processedAt > input.dataCutoff ||
      input.dataCutoff > startedAt ||
      input.article.excluded ||
      (input.article.effectiveAvailableAt !== null &&
        input.article.effectiveAvailableAt > input.dataCutoff)
    )
      reasons.push('FUTURE_OR_EXCLUDED');
    const language = input.article.version.document.language;
    if (!['en', 'ru'].includes(language)) reasons.push('UNSUPPORTED_LANGUAGE');
    if (instructionLikeNews(text)) reasons.push('INSTRUCTION_LIKE_TEXT');
    const now = utcNanoseconds(startedAt);
    if (
      reasons.length === 0 &&
      (this.#busy ||
        this.#stopped ||
        this.#requests >= this.config.maxRequests ||
        (this.#lastAt !== null &&
          now - this.#lastAt < BigInt(this.config.minIntervalMs) * 1000000n))
    )
      reasons.push('RATE_LIMIT');
    if (reasons.length === 0) {
      this.#requests++;
      this.#lastAt = now;
      this.#busy = true;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeout = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error('EXTRACTION_TIMEOUT'));
          }, this.config.timeoutMs);
        });
        const raw = await Promise.race([
          Promise.resolve().then(() =>
            this.adapter.extract(
              { text, language, ontology: this.config.ontology, prompt: newsExtractionPrompt },
              controller.signal,
            ),
          ),
          timeout,
        ]);
        let body: string;
        try {
          body = typeof raw === 'string' ? raw : canonicalJson(raw);
          if (Buffer.byteLength(body) > this.config.maxResponseBytes)
            throw new Error('Response limit');
          responseHash = canonicalHash(body);
          const response = NewsStructuredResponseSchema.parse(JSON.parse(body));
          if (response.candidates.length === 0) reasons.push('NO_CANDIDATES');
          else {
            const expected = deterministicNewsCandidates(text, language, this.config.ontology),
              hashes = response.candidates.map((c) => canonicalHash(c)).sort(),
              expectedHashes = expected.map((c) => canonicalHash(c)).sort();
            // Reconcile every field, exact offset, unit, polarity and omission against the supported grammar.
            if (
              new Set(hashes).size !== hashes.length ||
              canonicalHash(hashes) !== canonicalHash(expectedHashes)
            )
              reasons.push('UNGROUNDED_RESPONSE');
            else candidates = expected;
          }
        } catch {
          reasons.push('INVALID_RESPONSE');
        }
      } catch (error) {
        if (error instanceof Error && error.message === 'EXTRACTION_TIMEOUT') this.#stopped = true;
        reasons.push(
          error instanceof Error && error.message === 'EXTRACTION_TIMEOUT'
            ? 'TIMEOUT'
            : 'ADAPTER_ERROR',
        );
      } finally {
        if (timer) clearTimeout(timer);
        this.#busy = false;
      }
    }
    const processedAt = UtcTimestampSchema.parse(this.clock.now());
    if (processedAt < startedAt) throw new Error('Extraction clock regressed');
    if (candidates.some((c) => c.unknownFields.length > 0)) reasons.push('AMBIGUOUS_FIELDS');
    const configHash = canonicalHash({
      config: this.config,
      adapter: this.descriptor,
      prompt: newsExtractionPrompt,
    });
    const claims = candidates.map((candidate) => {
      const id = deterministicId('extracted-claim', {
        inputHash: canonicalHash(input),
        configHash,
        candidate,
        processedAt,
      });
      return {
        id,
        candidate,
        canonical: canonicalClaim(candidate, input, processedAt, id, this.descriptor.modelVersion),
      };
    });
    const result = NewsExtractionResultSchema.parse({
      schemaVersion: 'news-extraction-result.v1',
      execution: 'DISABLED',
      input,
      inputHash: canonicalHash(input),
      config: this.config,
      configHash,
      ontologyHash: canonicalHash(this.config.ontology),
      promptHash: canonicalHash(newsExtractionPrompt),
      adapter: this.descriptor,
      codeVersion: this.codeVersion,
      randomSeed: 0,
      offsetUnit: 'UTF16_CODE_UNIT',
      startedAt,
      processedAt,
      responseHash,
      status: reasons.length ? 'REVIEW_NEEDED' : 'EXTRACTED',
      reviewReasons: reasons,
      claims,
      cost:
        this.descriptor.kind === 'DETERMINISTIC'
          ? { status: 'ZERO_EXTERNAL_COST', amount: '0', currency: 'USD' }
          : { status: 'UNKNOWN', amount: null, currency: 'USD' },
    });
    deepFreeze(result);
    return result;
  }
}
export function extractedNewsClaimsAt(resultInput: unknown, decisionInput: unknown) {
  const result = validateNewsExtractionResult(resultInput),
    decisionAt = UtcTimestampSchema.parse(decisionInput);
  return result.claims.filter((c) => isAvailableAt(c.canonical, decisionAt));
}
export function validateNewsExtractionResult(input: unknown) {
  const result = NewsExtractionResultSchema.parse(input),
    configHash = canonicalHash({
      config: result.config,
      adapter: result.adapter,
      prompt: newsExtractionPrompt,
    });
  if (
    result.inputHash !== canonicalHash(result.input) ||
    result.configHash !== configHash ||
    result.ontologyHash !== canonicalHash(result.config.ontology) ||
    result.promptHash !== canonicalHash(newsExtractionPrompt)
  )
    throw new Error('Extraction integrity');
  let text: string;
  try {
    text = policyText(result.input);
  } catch (error) {
    if (result.claims.length === 0 && result.reviewReasons.includes('INPUT_POLICY')) return result;
    throw error;
  }
  const expected = deterministicNewsCandidates(
    text,
    result.input.article.version.document.language,
    result.config.ontology,
  );
  if (
    result.claims.length > 0 &&
    result.adapter.kind === 'INJECTED_STRUCTURED' &&
    result.input.article.version.document.provenance.origin !== 'FIXTURE'
  )
    throw new Error('Structured adapter source policy');
  for (const claim of result.claims) {
    const id = deterministicId('extracted-claim', {
      inputHash: result.inputHash,
      configHash,
      candidate: claim.candidate,
      processedAt: result.processedAt,
    });
    if (
      id !== claim.id ||
      !expected.some((c) => canonicalHash(c) === canonicalHash(claim.candidate)) ||
      canonicalHash(claim.canonical) !==
        canonicalHash(
          canonicalClaim(
            claim.candidate,
            result.input,
            result.processedAt,
            id,
            result.adapter.modelVersion,
          ),
        )
    )
      throw new Error('Extraction claim integrity');
  }
  deepFreeze(result);
  return result;
}
