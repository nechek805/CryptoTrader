import { MarketBarSchema, NewsDocumentSchema } from '@crypto/contracts';
import {
  addDecimal,
  canonicalHash,
  decimal,
  decisionView,
  deterministicId,
  SeededRandom,
  SyntheticClock,
} from '@crypto/core';
import { createDomainFixtures } from '../../../tests/fixtures/domain.js';

const fixtures = createDomainFixtures();
const clock = new SyntheticClock('2026-01-01T00:01:02Z');
const future = MarketBarSchema.parse({
  ...fixtures.marketBar,
  id: 'bar:fixture:future',
  openAt: '2026-01-01T00:01:00Z',
  closeAt: '2026-01-01T00:02:00Z',
  availableAt: '2026-01-01T00:02:01Z',
});
const view = decisionView(MarketBarSchema, [fixtures.marketBar, future], clock.now());
const unavailableNews = decisionView(NewsDocumentSchema, [fixtures.newsDocument], clock.now());
const rng = new SeededRandom(42);
process.stdout.write(
  `${JSON.stringify(
    {
      mode: 'fixture-only',
      description: 'Contract demonstration; no strategy or broker run',
      validatedContracts: Object.keys(fixtures).length,
      decisionAt: view.decisionAt,
      eligibleBarIds: view.records.map((record) => record.id),
      eligibleNewsCount: unavailableNews.records.length,
      exactSum: addDecimal(decimal('0.1'), decimal('0.2')),
      seed: rng.seed,
      randomAlgorithm: rng.algorithm,
      randomDraw: rng.nextUint32(),
      snapshotHash: canonicalHash(view),
      snapshotId: deterministicId('decision', view),
      manifestHash: canonicalHash(fixtures.experimentManifest),
    },
    null,
    2,
  )}\n`,
);
