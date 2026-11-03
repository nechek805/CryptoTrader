import {
  HypothesisCardSchema,
  HypothesisCardRevisionRequestSchema,
  UtcTimestampSchema,
} from '@crypto/contracts';
import type { HypothesisCard } from '@crypto/contracts';
import { canonicalHash, deepFreeze } from '@crypto/core';

export function validateHypothesisCards(input: readonly unknown[]) {
  if (!input.length || input.length > 100) throw new Error('Invalid card history size');
  const heads = new Map<string, HypothesisCard>(),
    cards: HypothesisCard[] = [];
  let at = '';
  for (const raw of input) {
    const card = HypothesisCardSchema.parse(raw),
      { hash, ...body } = card,
      old = heads.get(card.content.id);
    if (
      canonicalHash(body) !== hash ||
      card.revision !== (old?.revision ?? 0) + 1 ||
      card.previousHash !== (old?.hash ?? null) ||
      card.recordedAt < at
    )
      throw new Error('Hypothesis card history integrity mismatch');
    heads.set(card.content.id, card);
    cards.push(card);
    at = card.recordedAt;
  }
  deepFreeze(cards);
  return cards;
}
export function appendHypothesisCard(
  history: readonly unknown[],
  requestInput: unknown,
  recordedInput: unknown,
) {
  const cards = history.length ? validateHypothesisCards(history) : [],
    request = HypothesisCardRevisionRequestSchema.parse(requestInput),
    recordedAt = UtcTimestampSchema.parse(recordedInput),
    old = cards.findLast((c) => c.content.id === request.content.id);
  if (
    request.expectedPreviousHash !== (old?.hash ?? null) ||
    recordedAt < (cards.at(-1)?.recordedAt ?? '')
  )
    throw new Error('Stale card revision or recording clock');
  const body = {
      schemaVersion: 'hypothesis-card.v1' as const,
      revision: (old?.revision ?? 0) + 1,
      previousHash: old?.hash ?? null,
      recordedAt,
      author: request.author,
      reason: request.reason,
      content: request.content,
    },
    card = HypothesisCardSchema.parse({ ...body, hash: canonicalHash(body) });
  deepFreeze(card);
  return card;
}
