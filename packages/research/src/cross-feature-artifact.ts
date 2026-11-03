import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { CrossFeatureArtifactSchema, CrossFeatureRequestSchema } from '@crypto/contracts';
import { canonicalHash, canonicalJson, deepFreeze } from '@crypto/core';
import { SnapshotCrossFeatures } from './cross-features.js';

const limit = 64 * 1024 * 1024;
export function crossFeatureCatalog() {
  return [
    {
      featureId: 'relative_to_btc',
      formula:
        'asset H-bar gross return minus BTC H-bar gross return over backward-aligned complete paths',
      availabilityPolicy: 'shared as-of; actual closes <= nominal closes; no forward joins',
      missingPolicy: 'null if either reference path is unavailable',
    },
    {
      featureId: 'rolling_correlation',
      formula: 'Pearson correlation of matched adjacent one-bar simple returns',
      availabilityPolicy:
        'all four close inputs available by shared as-of; consecutive actual source closes required',
      missingPolicy:
        'null below minimum pairs or at zero variance; report actual pairs and coverage',
    },
    {
      featureId: 'lead_lag',
      formula:
        'BTC return at nominal u paired with asset return at u+k intervals; positive k means BTC leads',
      availabilityPolicy:
        'pairs remain inside lookback; no future timestamps or values beyond cutoff',
      missingPolicy:
        'no gap bridging, pair counts explicit; retrospective lead/lag is not a causal forecast',
    },
    {
      featureId: 'breadth',
      formula:
        'advance/decline fractions among complete returns in current point-in-time book-qualified universe',
      availabilityPolicy:
        'known listing, volume, book liquidity and current coverage at the same decision',
      missingPolicy: 'empty or unmeasured universe yields null, no static/survivor fallback',
    },
    {
      featureId: 'turnover_concentration',
      formula: 'largest share and sum of squared quote-volume shares in selected universe',
      availabilityPolicy: 'only actually available universe-window quote turnover',
      missingPolicy:
        'null if total turnover is zero or selection empty; not market-cap or risk concentration',
    },
    {
      featureId: 'regime',
      formula:
        'efficiency=abs(lastClose-firstClose)/sum(abs(adjacent price changes)); trend if efficiency >= threshold; high-volatility independently compares population log-return standard deviation',
      availabilityPolicy:
        'complete contiguous source path inside lookback and historical listing lifetime',
      missingPolicy:
        'UNKNOWN/null during warm-up or gaps; flat complete paths are RANGING, efficiency zero',
    },
    {
      featureId: 'funding_rate_open_interest',
      formula:
        'latest known explicitly supplied field measurement with its own publication/receipt/availability and age gates',
      availabilityPolicy:
        'eligible active perpetual metadata plus measurement <= publication <= observation <= available <= cutoff',
      missingPolicy:
        'SPOT is NOT_APPLICABLE; absent/unpublished/stale fields remain null; no extraction from candle values',
    },
  ];
}
export function buildCrossFeatureArtifact(
  input: unknown,
  requestInput: unknown,
  codeVersion: string,
) {
  const engine = new SnapshotCrossFeatures(input),
    request = CrossFeatureRequestSchema.parse(requestInput),
    artifact = CrossFeatureArtifactSchema.parse({
      schemaVersion: 'cross-feature-artifact.v1',
      algorithmVersion: 'cross-features.v1',
      execution: 'DISABLED',
      clockSemantics: 'utc-nanoseconds.v1',
      randomSeed: 0,
      codeVersion,
      input: engine.input,
      inputHash: engine.inputHash,
      request,
      configHash: canonicalHash(request),
      catalog: crossFeatureCatalog(),
      rows: engine.evaluate(request),
    });
  deepFreeze(artifact);
  return artifact;
}
export function validateCrossFeatureArtifact(input: unknown) {
  const artifact = CrossFeatureArtifactSchema.parse(input),
    expected = buildCrossFeatureArtifact(artifact.input, artifact.request, artifact.codeVersion);
  if (canonicalHash(expected) !== canonicalHash(artifact))
    throw new Error('Cross-feature artifact integrity mismatch');
  deepFreeze(artifact);
  return artifact;
}
export async function verifyCrossFeatureArtifact(path: string) {
  const info = await lstat(path);
  if (!info.isFile() || info.size > limit) throw new Error('Invalid cross-feature artifact');
  const bytes = await readFile(path);
  if (bytes.length > limit) throw new Error('Cross-feature artifact limit');
  const artifact = validateCrossFeatureArtifact(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    ),
    hash = canonicalHash(artifact);
  if (basename(path) !== `cross-features_${hash.slice(7)}.json`)
    throw new Error('Cross-feature artifact name mismatch');
  return { path, hash, artifact };
}
export async function writeCrossFeatureArtifact(
  input: unknown,
  request: unknown,
  rootInput: string,
  codeVersion: string,
) {
  const artifact = buildCrossFeatureArtifact(input, request, codeVersion),
    hash = canonicalHash(artifact),
    body = `${canonicalJson(artifact)}\n`;
  if (Buffer.byteLength(body) > limit) throw new Error('Cross-feature artifact limit');
  await mkdir(rootInput, { recursive: true });
  const root = await realpath(rootInput),
    path = join(root, `cross-features_${hash.slice(7)}.json`),
    stage = join(root, `.cross-feature-stage-${randomUUID()}`),
    handle = await open(stage, 'wx');
  try {
    try {
      await handle.writeFile(body);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(stage, path);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      if ((await verifyCrossFeatureArtifact(path)).hash !== hash)
        throw new Error('Existing cross-feature mismatch', { cause: error });
    }
  } finally {
    await unlink(stage);
  }
  return verifyCrossFeatureArtifact(path);
}
export function crossFeatureReport(input: unknown) {
  const a = validateCrossFeatureArtifact(input),
    lines = [
      '# Cross-asset features and deterministic regimes',
      '',
      `Input: ${a.inputHash}`,
      `Config: ${a.configHash}`,
      `Software: ${a.codeVersion}`,
      'UTC, shared knowledge cutoff, backward-only joins. Correlation and lead/lag do not establish causality. Book-qualified universe membership is point-in-time; turnover concentration is not market-cap concentration or portfolio risk. No trade or forecast is produced.',
      '',
    ];
  for (const r of a.rows) {
    lines.push(
      `## ${r.featureAsOf}`,
      `Anchor ${r.anchorCloseAt}; universe ${r.universe.selected.map((s) => s.instrument.instrumentKey).join(', ') || 'EMPTY'}; measured breadth ${r.breadth.measuredCount}/${r.breadth.selectedCount}.`,
      `Advance fraction ${r.breadth.advancingFraction ?? 'missing'}, decline fraction ${r.breadth.decliningFraction ?? 'missing'}; turnover HHI ${r.concentration.herfindahl ?? 'missing'}; largest share ${r.concentration.largestShare ?? 'missing'}.`,
      '',
      '| Instrument | Metadata status | Gross | BTC relative | Trend | High volatility | Funding | Open interest |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |',
    );
    for (const v of r.assets)
      lines.push(
        `| ${v.instrumentKey} | ${v.status} | ${v.grossReturn ?? 'missing'} | ${v.relativeToBtc ?? 'missing'} | ${v.regime.trend} | ${v.regime.highVolatility ?? 'missing'} | ${v.derivatives.fundingRate.value ?? v.derivatives.fundingRate.status} | ${v.derivatives.openInterest.value ?? v.derivatives.openInterest.status} |`,
      );
    lines.push(
      '',
      '| Instrument | Lag | Direction | Correlation | Pairs / expected |',
      '| --- | --- | --- | --- | --- |',
    );
    for (const v of r.assets)
      for (const c of v.correlations)
        lines.push(
          `| ${v.instrumentKey} | ${c.lagBars} | ${c.direction} | ${c.value ?? c.status} | ${c.pairs.length} / ${c.expectedPairs} |`,
        );
    lines.push(
      '',
      `Max input availability: ${r.maxInputAvailableAt ?? 'none'}; max input event: ${r.maxInputEventAt ?? 'none'}.`,
      '',
    );
  }
  return lines.join('\n');
}
