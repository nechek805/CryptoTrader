import { validateHypothesisRegistry } from './hypothesis-artifact.js';

export function hypothesisRegistryReport(input: unknown) {
  const a = validateHypothesisRegistry(input),
    heads = new Map(a.input.cards.map((c) => [c.content.id, c])),
    lines = [
      '# Hypothesis registry research report',
      '',
      `Synthetic evidence: ${a.synthetic}; execution DISABLED.`,
      'Results are observational associations, not causal findings, executable rules or profitability claims.',
      'Intervals are conditional lineage/window block-bootstrap percentiles with Bonferroni nominal levels across both phases and all latest cards. Few units, dependent regimes and selected synthetic paths limit their interpretation. A zero-width interval on flat fixtures does not mean zero population uncertainty.',
      '',
      `Input: ${a.inputHash}`,
      `Config: ${a.configHash}`,
      `Software: ${a.codeVersion}`,
      '',
    ];
  for (const e of a.evaluations) {
    const card = heads.get(e.cardId)!,
      c = card.content;
    lines.push(
      `## ${e.cardId} — revision ${e.revision}`,
      '',
      `Registered thesis: ${c.thesis}`,
      `Group: ${c.eventGroup.join(', ')}; expected ${c.expectedDirection}; ${c.series.exchange} / ${c.series.instrumentId}; horizon ${c.horizonSeconds}s.`,
      `Card hash: ${card.hash}; recorded ${card.recordedAt}; primary test ${c.tests.primaryMetric}, threshold ${c.tests.meanThreshold}, minimum units ${c.tests.minimumIndependentUnits}.`,
      `Period independence: ${e.independence}; reuse reasons: ${e.reuseReasons.join(', ') || 'none'}; disclosure: ${c.reuseDisclosure ?? 'none'}.`,
      `First-seen eligibility: ${c.eligibility.firstSeenQualities.join(', ')}; unknown/estimated historical availability is quarantined.`,
      `Assumptions: ${c.assumptions.join(' ')}`,
      `Selection biases: ${c.selectionBiases.join(' ')}`,
      `Finding: ${e.finding}; final status: ${e.finalStatus}.`,
      '',
      '| Phase / sample period | Records | Complete | Quarantined | Lineage/window units | Mean | Confidence interval |',
      '| --- | --- | --- | --- | --- | --- | --- |',
    );
    for (const phase of ['selection', 'validation'] as const) {
      const s = e[phase],
        p = c.samplePeriod[phase],
        ci = s.confidenceInterval;
      lines.push(
        `| ${phase}: ${p.from} to ${p.to} | ${s.sampleCount} | ${s.completeCount} | ${s.quarantinedCount} | ${s.independentUnits} | ${s.mean ?? 'missing'} | ${ci ? `[${ci.lower}, ${ci.upper}], nominal level ${ci.level}, ${ci.resamples} resamples` : `unavailable: ${s.uncertaintyReason}`} |`,
      );
    }
    lines.push(
      '',
      `Contradictory examples: ${e.contradictoryExamples.join(', ') || 'none observed in complete selected records'}.`,
      '',
      '| Observation | Phase | First-seen quality | Result | Gross | Assumed-cost net |',
      '| --- | --- | --- | --- | --- | --- |',
    );
    for (const s of e.samples)
      lines.push(
        `| ${s.observationId} | ${s.phase} | ${s.firstSeenQuality} | ${s.status} | ${s.grossReturn ?? 'missing'} | ${s.netReturn ?? 'missing'} |`,
      );
    if (c.claimType === 'CAUSAL')
      lines.push(
        '',
        `Author-supplied causal design (not endorsed): ${c.causalJustification!.design}. Registry status requires causal review; this observational engine does not validate identification.`,
      );
    lines.push('');
  }
  lines.push(
    'News Strategy handoff uses only card versions and news context already available at each event decision. It excludes descriptive archives, outcomes, confidence intervals and final findings; default action remains HOLD.',
    '',
  );
  return lines.join('\n');
}
