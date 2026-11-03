import {
  DatasetPanelInputSchema,
  DatasetPanelRequestSchema,
  DatasetPanelRowSchema,
  DatasetPanelArtifactSchema,
  utcNanoseconds,
} from '@crypto/contracts';
import type { DatasetPanelRow, DatasetSplit, DatasetPanelRequest } from '@crypto/contracts';
import { canonicalHash, deepFreeze, deterministicId, fromEpoch } from '@crypto/core';
import { panelSources } from './panel-sources.js';
import { PanelEvidence } from './panel-evidence.js';
import { auditDatasetFeatures } from './panel-audit.js';

const max = <T extends string>(v: T[]): T | null =>
  v.length ? v.reduce((a, b) => (a > b ? a : b)) : null;
export function buildDatasetPanel(input: unknown, requestInput: unknown, codeVersion: string) {
  const parsed = DatasetPanelInputSchema.parse(input),
    request = DatasetPanelRequestSchema.parse(requestInput);
  if (
    parsed.technicalArtifacts.some(
      (a) =>
        a.request.intervalSeconds !== request.intervalSeconds ||
        a.request.generatedAt > request.generatedAt,
    ) ||
    parsed.crossArtifacts.some(
      (a) =>
        a.request.intervalSeconds !== request.intervalSeconds ||
        a.request.generatedAt > request.generatedAt,
    )
  )
    throw new Error('Incompatible source interval or generation time');
  const sources = panelSources(parsed, request.columns),
    evidence = new PanelEvidence(parsed, sources.bars),
    candidates = sources.rows.filter((r) => request.instrumentKeys.includes(r.instrumentKey));
  if (
    candidates.length > 10000 ||
    candidates.length * request.horizonsBars.reduce((n, h) => n + h, 0) > 250000
  )
    throw new Error('Panel label work budget exceeded');
  const cells = candidates.map((c) => ({
      instrumentKey: c.instrumentKey,
      featureAsOf: c.featureAsOf,
      features: request.columns.map(
        (name) =>
          c.features.get(name) ?? {
            name,
            value: null,
            status: 'MISSING_SOURCE',
            definitionHash: [...sources.definitions.get(name)!.hashes][0]!,
            sourceKind: name.startsWith('technical.') ? ('TECHNICAL' as const) : ('CROSS' as const),
            dependency: 'MARKET' as const,
            sourceHashes: [],
            inputBarIds: [],
            maxInputAvailableAt: null,
            maxInputEventAt: null,
          },
      ),
    })),
    registeredIssues = auditDatasetFeatures(cells, [...sources.bars.values()]),
    leakage = [
      ...registeredIssues,
      ...auditDatasetFeatures(parsed.proposedFeatures, [...sources.bars.values()], true),
    ],
    splits: [
      DatasetSplit,
      {
        from: DatasetPanelRequest['splits']['train']['from'];
        to: DatasetPanelRequest['splits']['train']['to'];
      },
    ][] = [
      ['TRAIN', request.splits.train],
      ['VALIDATION', request.splits.validation],
      ['TEST', request.splits.test],
    ];
  const rows: DatasetPanelRow[] = candidates.map((c, index) => {
    const binding = evidence.binding(c.instrumentKey),
      m = binding ? evidence.metadata(binding, c.featureAsOf, c.featureAsOf) : null,
      group = evidence.group(c.instrumentKey, c.featureAsOf),
      features = cells[index]!.features,
      split = splits.find(([, p]) => p.from <= c.featureAsOf && c.featureAsOf < p.to)?.[0] ?? null,
      reasons: string[] = [];
    if (
      !binding ||
      !m ||
      m.listedAt > c.featureAsOf ||
      (m.delistedAt !== null && m.delistedAt <= c.featureAsOf) ||
      (binding && !evidence.matches(binding, m))
    )
      reasons.push('HISTORICAL_METADATA_UNAVAILABLE');
    if (!group) reasons.push('GROUP_METADATA_UNAVAILABLE');
    if (c.featureAsOf > request.labelsAsOf) reasons.push('FEATURE_AFTER_LABEL_FREEZE');
    if (c.conflict || request.columns.some((name) => sources.inconsistent.has(name)))
      reasons.push('CONFLICTING_FEATURE_DEFINITION');
    if (request.membership === 'POINT_IN_TIME_LIQUID' && c.crossMembership !== true)
      reasons.push(
        c.crossMembership === null ? 'UNIVERSE_UNAVAILABLE' : 'NOT_IN_POINT_IN_TIME_UNIVERSE',
      );
    const actualIssues = registeredIssues.filter(
      (l) => l.instrumentKey === c.instrumentKey && l.featureAsOf === c.featureAsOf,
    );
    if (actualIssues.length) reasons.push('FEATURE_LEAKAGE');
    const metadataIds = new Set<string>(m ? [m.id] : []);
    for (const f of features.filter((f) => f.sourceKind === 'TECHNICAL'))
      for (const id of f.inputBarIds) {
        const bar = sources.bars.get(id),
          meta = binding && bar ? evidence.validBar(binding, bar, c.featureAsOf) : null;
        if (!meta) {
          if (!reasons.includes('HISTORICAL_INPUT_METADATA'))
            reasons.push('HISTORICAL_INPUT_METADATA');
        } else metadataIds.add(meta.id);
      }
    if (request.missingPolicy === 'DROP_ROW' && features.some((f) => f.value === null))
      reasons.push('MISSING_FEATURE');
    const labels = evidence.labels(binding, c.startBarId, c.featureAsOf, request),
      labelMissing = labels.some((l) => l.status !== 'READY'),
      boundary =
        split === 'TRAIN'
          ? request.splits.validation.from
          : split === 'VALIDATION'
            ? request.splits.test.from
            : null,
      purge =
        boundary !== null &&
        labels.some(
          (l) =>
            (l.endAt !== null && l.endAt >= boundary) ||
            (l.decisionAt !== null && l.decisionAt >= boundary) ||
            (l.availableAt !== null && l.availableAt >= boundary),
        ),
      phase =
        split === 'VALIDATION'
          ? request.splits.validation
          : split === 'TEST'
            ? request.splits.test
            : null,
      embargo =
        phase !== null &&
        c.featureAsOf <
          fromEpoch(
            utcNanoseconds(phase.from) + BigInt(request.embargoSeconds) * 1000000000n,
            'nanoseconds',
          );
    let status: DatasetPanelRow['status'] = reasons.length
      ? 'QUARANTINED'
      : split === null
        ? 'OUTSIDE_SPLITS'
        : purge
          ? 'PURGED'
          : embargo
            ? 'EMBARGOED'
            : labelMissing
              ? 'QUARANTINED'
              : 'INCLUDED';
    if (purge && status === 'PURGED') reasons.push('LABEL_SUPPORT_TOUCHES_HOLDOUT');
    if (embargo && status === 'EMBARGOED') reasons.push('POST_BOUNDARY_EMBARGO');
    if (labelMissing) reasons.push('MISSING_LABEL');
    const featureMeta = parsed.market.instruments.filter((m) => metadataIds.has(m.id)),
      available = [
        ...features.flatMap((f) => (f.maxInputAvailableAt === null ? [] : [f.maxInputAvailableAt])),
        ...featureMeta.flatMap((m) => (m.availableAt === null ? [] : [m.availableAt])),
        ...(group?.availableAt ? [group.availableAt] : []),
      ],
      events = [
        ...features.flatMap((f) => (f.maxInputEventAt === null ? [] : [f.maxInputEventAt])),
        ...featureMeta.map((m) => m.observedAt),
        ...(group ? [group.observedAt] : []),
      ];
    if (status === 'INCLUDED' && max(available) === null) {
      status = 'QUARANTINED';
      reasons.push('NO_FEATURE_EVIDENCE');
    }
    return DatasetPanelRowSchema.parse({
      schemaVersion: 'dataset-panel-row.v1',
      id: deterministicId('dataset-row', {
        instrumentKey: c.instrumentKey,
        featureAsOf: c.featureAsOf,
      }),
      instrumentKey: c.instrumentKey,
      sourceId: binding?.sourceId ?? 'unbound',
      symbol: binding?.series.instrumentId ?? 'UNKNOWN/UNKNOWN',
      groupId: group?.groupId ?? null,
      groupRevisionId: group?.id ?? null,
      featureAsOf: c.featureAsOf,
      split,
      status,
      reasons,
      features,
      labels,
      sourceHashes: [...c.sourceHashes].sort(),
      inputMetadataIds: [...metadataIds].sort(),
      maxInputAvailableAt: max(available),
      maxInputEventAt: max(events),
    });
  });
  const audit = {
    candidateCount: rows.length,
    includedCount: rows.filter((r) => r.status === 'INCLUDED').length,
    purgedCount: rows.filter((r) => r.status === 'PURGED').length,
    embargoedCount: rows.filter((r) => r.status === 'EMBARGOED').length,
    quarantinedCount: rows.filter((r) => r.status === 'QUARANTINED').length,
    outsideSplitCount: rows.filter((r) => r.status === 'OUTSIDE_SPLITS').length,
    splits: splits.map(([split]) => ({
      split,
      candidates: rows.filter((r) => r.split === split).length,
      included: rows.filter((r) => r.split === split && r.status === 'INCLUDED').length,
    })),
    missingness: request.columns.map((column) => {
      const values = rows.map((r) => r.features.find((f) => f.name === column)!),
        counts = new Map<string, number>();
      for (const f of values) counts.set(f.status, (counts.get(f.status) ?? 0) + 1);
      return {
        column,
        rows: rows.length,
        missing: values.filter((v) => v.value === null).length,
        statuses: [...counts.entries()]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([status, count]) => ({ status, count })),
      };
    }),
    duplicates: sources.duplicates,
    leakage,
    purgeScope: 'GLOBAL_ACROSS_SYMBOLS_AND_GROUPS_BOUNDARY_TOUCH_EXCLUDED',
    proposalPolicy: 'AUDIT_ONLY_NEVER_TRAINING_COLUMNS',
    survivorship: {
      policy: request.membership,
      scope: 'EXPLICIT_COHORT_NOT_COMPLETE_HISTORICAL_MARKET',
      disclosure: request.cohortDisclosure,
      coverage: request.instrumentKeys.map((instrumentKey) => {
        const r = rows.filter((r) => r.instrumentKey === instrumentKey);
        return {
          instrumentKey,
          candidateRows: r.length,
          includedRows: r.filter((r) => r.status === 'INCLUDED').length,
          metadataRejected: r.filter((r) => r.reasons.some((reason) => reason.includes('METADATA')))
            .length,
          missingLabels: r.filter((r) => r.reasons.includes('MISSING_LABEL')).length,
        };
      }),
    },
  };
  const artifact = DatasetPanelArtifactSchema.parse({
    schemaVersion: 'dataset-panel-artifact.v1',
    algorithmVersion: 'dataset-panel.v1',
    execution: 'DISABLED',
    clockSemantics: 'utc-nanoseconds.v1',
    randomSeed: 0,
    codeVersion,
    input: parsed,
    inputHash: canonicalHash(parsed),
    request,
    configHash: canonicalHash(request),
    featureCatalog: request.columns.map((name) => ({
      name,
      definitionHash: [...sources.definitions.get(name)!.hashes][0]!,
      description: sources.definitions.get(name)!.description,
      realTimePolicy: 'INPUT_TIME_GATED_COMPUTATION_LAG_UNMODELED',
    })),
    rows,
    audit,
  });
  deepFreeze(artifact);
  return artifact;
}
