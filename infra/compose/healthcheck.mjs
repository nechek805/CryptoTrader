import process from 'node:process';
import { readFile } from 'node:fs/promises';
const kind = process.argv[2],
  port = kind === 'news-api' ? 3103 : kind === 'worker' ? 3102 : kind === 'api' ? 3101 : 3100;
try {
  if (
    kind === 'news-collector' ||
    kind === 'news-analyzer' ||
    kind === 'news-research' ||
    kind === 'telegram' ||
    kind === 'news-forward' ||
    kind === 'news-forward-alerts'
  ) {
    const at = Number(await readFile('/tmp/' + kind + '-heartbeat', 'utf8'));
    if (!Number.isFinite(at) || Date.now() - at > 120000) process.exitCode = 1;
  } else {
    const r = await globalThis.fetch(
      `http://127.0.0.1:${port}/${kind === 'worker' || kind === 'news-api' ? 'health' : kind === 'api' ? 'ready' : 'live-paper'}`,
      {
        signal: globalThis.AbortSignal.timeout(6000),
        headers:
          kind === 'worker' ? { 'x-crypto-worker-auth': process.env.WORKER_RPC_TOKEN ?? '' } : {},
      },
    );
    process.exitCode = r.ok ? 0 : 1;
  }
} catch {
  process.exitCode = 1;
}
