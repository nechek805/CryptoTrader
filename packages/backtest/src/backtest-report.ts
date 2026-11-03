import type { BacktestReport } from '@crypto/contracts';
import { validateBacktestReport } from './backtest.js';
import type { StrategyFactory } from './strategy.js';
export function formatBacktestReport(a: BacktestReport) {
  const safe = (s: string) => s.replaceAll('|', '\\|').replaceAll('\n', ' '),
    show = (v: string | null) => v ?? 'UNKNOWN',
    base = a.cases[0]!,
    lines = [
      '# Backtest research report',
      '',
      `Execution: SIMULATED. Live execution: DISABLED. Run: ${a.runId}.`,
      `Strategy: ${safe(a.manifest.strategy.id)} v${a.manifest.strategy.version}. Software: ${safe(a.codeVersion)}.`,
      `Manifest: ${a.manifestHash}. Input: ${a.manifest.inputHash}. Seed: ${a.manifest.assumptions.policy.randomSeed}.`,
      '',
      safe(a.manifest.cohortDisclosure),
      `Assumptions declaredAt: ${a.manifest.assumptions.declaredAt}. This is an operator assertion, not proof of prospective registration.`,
      `Buy-and-hold uses the same predeclared ${a.manifest.quantity} ${a.manifest.series.asset}; unspent cash remains cash. No first-open fill is assumed.`,
      '',
      '## Source coverage',
      '',
      '| Source | Origin | License | Version | Reference |',
      '| --- | --- | --- | --- | --- |',
      ...a.manifest.input.market.sources.map(
        (s) =>
          `| ${safe(s.id)} | ${s.origin} | ${s.license} | ${safe(s.version)} | ${safe(s.reference)} |`,
      ),
      '',
      '## Assumptions and sensitivity',
      '',
      '| Scenario | Assumptions hash | Maker / taker | Spread / slippage bps | Latency ms | Missing closes | Fee check |',
      '| --- | --- | --- | --- | ---: | ---: | --- |',
      ...a.cases.map(
        (c) =>
          `| ${safe(c.id)} | ${c.assumptionsHash} | ${c.assumptions.policy.makerRate} / ${c.assumptions.policy.takerRate} | ${c.assumptions.policy.spreadBps} / ${c.assumptions.policy.slippageBps} | ${c.assumptions.policy.latencyMs} | ${c.missingCloseTimes.length} | ${c.feeCheck} |`,
      ),
      '',
      '## Outcomes versus cash and buy-and-hold',
      '',
      'Returns and drawdowns below are fractions, not percentages. Gross includes modeled execution price effects; net also includes fees. Open positions use fresh as-of close marks without forced liquidation.',
      '',
      '| Scenario | Role | Gross PnL | Net PnL | Gross return | Net return | Fees | Max drawdown | Time in market | Turnover / initial cash |',
      '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
      ...a.cases.flatMap((c) =>
        c.outcomes.map(
          (o) =>
            `| ${safe(c.id)} | ${o.role} | ${show(o.metrics.grossPnl)} | ${show(o.metrics.netPnl)} | ${show(o.metrics.grossReturn)} | ${show(o.metrics.netReturn)} | ${o.metrics.fees} | ${show(o.metrics.maxDrawdownFraction)} | ${o.metrics.timeInMarketFraction} | ${o.metrics.turnoverFraction} |`,
        ),
      ),
      '',
      '## Base-case trades',
      '',
      'FIFO closed lots; partially unclosed entry fees remain part of total portfolio cost. Raw fills, provenance, risk decisions, postings and all scenario curves remain in report.json.',
      '',
      '| Role | Opened | Closed | Quantity | Entry | Exit | Gross PnL | Entry / exit fees | Net PnL |',
      '| --- | --- | --- | ---: | ---: | ---: | ---: | --- | ---: |',
      ...base.outcomes.flatMap((o) =>
        o.trades.map(
          (t) =>
            `| ${o.role} | ${t.openedAt} | ${t.closedAt} | ${t.quantity} | ${t.entryPrice} | ${t.exitPrice} | ${t.grossPnl} | ${t.entryFees} / ${t.exitFees} | ${t.netPnl} |`,
        ),
      ),
      '',
      '## Base-case equity and exposure',
      '',
      'End-of-timestamp delivered-event cutoffs. Missing/stale marks do not become zero asset values or indefinite forward-fills.',
      '',
      '| Role | As of | Cash incl. reserves | Asset quantity | Known close | Equity | Exposure fraction | Status |',
      '| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |',
      ...base.outcomes.flatMap((o) =>
        o.equity.map(
          (p) =>
            `| ${o.role} | ${p.at} | ${p.cash} | ${p.quantity} | ${show(p.mark)} | ${show(p.equity)} | ${show(p.exposureFraction)} | ${p.reason} |`,
        ),
      ),
      '',
      '## Coverage, skipped attempts and depth',
      '',
      'Market depth and maker queues are UNKNOWN for this OHLCV model. Skipped attempts describe model decisions, not proof of missed real trades. Changed fills under latency/gaps prevent causal attribution to fees alone.',
    ];
  for (const c of a.cases) {
    lines.push(
      '',
      `### ${safe(c.id)}`,
      `Effective input: ${c.effectiveInputHash}. Omitted IDs: ${c.omittedBarIds.map(safe).join(', ') || 'NONE'}.`,
    );
    for (const t of c.missingCloseTimes) lines.push(`- Missing eligible close: ${t}`);
    for (const o of c.outcomes) {
      lines.push(
        '',
        `${o.role}: ${o.metrics.fillCount} fills, ${o.metrics.rejectedOrders} rejected orders, ${o.metrics.unknownEquityPoints} unknown equity points.`,
      );
      for (const s of o.skips) lines.push(`- ${safe(s.reason)}: ${s.count}`);
    }
  }
  lines.push(
    '',
    '## Limits and handoff',
    '',
    ...a.warnings.map((w) => `- ${safe(w)}`),
    '',
    'Published interfaces for Modules 09–13: Strategy, ReplayContext, ExecutionSimulator and BacktestReport. Next implementation: Module 09, Iteration 1 — Interpretable Baselines.',
    '',
  );
  return lines.join('\n');
}
export function backtestMarkdown(input: unknown, factory?: StrategyFactory) {
  return formatBacktestReport(validateBacktestReport(input, factory));
}
