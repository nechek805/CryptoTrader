import { DatasetPanelManifestSchema } from '@crypto/contracts';
import { canonicalHash } from '@crypto/core';
import { validateDatasetPanelArtifact } from './panel-storage.js';

export function datasetPanelReport(input: unknown, manifestInput?: unknown) {
  const a = validateDatasetPanelArtifact(input),
    m = manifestInput === undefined ? undefined : DatasetPanelManifestSchema.parse(manifestInput),
    safe = (s: string) => s.replaceAll('|', '\\|').replaceAll('\n', ' '),
    lines = [
      '# Dataset panel research handoff',
      '',
      `Execution: DISABLED. Artifact: ${canonicalHash(a)}.`,
      `Input: ${a.inputHash}. Config: ${a.configHash}. Software: ${a.codeVersion}.`,
      '',
      'Predictors use only inputs available at featureAsOf. Forward gross-return labels are separate targets; no costs, fills or trading performance are modeled.',
      `Label freeze: ${a.request.labelsAsOf}; per-close publication lag: ${a.request.labelPublicationLagSeconds}s. Seed: 0.`,
      `Global boundary-touch purge across all symbols/groups; post-boundary embargo: ${a.request.embargoSeconds}s.`,
      `Candidates ${a.audit.candidateCount}; included ${a.audit.includedCount}; purged ${a.audit.purgedCount}; embargoed ${a.audit.embargoedCount}; quarantined ${a.audit.quarantinedCount}; outside splits ${a.audit.outsideSplitCount}.`,
      '',
      '## Training sample manifest',
      '',
      '| Split | Candidates | Included |',
      '| --- | ---: | ---: |',
      ...a.audit.splits.map((s) => `| ${s.split} | ${s.candidates} | ${s.included} |`),
      ...(m
        ? [
            '',
            `Directory: ${m.id}. Writer: ${m.writer}. Rows: ${m.rowCount}.`,
            `Parquet: ${m.parquetHash}. Rows: ${m.rowsHash}.`,
          ]
        : []),
      '',
      '## Feature catalog and missingness',
      '',
      '| Column | Definition | Missing / candidates |',
      '| --- | --- | ---: |',
      ...a.featureCatalog.map(
        (c) =>
          `| ${safe(c.name)} | ${c.definitionHash} | ${a.audit.missingness.find((v) => v.column === c.name)!.missing} / ${a.audit.candidateCount} |`,
      ),
      '',
      'All features require historical availability; computation/publication latency is unmodeled. Warm-up, absent BTC, book coverage, unknown listing/group history and unavailable derivatives prevent real-time use at those times. Spot open interest is not applicable. Unknown values stay null; null is not zero.',
      '',
      '## Leakage and duplicates',
      '',
      `Proposals are AUDIT ONLY and never enter predictor columns. ${a.audit.leakage.length} issues; ${a.audit.duplicates.length} duplicate/conflict entries.`,
      ...a.audit.leakage.map(
        (v) => `- ${safe(v.instrumentKey)} ${v.featureAsOf} ${safe(v.feature)}: ${v.reason}`,
      ),
      ...a.audit.duplicates.map((v) => `- ${v.kind}: ${safe(v.id)}`),
      '',
      '## Survivorship and source coverage',
      '',
      safe(a.audit.survivorship.disclosure),
      `Policy: ${a.audit.survivorship.policy}; scope: ${a.audit.survivorship.scope}.`,
      '',
      '| Instrument | Candidates | Included | Metadata rejected | Missing labels |',
      '| --- | ---: | ---: | ---: | ---: |',
      ...a.audit.survivorship.coverage.map(
        (v) =>
          `| ${safe(v.instrumentKey)} | ${v.candidateRows} | ${v.includedRows} | ${v.metadataRejected} | ${v.missingLabels} |`,
      ),
      '',
      ...a.input.market.sources.map(
        (s) => `- ${safe(s.id)}: ${s.origin}; license ${safe(s.license)}; ${safe(s.reference)}`,
      ),
      '',
      'This explicit cohort cannot establish full historical-market coverage or remove selection bias. Missing future prices/delistings are reported, never converted to zero returns. Hashes establish local consistency, not provider authenticity.',
      '',
      'Handoff to Modules 09/11: consume the manifest and ordered feature catalog with readDatasetPanel; request supervised labels explicitly. Fit preprocessing on TRAIN only. No model, imputation, normalization, strategy or Python worker is implemented.',
      '',
    ];
  if (m && m.artifactHash !== canonicalHash(a)) throw new Error('Report manifest mismatch');
  return lines.join('\n');
}
