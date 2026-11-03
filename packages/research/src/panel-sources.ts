import type {
  DatasetPanelInput,
  PanelFeatureCell,
  MarketBar,
  UtcTimestamp,
} from '@crypto/contracts';
import { canonicalHash, decimal } from '@crypto/core';
import { validateTechnicalFeatureArtifact } from './feature-artifact.js';
import { validateCrossFeatureArtifact } from './cross-feature-artifact.js';

export type PanelCandidate = {
  instrumentKey: string;
  featureAsOf: UtcTimestamp;
  features: Map<string, PanelFeatureCell>;
  sourceHashes: Set<string>;
  startBarId: string | null;
  crossMembership: boolean | null;
  conflict: boolean;
};
const seriesKey = (s: { exchange: string; instrumentId: string; marketType: string }) =>
  `${s.exchange}|${s.instrumentId}|${s.marketType}`;
export function panelSources(input: DatasetPanelInput, columns: string[]) {
  const rows = new Map<string, PanelCandidate>(),
    bars = new Map<string, MarketBar>(),
    seen = new Set<string>(),
    definitions = new Map<
      string,
      { hashes: Set<string>; sources: Set<string>; description: string }
    >(),
    duplicates: {
      kind: 'EXACT_SOURCE_DUPLICATE' | 'CONFLICTING_FEATURE';
      id: string;
      sourceHashes: string[];
    }[] = [],
    addBars = (list: MarketBar[]) => {
      for (const b of list) {
        const old = bars.get(b.id);
        if (old && canonicalHash(old) !== canonicalHash(b))
          throw new Error('Conflicting raw evidence identity');
        bars.set(b.id, b);
      }
    },
    candidate = (key: string, at: UtcTimestamp) => {
      const id = `${key}|${at}`;
      let r = rows.get(id);
      if (!r) {
        r = {
          instrumentKey: key,
          featureAsOf: at,
          features: new Map(),
          sourceHashes: new Set(),
          startBarId: null,
          crossMembership: null,
          conflict: false,
        };
        rows.set(id, r);
      }
      return r;
    },
    add = (r: PanelCandidate, cell: PanelFeatureCell, description: string) => {
      if (!columns.includes(cell.name)) return;
      const def = definitions.get(cell.name) ?? {
        hashes: new Set<string>(),
        sources: new Set<string>(),
        description,
      };
      def.hashes.add(cell.definitionHash);
      cell.sourceHashes.forEach((h) => def.sources.add(h));
      definitions.set(cell.name, def);
      const old = r.features.get(cell.name);
      const body = (v: PanelFeatureCell) =>
        Object.fromEntries(Object.entries(v).filter(([key]) => key !== 'sourceHashes'));
      if (old && canonicalHash(body(old)) !== canonicalHash(body(cell))) {
        r.conflict = true;
        duplicates.push({
          kind: 'CONFLICTING_FEATURE',
          id: `${r.instrumentKey}|${r.featureAsOf}|${cell.name}`,
          sourceHashes: [...old.sourceHashes, ...cell.sourceHashes],
        });
      } else
        r.features.set(
          cell.name,
          old
            ? {
                ...old,
                sourceHashes: [...new Set([...old.sourceHashes, ...cell.sourceHashes])].sort(),
              }
            : cell,
        );
    },
    setStart = (r: PanelCandidate, id: string | null) => {
      if (id !== null) {
        if (r.startBarId !== null && r.startBarId !== id) r.conflict = true;
        else r.startBarId = id;
      }
    };
  for (const raw of input.technicalArtifacts) {
    const a = validateTechnicalFeatureArtifact(raw),
      hash = canonicalHash(a);
    if (seen.has(hash)) {
      duplicates.push({ kind: 'EXACT_SOURCE_DUPLICATE', id: hash, sourceHashes: [hash] });
      continue;
    }
    seen.add(hash);
    addBars(a.input.bars);
    const bindings = input.bindings.filter(
      (b) => seriesKey(b.series) === seriesKey(a.request.series),
    );
    if (bindings.length !== 1)
      throw new Error('Technical artifact needs one explicit instrument binding');
    const binding = bindings[0]!;
    for (const row of a.rows) {
      const r = candidate(binding.instrumentKey, row.request.featureAsOf);
      r.sourceHashes.add(hash);
      setStart(r, row.currentBarId);
      for (const f of row.features) {
        const d = a.catalog.find((d) => d.featureId === f.featureId)!;
        add(
          r,
          {
            name: `technical.${f.featureId}`,
            value: f.value,
            status: f.status,
            definitionHash: canonicalHash({
              definition: d,
              config: a.request.config,
              intervalSeconds: a.request.intervalSeconds,
            }),
            sourceKind: 'TECHNICAL',
            dependency: 'MARKET',
            sourceHashes: [hash],
            inputBarIds: f.inputBarIds,
            maxInputAvailableAt: f.maxInputAvailableAt,
            maxInputEventAt: f.maxInputCloseAt,
          },
          d.formula,
        );
      }
    }
  }
  for (const raw of input.crossArtifacts) {
    const a = validateCrossFeatureArtifact(raw),
      hash = canonicalHash(a);
    if (canonicalHash(a.input.market) !== canonicalHash(input.market))
      throw new Error('Cross-feature market metadata snapshot differs from panel metadata');
    if (seen.has(hash)) {
      duplicates.push({ kind: 'EXACT_SOURCE_DUPLICATE', id: hash, sourceHashes: [hash] });
      continue;
    }
    seen.add(hash);
    addBars(a.input.technical.bars);
    const config = Object.fromEntries(
      Object.entries(a.request).filter(
        ([key]) => !['featureAsOf', 'generatedAt', 'targets'].includes(key),
      ),
    );
    for (const row of a.rows)
      for (const asset of row.assets) {
        const r = candidate(asset.instrumentKey, row.featureAsOf);
        r.sourceHashes.add(hash);
        r.crossMembership = asset.inLiquidUniverse;
        setStart(r, asset.slots.at(-1)?.barId ?? null);
        const values: [string, PanelFeatureCell['value'], string][] = [
          ['return', asset.grossReturn, asset.grossReturn === null ? 'MISSING_PATH' : 'READY'],
          [
            'relative_to_btc',
            asset.relativeToBtc,
            asset.relativeToBtc === null ? 'MISSING_REFERENCE' : 'READY',
          ],
          ['btc_return', asset.btcReturn, asset.btcReturn === null ? 'MISSING_REFERENCE' : 'READY'],
          ['regime_efficiency', asset.regime.efficiency, asset.regime.status],
          ['regime_volatility', asset.regime.volatility, asset.regime.status],
          [
            'regime_trending',
            asset.regime.status === 'READY'
              ? decimal(asset.regime.trend === 'TRENDING' ? '1' : '0')
              : null,
            asset.regime.status,
          ],
          [
            'high_volatility',
            asset.regime.highVolatility === null
              ? null
              : decimal(asset.regime.highVolatility ? '1' : '0'),
            asset.regime.status,
          ],
          [
            'funding_rate',
            asset.derivatives.fundingRate.value,
            asset.derivatives.fundingRate.status,
          ],
          [
            'open_interest',
            asset.derivatives.openInterest.value,
            asset.derivatives.openInterest.status,
          ],
          [
            'breadth_advancing',
            row.breadth.advancingFraction,
            row.breadth.advancingFraction === null ? 'UNAVAILABLE' : 'READY',
          ],
          [
            'breadth_declining',
            row.breadth.decliningFraction,
            row.breadth.decliningFraction === null ? 'UNAVAILABLE' : 'READY',
          ],
          [
            'turnover_hhi',
            row.concentration.herfindahl,
            row.concentration.herfindahl === null ? 'UNAVAILABLE' : 'READY',
          ],
          ...asset.correlations.map(
            (c) =>
              [`correlation_${c.lagBars}`, c.value, c.status] as [
                string,
                PanelFeatureCell['value'],
                string,
              ],
          ),
        ];
        for (const [name, value, status] of values)
          add(
            r,
            {
              name: `cross.${name}`,
              value,
              status,
              definitionHash: canonicalHash({ name, config, version: a.algorithmVersion }),
              sourceKind: 'CROSS',
              dependency: 'MARKET',
              sourceHashes: [hash],
              inputBarIds: row.inputBarIds,
              maxInputAvailableAt: row.maxInputAvailableAt,
              maxInputEventAt: row.maxInputEventAt,
            },
            `cross-features.v1 ${name}; shared-cutoff point-in-time inputs`,
          );
      }
  }
  for (const column of columns)
    if (!definitions.has(column)) throw new Error(`Unknown registered feature: ${column}`);
  const inconsistent = new Set(
    [...definitions.entries()].filter(([, d]) => d.hashes.size > 1).map(([n]) => n),
  );
  for (const name of inconsistent)
    duplicates.push({
      kind: 'CONFLICTING_FEATURE',
      id: `definition:${name}`,
      sourceHashes: [...definitions.get(name)!.sources].sort(),
    });
  return {
    rows: [...rows.values()].sort((a, b) =>
      a.featureAsOf < b.featureAsOf
        ? -1
        : a.featureAsOf > b.featureAsOf
          ? 1
          : a.instrumentKey < b.instrumentKey
            ? -1
            : 1,
    ),
    bars,
    definitions,
    duplicates,
    inconsistent,
  };
}
