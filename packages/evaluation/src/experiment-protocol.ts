import { parseDocument, stringify, visit } from 'yaml';
import { z } from 'zod';
import {
  ExperimentProtocolSchema,
  ForwardExperimentManifestSchema,
  ExperimentManifestSchema,
  utcNanoseconds,
  compareDecimal,
  PaperConfigSchema,
  TrialArtifactSchema,
} from '@crypto/contracts';
import type { ExperimentProtocol, ForwardExperimentManifest } from '@crypto/contracts';
import { canonicalHash, deterministicId, deepFreeze, decimal } from '@crypto/core';
import { PaperBroker } from '@crypto/paper';

export const unboundTrialHash = canonicalHash('UNBOUND_EXPERIMENT_PROTOCOL_TEMPLATE.v1');
export function trialArtifact(body: Omit<z.input<typeof TrialArtifactSchema>, 'hash'>) {
  const parsed = TrialArtifactSchema.omit({ hash: true }).parse(body);
  return TrialArtifactSchema.parse({ ...parsed, hash: canonicalHash(parsed) });
}
export function validateExperimentProtocol(input: unknown): ExperimentProtocol {
  const p = ExperimentProtocolSchema.parse(input),
    c = p.paper,
    start = utcNanoseconds(c.startAt),
    end = utcNanoseconds(c.endAt);
  if (
    end - start !== 30n * 86400n * 1000000000n ||
    !c.startAt.includes('T00:00:00.000000000Z') ||
    p.frozenAt > c.startAt ||
    p.evaluation.frozenAt !== p.frozenAt ||
    p.evaluation.generatedAt < c.endAt ||
    p.evaluation.phase !== 'FORWARD' ||
    p.origin !== c.origin ||
    p.codeVersion !== c.codeVersion ||
    c.runManifestHash !== unboundTrialHash ||
    canonicalHash(p.riskPolicy) !== c.riskPolicyHash ||
    p.riskPolicy.risk.frozenAt > p.frozenAt ||
    c.instruments.length < 3 ||
    p.baselinePolicy !== 'CASH' ||
    p.schedule.sourceAuditSeconds !== p.evaluation.marketObservationCadenceSeconds ||
    p.failureCriteria.minimumCoverage !== p.evaluation.minimumCoverage
  )
    throw new Error('Invalid experiment freeze, calendar or common settings');
  new PaperBroker(c);
  if (
    p.origin === 'PUBLIC_READ_ONLY' &&
    c.recordingPolicy !== 'TRIAL_IDLE_120S_ACTIVE_100MS_RELEVANT_TRADES_V1'
  )
    throw new Error('Public multi-asset month requires the frozen bounded study recording policy');
  const risk = p.riskPolicy.risk;
  if (
    compareDecimal(risk.riskFraction, decimal('0.0025')) > 0 ||
    compareDecimal(risk.dailyLossFraction, decimal('0.02')) > 0 ||
    compareDecimal(risk.maxGrossFraction, decimal('0.5')) > 0 ||
    compareDecimal(risk.maxSymbolFraction, decimal('0.1')) > 0 ||
    compareDecimal(risk.feeRate, c.takerRate) < 0 ||
    compareDecimal(risk.minLiquidityNotional, decimal('0')) <= 0
  )
    throw new Error('Unacceptable frozen research risk ceiling');
  const keys = new Set<string>();
  for (const m of p.models) {
    const { hash, ...body } = m.artifact;
    if (
      keys.has(m.portfolio) ||
      hash !== canonicalHash(body) ||
      m.artifact.knownAt > p.frozenAt ||
      (m.artifact.trainingCutoff !== null && m.artifact.trainingCutoff > m.artifact.knownAt) ||
      (p.origin === 'PUBLIC_READ_ONLY' && m.artifact.origin !== 'RESEARCH')
    )
      throw new Error('Unversioned, future or duplicate experiment model');
    keys.add(m.portfolio);
  }
  const providerIds = new Set<string>();
  for (const s of p.providers) {
    const { hash, ...body } = s.evidence;
    if (
      providerIds.has(s.id) ||
      !s.approved ||
      s.reviewedAt > p.frozenAt ||
      s.validUntil < c.endAt ||
      hash !== canonicalHash(body) ||
      s.evidence.knownAt > s.reviewedAt ||
      s.evidence.content.adapterHash !== s.adapterHash ||
      s.evidence.content.licenseReviewHash !== s.reviewHash ||
      (p.origin === 'PUBLIC_READ_ONLY' &&
        (s.rights !== 'APPROVED_RESEARCH_USE' || s.evidence.origin !== 'RESEARCH')) ||
      (p.origin === 'SYNTHETIC' && s.rights !== 'LOCALLY_AUTHORED_SYNTHETIC')
    )
      throw new Error('Provider adapter/license eligibility failed');
    providerIds.add(s.id);
    if (
      s.kind === 'MARKET' &&
      (s.id !== c.source.id ||
        s.adapterVersion !== c.source.adapterVersion ||
        s.reviewHash !== c.source.licenseReviewHash ||
        s.reviewedAt !== c.source.reviewedAt ||
        s.validUntil !== c.source.validUntil)
    )
      throw new Error('Market provider binding mismatch');
    if (
      s.kind === 'NEWS' &&
      !c.newsSources.some(
        (n) =>
          n.id === s.id && n.licenseReviewHash === s.reviewHash && n.validUntil === s.validUntil,
      )
    )
      throw new Error('News provider binding mismatch');
  }
  if (
    p.providers.filter((s) => s.kind === 'MARKET').length !== 1 ||
    p.providers.filter((s) => s.kind === 'NEWS').length !== c.newsSources.length ||
    !c.newsSources.length
  )
    throw new Error('Missing required provider checks');
  const slots = new Set<string>();
  for (const g of p.evaluation.opportunityGrid) {
    const key = `${g.at}/${g.symbol}`;
    if (
      slots.has(key) ||
      g.at < c.startAt ||
      g.at >= c.endAt ||
      !c.instruments.some((i) => i.symbol === g.symbol)
    )
      throw new Error('Invalid experiment opportunity calendar');
    slots.add(key);
  }
  deepFreeze(p);
  return p;
}
export function freezeExperiment(input: unknown): ForwardExperimentManifest {
  const protocol = validateExperimentProtocol(input),
    protocolHash = canonicalHash(protocol),
    c = protocol.paper;
  const manifest = ExperimentManifestSchema.parse({
    schemaVersion: 'experiment-manifest.v1',
    execution: 'SIMULATED',
    id: deterministicId('experiment', { protocolHash }),
    inputSnapshotHashes: [
      ...protocol.models.map((m) => m.artifact.hash),
      ...protocol.providers.map((s) => s.evidence.hash),
      ...c.instruments.map((i) => i.metadataHash),
    ],
    configHash: protocolHash,
    codeVersion: protocol.codeVersion,
    randomSeed: protocol.evaluation.randomSeed,
    randomAlgorithm: 'mulberry32.v1',
    generatedAt: protocol.frozenAt,
    frozenAt: protocol.frozenAt,
    dateRange: { startAt: c.startAt, endAt: c.endAt },
    symbols: c.instruments.map((i) => i.symbol),
    calendar: 'CRYPTO_24_7_UTC',
    quoteCurrency: c.quoteCurrency,
    startingBalancePerPortfolio: c.initialCash,
    portfolios: ['BASELINE', 'NEWS_ONLY', 'MARKET_ONLY', 'FUSION'],
    fees: {
      makerRate: c.makerRate,
      takerRate: c.takerRate,
      spreadBps: '0',
      slippageBps: c.slippageBps,
      fundingPolicy: 'NOT_APPLICABLE_SPOT',
    },
    models: protocol.models.map((m) => ({
      portfolio: m.portfolio,
      version: m.artifact.version,
      artifactHash: m.artifact.hash,
    })),
    exposureLimits: {
      leverage: '1',
      allowShort: false,
      maxSymbolFraction: protocol.riskPolicy.risk.maxSymbolFraction,
      maxPortfolioFraction: protocol.riskPolicy.risk.maxGrossFraction,
      staleAfter: { value: c.maxQuoteAgeSeconds, unit: 'seconds' },
    },
    clockSemantics: 'utc-nanoseconds.v1',
  });
  const body = {
    schemaVersion: 'forward-experiment-manifest.v1',
    protocol,
    protocolHash,
    manifest,
  };
  const frozen = ForwardExperimentManifestSchema.parse({ ...body, hash: canonicalHash(body) });
  deepFreeze(frozen);
  return frozen;
}
export function verifyExperimentManifest(input: unknown) {
  const m = ForwardExperimentManifestSchema.parse(input),
    expected = freezeExperiment(m.protocol);
  if (canonicalHash(m) !== canonicalHash(expected))
    throw new Error('Mutable or unhashed experiment manifest');
  return expected;
}
export function experimentPaperConfig(input: unknown) {
  const m = verifyExperimentManifest(input);
  return PaperConfigSchema.parse({ ...m.protocol.paper, runManifestHash: m.hash });
}
export function assertExperimentLaunch(input: unknown, currentCode: string, now: string) {
  const m = verifyExperimentManifest(input),
    at = z.string().datetime({ offset: false }).parse(now);
  if (
    m.protocol.origin !== 'PUBLIC_READ_ONLY' ||
    m.manifest.codeVersion !== currentCode ||
    Date.parse(at) < Date.parse(m.manifest.dateRange.startAt) ||
    Date.parse(at) >
      Date.parse(m.manifest.dateRange.startAt) + m.protocol.schedule.maxClockLagSeconds * 1000
  )
    throw new Error(
      'Forward launch requires eligible public sources, unchanged code and current start window',
    );
  return m;
}
export function parseExperimentYaml(text: string) {
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('Experiment YAML byte limit');
  const doc = parseDocument(text, {
    version: '1.2',
    uniqueKeys: true,
    stringKeys: true,
    customTags: [],
    logLevel: 'silent',
    prettyErrors: false,
  });
  let nodes = 0;
  visit(doc, {
    Alias() {
      throw new Error('YAML aliases are not permitted');
    },
    Node() {
      if (++nodes > 30000) throw new Error('Experiment YAML node limit');
    },
  });
  if (doc.errors.length || doc.warnings.length) throw new Error('Invalid experiment YAML');
  return validateExperimentProtocol(doc.toJS({ maxAliasCount: 0 }));
}
export function experimentYaml(input: unknown) {
  return stringify(validateExperimentProtocol(input), { lineWidth: 100 });
}
