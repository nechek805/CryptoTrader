import { createShortV6Service } from '../../api/src/short-v6.js';
const service = await createShortV6Service('data/short-v6');
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
  for (const row of service.matrix()!.matrix.research)
    process.stdout.write(JSON.stringify(row) + '\n');
  if (process.argv.includes('--verify')) {
    const saved = service.state().fees;
    try {
      for (const on of [true, false]) {
        await service.setFees({ V1: on, V2: on, V3: on, V4: on, V5: on, V6: on });
        for (const asset of ['SOL', 'XRP'])
          for (const strategy of ['V5', 'V6'])
            for (const mode of ['LONG_ONLY', 'SHORT_ONLY', 'LONG_SHORT']) {
              const r = await service.verify({ asset, strategy, mode });
              process.stdout.write(
                `${asset} ${strategy} ${mode} fees ${on ? 'on' : 'off'} verified ${r.reportId}\n`,
              );
            }
      }
    } finally {
      await service.setFees(saved);
    }
  }
}
