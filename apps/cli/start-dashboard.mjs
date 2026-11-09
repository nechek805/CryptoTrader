import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import { parseEnv } from 'node:util';
import process from 'node:process';
import console from 'node:console';
import { ensureLivePostgres } from './live-paper-postgres.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

function main() {
  const envFile = join(root, '.env');
  const configuration = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
  const version = readFileSync(join(root, '.node-version'), 'utf8').trim().replace(/^v/, '');
  const portable = join(root, '.tools', `node-v${version}-win-x64`);
  const directory = process.env.NODE_RUNTIME_DIR ?? configuration.NODE_RUNTIME_DIR;
  const executable = directory
    ? join(resolve(root, directory), process.platform === 'win32' ? 'node.exe' : 'node')
    : process.platform === 'win32' && existsSync(portable)
      ? join(portable, 'node.exe')
      : process.execPath;
  const probe = spawnSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true });
  if (probe.error || probe.status !== 0)
    throw new Error('Node runtime unavailable. Check NODE_RUNTIME_DIR in the project .env file.');
  if (probe.stdout.trim() !== `v${version}`)
    throw new Error(
      `Node ${version} is required. Set NODE_RUNTIME_DIR in .env to that installation.`,
    );

  console.log(`Dashboard runtime ready: Node ${version}`);
  if (process.argv.length === 3 && process.argv[2] === '--check') return;
  if (process.argv.length !== 2) throw new Error('Usage: pnpm dashboard [--check]');
  ensureLivePostgres(root, configuration);

  // Apply PATH only to the dashboard process; preserve the user's shell and other projects.
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  const child = spawn(
    executable,
    [
      '--env-file-if-exists=.env',
      '--import',
      'tsx',
      join(root, 'apps', 'cli', 'src', 'dashboard.ts'),
    ],
    {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        [pathKey]: `${dirname(executable)}${delimiter}${process.env[pathKey] ?? ''}`,
      },
    },
  );
  child.once('error', () => {
    console.error('Dashboard could not start with the configured Node runtime.');
    process.exitCode = 1;
  });
  child.once('exit', (code) => {
    process.exitCode = code ?? 1;
  });
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => {
      child.kill(signal);
    });
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Dashboard startup failed.');
  process.exitCode = 1;
}
