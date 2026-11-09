import { createBtcTestService } from '../../api/src/btc-test.js';
import { canonicalJson } from '@crypto/core';

async function main() {
  const action = process.argv[2];
  if (!['download', 'run', 'compare', 'verify', 'status'].includes(action ?? ''))
    throw new Error('Usage: pnpm btc-test download|run|compare|verify|status');
  const service = await createBtcTestService('data/btc-market-test');
  if (action === 'status') {
    process.stdout.write(canonicalJson(service.state()) + '\n');
    return;
  }
  if (action === 'verify') {
    process.stdout.write(canonicalJson(await service.verify()) + '\n');
    return;
  }
  service.start(
    action === 'download' ? 'DOWNLOAD' : action === 'compare' ? 'COMPARE' : 'RUN',
    service.state().datasetId ?? undefined,
  );
  let last = '';
  while (service.state().job?.status === 'RUNNING') {
    const message = service.state().job!.message;
    if (message !== last) {
      process.stdout.write(message + '\n');
      last = message;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (service.state().job?.status === 'FAILED') throw new Error(service.state().job!.message);
  process.stdout.write(canonicalJson(service.state()) + '\n');
  if (action === 'run')
    process.stdout.write(canonicalJson(service.report()?.report.summary) + '\n');
}
main().catch((e: unknown) => {
  process.stderr.write(e instanceof Error ? e.message : 'BTC research failed');
  process.exitCode = 1;
});
