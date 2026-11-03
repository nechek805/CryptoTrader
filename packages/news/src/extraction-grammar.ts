import {
  DecimalStringSchema,
  NewsExtractionCandidateSchema,
  NewsOntologySchema,
  UtcTimestampSchema,
} from '@crypto/contracts';
import type { NewsExtractionCandidate, NewsOntology } from '@crypto/contracts';
import { canonicalHash } from '@crypto/core';

export function instructionLikeNews(text: string) {
  return /ignore\s+(?:all|previous|prior)|system\s*:|developer\s*:|<\/?(?:script|system|tool)\b|reveal\s+(?:secrets|keys)|игнорируй\s+инструкции/iu.test(
    text,
  );
}
function span(text: string, start: number, end: number) {
  return { start, end, text: text.slice(start, end) };
}
function occurrences(text: string, needle: string) {
  const rows: number[] = [],
    escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const match of text.matchAll(new RegExp(escaped, 'giu'))) {
    const at = match.index;
    const word = (s: string) => /[\p{L}\p{N}_]/u.test(s);
    if (!word(text[at - 1] ?? '') && !word(text[at + needle.length] ?? '')) rows.push(at);
  }
  return rows;
}
function amounts(text: string, start: number, end: number, ontology: NewsOntology) {
  const rows: NewsExtractionCandidate['amounts'] = [],
    section = text.slice(start, end);
  const pattern =
    /(?:[$€£]\s*[+-]?\d[\d,.]*|(?<![\p{L}\p{N}.,])[+-]?\d[\d,.]*(?:\s+(?:million|billion|миллион[а-я]*))?\s*(?:[A-Z]{2,10}|%))(?![\p{L}\p{N}])/gu;
  for (const match of section.matchAll(pattern)) {
    const evidence = span(text, start + match.index, start + match.index + match[0].length),
      simple = /^([+-]?\d+(?:\.\d+)?)\s*([A-Z]{2,10}|%)$/.exec(match[0]),
      token = /([A-Z]{2,10}|%)$/.exec(match[0])?.[1],
      unit = ontology.units.find((u) => u.symbol === token);
    const value = simple ? DecimalStringSchema.safeParse(simple[1]) : null;
    rows.push({
      evidence,
      value: value?.success && (unit || simple?.[2] === '%') ? value.data : null,
      unit: unit?.symbol ?? (simple?.[2] === '%' ? 'PERCENT' : null),
      kind: unit?.kind ?? (simple?.[2] === '%' ? 'PERCENT' : 'UNKNOWN'),
    });
  }
  return rows;
}
function eventTime(text: string, start: number, end: number): NewsExtractionCandidate['eventTime'] {
  const matches = [
    ...text
      .slice(start, end)
      .matchAll(
        /(?:^|\s)(?:on|at|in|на|в)\s+(\d{4}(?:-\d{2}(?:-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?Z)?)?)?)(?![\d-])(?=$|[\s.!?;])/giu,
      ),
  ];
  if (matches.length !== 1) return { evidence: null, granularity: 'UNKNOWN', at: null };
  const found = matches[0]!,
    raw = found[1]!,
    at = start + found.index + found[0].lastIndexOf(raw),
    evidence = span(text, at, at + raw.length);
  if (raw.length === 4 && /^\s+[A-Z]{2,10}\b/.test(text.slice(evidence.end, end)))
    return { evidence: null, granularity: 'UNKNOWN', at: null };
  if (raw.includes('T')) {
    const full = raw.length === 17 ? raw.replace('Z', ':00Z') : raw,
      parsed = UtcTimestampSchema.safeParse(full);
    if (parsed.success)
      return { evidence, granularity: raw.length === 17 ? 'MINUTE' : 'SECOND', at: parsed.data };
  } else {
    const full = raw.length === 4 ? `${raw}-01-01` : raw.length === 7 ? `${raw}-01` : raw;
    if (UtcTimestampSchema.safeParse(`${full}T00:00:00Z`).success)
      return {
        evidence,
        granularity: raw.length === 4 ? 'YEAR' : raw.length === 7 ? 'MONTH' : 'DAY',
        at: null,
      };
  }
  return { evidence, granularity: 'UNKNOWN', at: null };
}

