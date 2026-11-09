import { createDirectionalService } from '../../api/src/directional-tests.js';
const service = await createDirectionalService('data/directional-tests');
service.start();
let last = '';
while (service.state().job?.status === 'RUNNING') {
  const text = service.state().job!.message;
  if (text !== last) {
    process.stdout.write(text + '\n');
    last = text;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 250));
}
process.stdout.write(JSON.stringify(service.state()) + '\n');
if (service.state().job?.status !== 'DONE') process.exitCode = 1;
else {
  for (const mode of ['SHORT_ONLY', 'LONG_SHORT'] as const)
    for (const cell of service
      .matrix()!
      .matrix.cells.filter((c) => c.mode === mode && c.feeMode === 'STANDARD'))
      process.stdout.write(JSON.stringify(cell) + '\n');
  if (process.argv.includes('--verify')) {
    const saved = service.state().fees;
    try {
      for (const on of [true, false]) {
        await service.setFees({ V1: on, V2: on, V3: on, V4: on, V5: on });
        for (const p of service.matrix()!.matrix.profiles)
          for (const mode of ['SHORT_ONLY', 'LONG_SHORT'] as const) {
            const result = await service.verify({ asset: p.asset, strategy: p.strategy, mode });
            process.stdout.write(
              `${p.asset} ${p.strategy} ${mode} fees ${on ? 'on' : 'off'} verified ${result.reportId}\n`,
            );
          }
      }
    } finally {
      await service.setFees(saved);
    }
  }
}
