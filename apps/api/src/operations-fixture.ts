import { evaluationFixture, evaluatePaperExperiment } from '@crypto/evaluation';
import { newsTemporalEventFixtures, buildNewsEventSnapshot } from '@crypto/news';
import { OpsDatasetSchema } from '@crypto/contracts';
import { eventStudyFixture, buildEventStudyArtifact } from '@crypto/research';
export async function operationsFixture() {
  const f = evaluationFixture(),
    news = await newsTemporalEventFixtures(),
    study = await eventStudyFixture();
  const newsSnapshots = ['2026-01-01T09:20:00Z', '2026-01-01T11:01:00Z'].map((at) =>
    buildNewsEventSnapshot(
      news.graphConfig,
      news.graphRecords,
      news.metadataRecords,
      news.config,
      { decisionAt: at, generatedAt: at },
      'synthetic:operations-context.v1',
    ),
  );
  return OpsDatasetSchema.parse({
    schemaVersion: 'ops-dataset.v1',
    paper: f.paper,
    evaluation: evaluatePaperExperiment(f.paper, f.plan),
    newsSnapshots,
    studies: [buildEventStudyArtifact(study.input, study.request, 'synthetic:operations-study.v1')],
  });
}
