import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url)),
  web = fileURLToPath(new URL('../../web/', import.meta.url)),
  requireWeb = createRequire(new URL('../../web/package.json', import.meta.url)),
  next = requireWeb.resolve('next/dist/bin/next'),
  api = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      fileURLToPath(new URL('../../api/src/operations-main.ts', import.meta.url)),
    ],
    { cwd: root, stdio: 'inherit', env: process.env },
  );
process.stdout.write('Verifying local research archives before opening the UI…\n');
let ready = false;
for (let attempt = 0; attempt < 300 && api.exitCode === null; attempt++) {
  try {
    ready = (await fetch('http://127.0.0.1:3101/ready', { signal: AbortSignal.timeout(500) })).ok;
  } catch {
    /* Startup only; fixed loopback endpoint. */
  }
  if (ready) break;
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
if (!ready) {
  api.kill('SIGTERM');
  throw new Error('Research API did not become ready');
}
const ui = spawn(
  process.execPath,
  [next, 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', '3100'],
  {
    cwd: web,
    stdio: 'inherit',
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
  },
);
let closing = false;
function stop() {
  if (closing) return;
  closing = true;
  api.kill('SIGTERM');
  ui.kill('SIGTERM');
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
api.once('exit', stop);
ui.once('exit', stop);
