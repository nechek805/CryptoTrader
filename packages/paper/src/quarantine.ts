import { PaperEventSchema, UtcTimestampSchema } from '@crypto/contracts';
import type { PaperEvent } from '@crypto/contracts';
import { canonicalHash, deterministicId } from '@crypto/core';

/** Malformed external data is a content-free safety record, never an instruction or a command. */
export function quarantinePaperMarketInput(
  input: unknown,
  receivedAt: string,
  sourceId: string,
): PaperEvent {
  const at = UtcTimestampSchema.parse(receivedAt),
    parsed = PaperEventSchema.safeParse(input);
  if (parsed.success && (parsed.data.kind === 'QUOTE' || parsed.data.kind === 'TRADE'))
    return PaperEventSchema.parse({ ...parsed.data, at });
  let rawHash: string | null = null;
  try {
    rawHash = canonicalHash(input);
  } catch {
    /* Non-JSON input has no defensible content hash. */
  }
  return PaperEventSchema.parse({
    kind: 'SAFETY',
    id: deterministicId('paper-quarantine', { at, sourceId, rawHash }),
    at,
    code: 'QUARANTINED_FEED',
    sourceId,
    rawHash,
  });
}
