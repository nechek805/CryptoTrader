import { prepareMarketTestInputs } from '@crypto/research';
const inputs = await prepareMarketTestInputs(
  'data/market-strategy-tests',
  'data/btc-market-test/datasets',
  (s) => process.stdout.write(s + '\n'),
);
process.stdout.write(
  JSON.stringify(
    {
      anchorId: inputs.anchor.id,
      from: inputs.anchor.dataset.from,
      to: inputs.anchor.dataset.to,
      rows: inputs.rows.map(({ asset, datasetId, error }) => ({ asset, datasetId, error })),
    },
    null,
    2,
  ) + '\n',
);
if (inputs.rows.some((r) => r.error)) process.exitCode = 1;
