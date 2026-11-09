import { existsSync, mkdirSync, lstatSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import console from 'node:console';
import { URL } from 'node:url';
/** Starts only this checkout's dedicated loopback cluster. Never controls Windows services. */
export function ensureLivePostgres(root, configuration) {
  const setting = (key) => process.env[key] ?? configuration[key];
  if (setting('LIVE_PAPER_ENABLED') !== '1' || setting('LIVE_PAPER_AUTO_DB') !== '1') return;
  if (process.platform !== 'win32')
    throw new Error(
      'Set LIVE_PAPER_AUTO_DB=0 and supply an existing PostgreSQL URL on this platform.',
    );
  const url = new URL(setting('LIVE_PAPER_DATABASE_URL') ?? '');
  if (
    url.protocol !== 'postgresql:' ||
    url.hostname !== '127.0.0.1' ||
    url.username !== 'research' ||
    url.password ||
    url.pathname !== '/postgres' ||
    !url.port ||
    url.search
  )
    throw new Error(
      'Automatic local live-paper DB requires the documented dedicated loopback URL.',
    );
  const tools = resolve(root, '.tools'),
    data = resolve(tools, 'postgres-live-paper');
  if (!data.startsWith(resolve(root) + sep) || data === resolve(root))
    throw new Error('Invalid database directory');
  for (const path of [tools, data])
    if (existsSync(path) && lstatSync(path).isSymbolicLink())
      throw new Error('Database directory cannot be a symbolic link');
  mkdirSync(tools, { recursive: true });
  const bin = setting('PG_BIN_DIR') ?? 'C:\\Program Files\\PostgreSQL\\18\\bin';
  const run = (name, args) =>
    spawnSync(join(bin, name + '.exe'), args, {
      cwd: root,
      windowsHide: true,
      stdio: 'ignore',
      timeout: 60000,
    });
  if (!existsSync(join(data, 'PG_VERSION'))) {
    const init = run('initdb', [
      '-D',
      data,
      '-U',
      'research',
      '-A',
      'trust',
      '--encoding=UTF8',
      '--locale=C',
    ]);
    if (init.error || init.status !== 0)
      throw new Error('Could not initialize dedicated live-paper PostgreSQL. Check PG_BIN_DIR.');
  }
  const status = run('pg_ctl', ['-D', data, 'status']);
  if (status.status !== 0) {
    const start = run('pg_ctl', [
      '-D',
      data,
      '-l',
      join(tools, 'postgres-live-paper.log'),
      '-o',
      `-h 127.0.0.1 -p ${url.port} -c timezone=UTC -c log_parameter_max_length=0 -c log_parameter_max_length_on_error=0`,
      '-w',
      'start',
    ]);
    if (start.error || start.status !== 0)
      throw new Error(
        'Could not start dedicated live-paper PostgreSQL. Check .tools/postgres-live-paper.log and configured port.',
      );
  }
  console.log(`Live-paper PostgreSQL ready on 127.0.0.1:${url.port}`);
}
