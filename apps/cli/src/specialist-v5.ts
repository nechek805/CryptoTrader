import { createSpecialistV5Service } from '../../api/src/specialist-v5.js';
const service = await createSpecialistV5Service('data/sol-xrp-v5');
service.start();
let last = '';
while (service.state().job?.status === 'RUNNING') {
  const message = service.state().job!.message;
  if (message !== last) {
    process.stdout.write(message + '\n');
    last = message;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 250));
}
process.stdout.write(JSON.stringify(service.state()) + '\n');
if (service.state().job?.status !== 'DONE') process.exitCode = 1;
else {
  for (const row of service.matrix()!.matrix.rows)
    process.stdout.write(
      JSON.stringify({
        asset: row.asset,
        selected: row.selected,
        development: row.development,
        check: row.check,
        results: row.variants.STANDARD.map((c) => ({ strategy: c.strategy, summary: c.summary })),
      }) + '\n',
    );
  if (process.argv.includes('--verify')) {
    const saved = service.state().fees;
    try {
      for (const on of [true, false]) {
        await service.setFees({ V1: on, V2: on, V3: on, V4: on, V5: on });
        for (const asset of ['SOL', 'XRP'])
          for (const strategy of ['V1', 'V2', 'V3', 'V4', 'V5']) {
            const r = await service.verify({ asset, strategy });
            process.stdout.write(
              `${asset} ${strategy} fees ${on ? 'on' : 'off'} verified ${r.reportId}\n`,
            );
          }
      }
    } finally {
      await service.setFees(saved);
    }
  }
}