/** Deliberately bounded literal grammar. No general language-understanding claim. */
export function deterministicNewsCandidates(text: string, language: string, config: unknown) {
  const ontology = NewsOntologySchema.parse(config);
  if (!['en', 'ru'].includes(language) || text.length > 1500 || instructionLikeNews(text))
    return [];
  const result: NewsExtractionCandidate[] = [];
  // Split only at sentence punctuation followed by whitespace/end; decimal points are preserved.
  const sentences: { index: number; text: string }[] = [];
  let from = 0;
  for (const delimiter of text.matchAll(/[.!?;](?=\s|$)|\n/g)) {
    const end = delimiter.index + delimiter[0].length;
    sentences.push({ index: from, text: text.slice(from, end) });
    from = end;
  }
  if (from < text.length) sentences.push({ index: from, text: text.slice(from) });
  for (const sentence of sentences) {
    const left = sentence.index + (sentence.text.length - sentence.text.trimStart().length),
      right = sentence.index + sentence.text.trimEnd().length,
      statement = text.slice(left, right);
    const triggers = ontology.events.flatMap((event) =>
      event.triggers
        .filter((t) => t.language === language)
        .flatMap((t) =>
          occurrences(statement, t.text).map((at) => ({ event, at: left + at, phrase: t.text })),
        ),
    );
    if (triggers.length !== 1) continue; // Mixed events/ambiguous aliases need review instead of guessed attribution.
    const trigger = triggers[0]!,
      entities = ontology.entities.flatMap((entity) =>
        entity.aliases.flatMap((alias) =>
          occurrences(statement, alias).map((at) => ({
            name: entity.name,
            kind: entity.kind,
            evidence: span(text, left + at, left + at + alias.length),
          })),
        ),
      );
    const uniqueEntities = [...new Map(entities.map((e) => [canonicalHash(e), e])).values()].sort(
      (a, b) => a.evidence.start - b.evidence.start,
    );
    const subjects = uniqueEntities.filter(
      (e) => e.kind !== 'ASSET' && e.evidence.end <= trigger.at,
    );
    const negative =
        /\b(?:not|never|no|denied|denies|without)\b|(?<!\p{L})(?:не|нет|отрицает|без)(?!\p{L})/iu.test(
          statement,
        ),
      uncertain =
        /\b(?:may|might|could|reportedly|rumor|alleged|if|whether)\b|(?<!\p{L})(?:возможно|слух|если)(?!\p{L})|[?"«»]/iu.test(
          statement,
        );
    const polarity = uncertain ? 'UNCERTAIN' : negative ? 'NEGATED' : 'AFFIRMED',
      extractedAmounts = amounts(text, left, right, ontology),
      time = eventTime(text, left, right),
      assets = ontology.entities
        .filter((e) => e.asset !== null)
        .flatMap((entity) =>
          uniqueEntities
            .filter((e) => e.name === entity.name)
            .map((e) => ({
              symbol: entity.asset!,
              relationship: 'MENTIONED' as const,
              evidence: e.evidence,
            })),
        );
    const unknownFields: NewsExtractionCandidate['unknownFields'] = [];
    if (subjects.length !== 1) unknownFields.push('SUBJECT');
    if (
      extractedAmounts.length === 0 ||
      extractedAmounts.some((a) => a.value === null || a.unit === null)
    )
      unknownFields.push('AMOUNT');
    if (time.granularity === 'UNKNOWN') unknownFields.push('EVENT_TIME');
    if (assets.length === 0) unknownFields.push('ASSETS');
    if (uniqueEntities.length === 0) unknownFields.push('ENTITIES');
    if (polarity === 'UNCERTAIN') unknownFields.push('POLARITY');
    result.push(
      NewsExtractionCandidateSchema.parse({
        eventType: trigger.event.type,
        predicate: trigger.event.predicate,
        language,
        evidence: span(text, left, right),
        trigger: span(text, trigger.at, trigger.at + trigger.phrase.length),
        subject: subjects.length === 1 ? subjects[0]!.evidence : null,
        polarity,
        amounts: extractedAmounts,
        eventTime: time,
        entities: uniqueEntities,
        affectedAssets: assets,
        unknownFields,
      }),
    );
  }
  return result;
}
