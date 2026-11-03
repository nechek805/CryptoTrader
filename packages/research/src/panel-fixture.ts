import { DatasetPanelInputSchema, DatasetPanelRequestSchema } from '@crypto/contracts';
import { canonicalHash, fromEpoch } from '@crypto/core';
import { crossFeatureFixture } from './cross-feature-fixture.js';
import { technicalFeatureFixture } from './feature-fixture.js';
import { buildTechnicalFeatureArtifact } from './feature-artifact.js';
import { buildCrossFeatureArtifact } from './cross-feature-artifact.js';

/** Fictional cohort, prices, groups and book evidence; includes an audit-only leaking proposal. */
export function datasetPanelFixture() {
  const at = (seconds: number) => fromEpoch(1767225600n + BigInt(seconds), 'seconds'),
    base = crossFeatureFixture(),
    times = [90, 150, 180, 210, 240, 270, 300, 330, 360, 390, 420, 450, 480, 510, 540].map(at),
    keys = ['cross:SPOT:ETH', 'cross:SPOT:SOL', 'cross:SPOT:NEW'],
    config = {
      ...technicalFeatureFixture().request.config,
      smaPeriod: 2,
      emaPeriod: 2,
      volatilityPeriod: 2,
      atrPeriod: 2,
      relativeVolumePeriod: 2,
      zScorePeriod: 2,
      breakoutPeriod: 2,
      returnHorizonsBars: [1, 2],
    },
    technicalArtifacts = base.input.bindings
      .filter((b) => keys.includes(b.instrumentKey))
      .map((b) =>
        buildTechnicalFeatureArtifact(
          base.input.technical,
          {
            schemaVersion: 'technical-feature-request.v1',
            series: b.series,
            intervalSeconds: 60,
            historyStartCloseAt: at(60),
            featureAsOf: times,
            generatedAt: at(660),
            config,
          },
          'synthetic:panel-source.v1',
        ),
      ),
    crossArtifacts = [
      buildCrossFeatureArtifact(
        base.input,
        { ...base.request, featureAsOf: times, targets: keys },
        'synthetic:panel-source.v1',
      ),
    ],
    groups = base.input.bindings.map((b) => ({
      schemaVersion: 'panel-group-revision.v1',
      id: `${b.instrumentKey}:group:1`,
      instrumentKey: b.instrumentKey,
      revision: 1,
      groupId: 'synthetic:group:initial',
      effectiveFrom: at(0),
      observedAt: at(0),
      availableAt: at(b.series.asset === 'NEW' ? 360 : 0),
      availabilityBasis: 'OBSERVED',
      researchUse: 'ELIGIBLE',
      provenance: {
        origin: 'FIXTURE',
        sourceIds: ['synthetic:groups'],
        parentIds: [canonicalHash(b.instrumentKey)],
        sourceVersion: 'synthetic-panel.v1',
        capturedAt: at(0),
        rawTimestamp: null,
      },
    })),
    input = DatasetPanelInputSchema.parse({
      schemaVersion: 'dataset-panel-input.v1',
      market: base.input.market,
      bindings: base.input.bindings,
      groups: [
        ...groups,
        {
          ...groups.find((g) => g.instrumentKey === 'cross:SPOT:ETH'),
          id: 'synthetic:eth:group:2',
          revision: 2,
          groupId: 'synthetic:group:changed',
          effectiveFrom: at(360),
          observedAt: at(360),
          availableAt: at(400),
          provenance: { ...groups[0]!.provenance, capturedAt: at(360) },
        },
      ],
      technicalArtifacts,
      crossArtifacts,
      proposedFeatures: [
        {
          instrumentKey: 'cross:SPOT:ETH',
          featureAsOf: at(150),
          features: [
            {
              name: 'proposed.future_close',
              value: '54',
              status: 'READY',
              definitionHash: canonicalHash('synthetic:leaking-proposal'),
              sourceKind: 'PROPOSED',
              dependency: 'LABEL',
              sourceHashes: [],
              inputBarIds: ['cross:SPOT:ETH:bar:5'],
              maxInputAvailableAt: at(150),
              maxInputEventAt: at(150),
            },
          ],
        },
      ],
    }),
    request = DatasetPanelRequestSchema.parse({
      schemaVersion: 'dataset-panel-request.v1',
      instrumentKeys: keys,
      columns: [
        'technical.sma',
        'technical.return_1',
        'cross.relative_to_btc',
        'cross.regime_efficiency',
        'cross.open_interest',
      ],
      intervalSeconds: 60,
      splits: {
        train: { from: at(120), to: at(300) },
        validation: { from: at(300), to: at(480) },
        test: { from: at(480), to: at(600) },
      },
      embargoSeconds: 30,
      horizonsBars: [1, 2],
      labelPublicationLagSeconds: 20,
      labelsAsOf: at(660),
      generatedAt: at(660),
      missingPolicy: 'KEEP_NULLS',
      membership: 'POINT_IN_TIME_LISTED',
      cohortDisclosure:
        'SYNTHETIC explicit ETH/SOL/NEW teaching cohort, not a complete historical market. Delayed listing/group evidence and missing tail labels are retained in the audit.',
    });
  return { input, request };
}
