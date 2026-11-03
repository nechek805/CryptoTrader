import { DatasetSplitSchema } from '@crypto/contracts';
import { deepFreeze } from '@crypto/core';
import { verifyDatasetPanel } from './panel-storage.js';

/** Feature matrices never contain labels or source/audit diagnostics as implicit columns. */
export async function readDatasetPanel(directory: string) {
  const verified = await verifyDatasetPanel(directory),
    select = (split: unknown) => {
      const s = DatasetSplitSchema.parse(split);
      return verified.rows.filter((r) => r.split === s);
    };
  const features = (split: unknown) => {
    const result = select(split).map((r) => ({
      id: r.id,
      instrumentKey: r.instrumentKey,
      groupId: r.groupId!,
      featureAsOf: r.featureAsOf,
      maxInputAvailableAt: r.maxInputAvailableAt!,
      values: verified.artifact.request.columns.map(
        (name) => r.features.find((f) => f.name === name)!.value,
      ),
    }));
    deepFreeze(result);
    return result;
  };
  return Object.freeze({
    schemaVersion: 'dataset-panel-client.v1' as const,
    manifest: verified.manifest,
    audit: verified.artifact.audit,
    featureCatalog: verified.artifact.featureCatalog,
    columns: verified.artifact.request.columns,
    features,
    supervised: (split: unknown, horizonBars: number) => {
      if (!verified.artifact.request.horizonsBars.includes(horizonBars))
        throw new Error('Unknown panel horizon');
      const rows = select(split),
        points = features(split),
        result = rows.map((r, i) => ({
          features: points[i]!,
          target: {
            horizonBars,
            value: r.labels.find((l) => l.horizonBars === horizonBars)!.value!,
          },
        }));
      deepFreeze(result);
      return result;
    },
  });
}
