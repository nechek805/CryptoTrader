import { EventControlsResultSchema } from '@crypto/contracts';

/** Markdown is derived from a validated result; the immutable artifact is the audit source. */
export function eventControlsReport(input: unknown) {
  const r = EventControlsResultSchema.parse(input),
    lines = [
      '# Descriptive cross-asset event controls',
      '',
      'Association and lead/lag correlation do not establish causality or executable forecasts.',
      'Random controls mean no observed news in the frozen corpus, not proof that no event occurred. Frequencies are descriptive sample fractions, not p-values.',
      '',
      `Input: ${r.inputHash}`,
      `Config: ${r.configHash}`,
      `UTC exact closes; horizon ${r.request.horizonSeconds}s; seed ${r.request.controls.seed}; requested controls ${r.request.controls.sampleCount}.`,
      'BTC factor is fitted only on pre-decision interval returns. Basket weights are fixed at the opening close. Recovery requires a close below entry followed by a close at or above entry.',
      '',
    ];
  const cell = (v: string | number | null) => (v === null ? 'missing' : String(v));
  for (const e of r.events) {
    lines.push(
      `Event ${e.eventId} at ${e.decisionAt}`,
      `Taxonomy: ${e.taxonomy.join(', ') || 'UNKNOWN'}; joint cohort complete: ${e.cohortComplete}.`,
      `Event sampling seed: ${e.samplingSeed}.`,
      `Overlapping sampled control outcome pairs: ${e.overlappingControlPairs}; samples are not assumed independent.`,
      `Selected controls: ${e.controls.length}. Candidate decisions: ${e.candidates.map((c) => `${c.at}=${c.status}`).join('; ')}`,
      '',
      '| Asset | Gross | Assumed-cost net | BTC beta adjusted | Market model adjusted | Basket relative | Control exceedances / N | Frequency | Recovery |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    );
    for (const v of e.responses)
      lines.push(
        `| ${v.series.asset} | ${cell(v.grossReturn)} | ${cell(v.netReturn)} | ${cell(v.btcBetaAdjustedReturn)} | ${cell(v.marketModelAdjustedReturn)} | ${cell(v.relativeToBasket)} | ${v.baseline.atLeastAsLarge} / ${v.baseline.selectedControls} | ${cell(v.baseline.frequency)} | ${v.recovery.status} |`,
      );
    lines.push('');
    for (const v of e.responses) {
      lines.push(
        `${v.series.asset}: ${v.series.exchange} / ${v.series.instrumentId} / ${v.series.marketType}; factor fit ${v.fit.status}, alpha ${cell(v.fit.alpha)}, beta ${cell(v.fit.beta)}, N=${v.fit.pairs}, fit ends ${v.fit.to}. Adjustment: ${v.factorAdjustmentStatus}.`,
        `Recovery: ${v.recovery.status}; first below ${cell(v.recovery.firstBelowAt)}, recovered ${cell(v.recovery.recoveredAt)}, seconds from anchor ${cell(v.recovery.recoverySeconds)}, censor ${cell(v.recovery.censorAt)} (${cell(v.recovery.censorReason)}).`,
        '',
        '| Segment | Lag bars | Direction | Correlation | Pairs |',
        '| --- | --- | --- | --- | --- |',
      );
      for (const lag of v.lags)
        lines.push(
          `| ${lag.segment} | ${lag.lagBars} | ${lag.direction} | ${cell(lag.correlation)} (${lag.status}) | ${lag.pairs.length} |`,
        );
      lines.push('');
    }
  }
  lines.push(
    `Concentration: ${r.concentration.selectedObservations} selected observations, ${r.concentration.uniqueEventIds} unique event IDs; ${r.concentration.overlappingObservationPairs} overlapping observation pairs; ${r.concentration.completeResponses} complete responses.`,
    `Lineage-group movement HHI ${cell(r.concentration.herfindahl)}; largest share ${cell(r.concentration.largestShare)}. Repeated and related observations are not independent evidence.`,
    '',
    '| Taxonomy combination | Observations | Unique event IDs | Complete responses | Mean absolute return |',
    '| --- | --- | --- | --- | --- |',
  );
  for (const g of r.taxonomyGroups)
    lines.push(
      `| ${g.taxonomy.join('+') || 'UNKNOWN'} | ${g.observations} | ${g.uniqueEvents} | ${g.completeResponses} | ${cell(g.meanAbsoluteReturn)} |`,
    );
  lines.push(
    '',
    'Full selected/excluded evidence, pair timestamps, sources, basket weights, candidate grid and hashes are retained in the artifact. Missing returns remain null. Right-censored recovery durations are not treated as completed recoveries.',
    '',
  );
  return lines.join('\n');
}
