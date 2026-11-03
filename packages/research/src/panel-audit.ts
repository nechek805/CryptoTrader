import { PanelFeatureAuditInputSchema, MarketBarSchema } from '@crypto/contracts';
import type { PanelLeakageIssue, MarketBar } from '@crypto/contracts';
import { canonicalHash } from '@crypto/core';

/** Audit untrusted candidates too; only semantically rebuilt registered sources may train. */
export function auditDatasetFeatures(
  input: unknown,
  evidence: readonly unknown[],
  proposalsOnly = false,
): PanelLeakageIssue[] {
  const rows = Array.isArray(input)
      ? input.map((r) => PanelFeatureAuditInputSchema.parse(r))
      : [PanelFeatureAuditInputSchema.parse(input)],
    bars = new Map<string, MarketBar>(),
    issues: PanelLeakageIssue[] = [];
  for (const raw of evidence) {
    const b = MarketBarSchema.parse(raw),
      old = bars.get(b.id);
    if (old && canonicalHash(old) !== canonicalHash(b))
      throw new Error('Conflicting audit evidence');
    bars.set(b.id, b);
  }
  for (const row of rows)
    for (const f of row.features) {
      const add = (reason: PanelLeakageIssue['reason']) =>
        issues.push({
          instrumentKey: row.instrumentKey,
          featureAsOf: row.featureAsOf,
          feature: f.name,
          reason,
        });
      if (f.dependency === 'LABEL') add('LABEL_DEPENDENCY');
      if (proposalsOnly || f.sourceKind === 'PROPOSED') add('UNREGISTERED_SOURCE');
      const inputs = f.inputBarIds.map((id) => bars.get(id));
      if (inputs.some((b) => b === undefined)) add('UNKNOWN_EVIDENCE');
      const known = inputs.filter((b): b is MarketBar => b !== undefined);
      if (
        (f.maxInputAvailableAt !== null && f.maxInputAvailableAt > row.featureAsOf) ||
        (f.maxInputEventAt !== null && f.maxInputEventAt > row.featureAsOf) ||
        known.some(
          (b) =>
            b.availableAt === null ||
            b.availableAt > row.featureAsOf ||
            b.closeAt > row.featureAsOf,
        )
      )
        add('FUTURE_INPUT');
      if (
        known.some(
          (b) =>
            f.maxInputAvailableAt === null ||
            (b.availableAt !== null && b.availableAt > f.maxInputAvailableAt) ||
            f.maxInputEventAt === null ||
            b.closeAt > f.maxInputEventAt,
        )
      )
        add('WATERMARK_UNDERSTATED');
    }
  return issues;
}
