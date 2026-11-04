/** Detached Module 16 experiment. No imports from connectors, strategies, paper or apps. */
import { z } from 'zod';
import { canonicalHash } from '@crypto/core';
import { HashSchema, IdSchema, UtcTimestampSchema } from '@crypto/contracts';

const Alias = z.strictObject({
  id: IdSchema,
  symbol: z.enum(['BTC', 'ETH', 'SOL', 'SYN']),
  term: z.string().trim().min(2).max(100),
  knownAt: UtcTimestampSchema,
});
const Article = z.strictObject({
  id: IdSchema,
  sourceId: IdSchema,
  version: IdSchema,
  availableAt: UtcTimestampSchema,
  text: z.string().min(1).max(2000),
});
export const EntityPrototypeInputSchema = z.strictObject({
  schemaVersion: z.literal('entity-prototype-input.v1'),
  origin: z.literal('SYNTHETIC'),
  execution: z.literal('DISABLED'),
  decisionAt: UtcTimestampSchema,
  aliases: z.array(Alias).min(1).max(32),
  articles: z.array(Article).min(1).max(32),
});
const Occurrence = z.strictObject({
  articleId: IdSchema,
  sourceId: IdSchema,
  articleVersion: IdSchema,
  articleHash: HashSchema,
  aliasIds: z.array(IdSchema),
  aliasHash: HashSchema,
  symbols: z.array(z.enum(['BTC', 'ETH', 'SOL', 'SYN'])),
  status: z.enum(['MATCHED', 'AMBIGUOUS_ABSTENTION', 'NO_MATCH', 'NOT_YET_AVAILABLE']),
});
export const EntityPrototypeResultSchema = z.strictObject({
  schemaVersion: z.literal('entity-prototype-result.v1'),
  origin: z.literal('SYNTHETIC'),
  execution: z.literal('DISABLED'),
  interpretation: z.literal('TEXT_ENTITY_CANDIDATES_NOT_FACTUAL_TRUTH_CAUSALITY_OR_ALPHA'),
  inputHash: HashSchema,
  algorithm: z.literal('NFKC_CASE_TOKEN_ALIAS_ASOF.v1'),
  rows: z.array(Occurrence).max(32),
  hash: HashSchema,
});
const normalize = (value: string) => value.normalize('NFKC').toLowerCase();
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function matchSourceEntities(input: unknown) {
  const p = EntityPrototypeInputSchema.parse(input);
  if (
    new Set(p.aliases.map((a) => a.id)).size !== p.aliases.length ||
    new Set(p.articles.map((a) => a.id)).size !== p.articles.length
  )
    throw new Error('Duplicate prototype identity');
  const aliases = p.aliases.filter((a) => a.knownAt <= p.decisionAt),
    aliasHash = canonicalHash(aliases),
    rows = p.articles.map((article) => {
      const unavailable = article.availableAt > p.decisionAt,
        text = normalize(article.text),
        matched = unavailable
          ? []
          : aliases.filter((a) =>
              new RegExp(
                `(^|[^\\p{L}\\p{N}])${escape(normalize(a.term))}(?=$|[^\\p{L}\\p{N}])`,
                'u',
              ).test(text),
            ),
        ambiguous = matched.some(
          (a) =>
            new Set(
              aliases.filter((b) => normalize(b.term) === normalize(a.term)).map((b) => b.symbol),
            ).size > 1,
        );
      return {
        articleId: article.id,
        sourceId: article.sourceId,
        articleVersion: article.version,
        articleHash: canonicalHash(article),
        aliasIds: matched.map((a) => a.id),
        aliasHash,
        symbols: ambiguous ? [] : [...new Set(matched.map((a) => a.symbol))].sort(),
        status: unavailable
          ? 'NOT_YET_AVAILABLE'
          : ambiguous
            ? 'AMBIGUOUS_ABSTENTION'
            : matched.length
              ? 'MATCHED'
              : 'NO_MATCH',
      };
    }),
    body = {
      schemaVersion: 'entity-prototype-result.v1',
      origin: 'SYNTHETIC',
      execution: 'DISABLED',
      interpretation: 'TEXT_ENTITY_CANDIDATES_NOT_FACTUAL_TRUTH_CAUSALITY_OR_ALPHA',
      inputHash: canonicalHash(p),
      algorithm: 'NFKC_CASE_TOKEN_ALIAS_ASOF.v1',
      rows,
    };
  return EntityPrototypeResultSchema.parse({ ...body, hash: canonicalHash(body) });
}
export function evaluateEntityPrototype(input: unknown, labelsInput: unknown) {
  const result = matchSourceEntities(input),
    labels = z
      .array(
        z.strictObject({
          articleId: IdSchema,
          symbols: z.array(z.enum(['BTC', 'ETH', 'SOL', 'SYN'])),
        }),
      )
      .parse(labelsInput);
  if (
    new Set(labels.map((l) => l.articleId)).size !== labels.length ||
    labels.length !== result.rows.length ||
    labels.some((l) => !result.rows.some((r) => r.articleId === l.articleId))
  )
    throw new Error('Unmatched prototype labels');
  let truePositive = 0,
    falsePositive = 0,
    falseNegative = 0;
  for (const row of result.rows) {
    const expected = labels.find((l) => l.articleId === row.articleId)!.symbols;
    for (const s of row.symbols)
      if (expected.includes(s)) truePositive++;
      else falsePositive++;
    for (const s of expected) if (!row.symbols.includes(s)) falseNegative++;
  }
  const body = {
    schemaVersion: 'entity-prototype-evaluation.v1',
    origin: 'SYNTHETIC',
    execution: 'DISABLED',
    inputHash: result.inputHash,
    resultHash: result.hash,
    labelsHash: canonicalHash(labels),
    result,
    truePositive,
    falsePositive,
    falseNegative,
    precision: truePositive + falsePositive ? truePositive / (truePositive + falsePositive) : null,
    recall: truePositive + falseNegative ? truePositive / (truePositive + falseNegative) : null,
    decision: 'DEFER',
    reason:
      'SYNTHETIC_HAND_AUTHORED_LABELS_COMMON_NOUN_AND_COMPANY_FALSE_POSITIVES_NO_EXTERNAL_VALIDATION',
    changesToCurrentProtocol: 'NONE',
    realMoneyAuthorized: false,
  };
  return { ...body, hash: canonicalHash(body) };
}
