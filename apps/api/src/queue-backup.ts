import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, readdir, lstat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
/** No shell, Docker socket or credentials in argv. pg_dump must match server major 17. */
export async function backupPaperDatabase(
  url: string,
  root: string,
  identity: string,
  now = Date.now(),
) {
  if (!root.startsWith('/') || !identity || identity.length > 200)
    throw new Error('Invalid backup target');
  const u = new URL(url);
  if (u.protocol !== 'postgresql:' || u.search || u.hash)
    throw new Error('Invalid backup database configuration');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const id = createHash('sha256').update(identity).digest('hex').slice(0, 24),
    dest = join(root, `${new Date(now).toISOString().slice(0, 10)}-${id}.dump`);
  try {
    const s = await lstat(dest);
    if (!s.isFile() || s.isSymbolicLink()) throw new Error('Unsafe existing backup');
    return { file: dest, bytes: s.size, reused: true };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const temp = dest + '.partial',
    env = {
      ...process.env,
      PGHOST: u.hostname,
      PGPORT: u.port || '5432',
      PGUSER: decodeURIComponent(u.username),
      PGPASSWORD: decodeURIComponent(u.password),
      PGDATABASE: decodeURIComponent(u.pathname.slice(1)),
    };
  const child = spawn('pg_dump', ['--format=custom', '--no-owner', '--no-acl'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', () => {
    /* Provider/connection details never enter logs. */
  });
  const completion = new Promise<void>((resolve, reject) => {
    child.once('error', () => reject(new Error('Database backup executable unavailable')));
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error('Database backup failed')),
    );
  });
  await Promise.all([completion, pipeline(child.stdout, createWriteStream(temp, { mode: 0o600 }))]);
  const validate = spawn('pg_restore', ['--list', temp], { stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => {
    validate.once('error', () => reject(new Error('Backup validation unavailable')));
    validate.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error('Backup validation failed')),
    );
  });
  await rename(temp, dest);
  for (const name of await readdir(root))
    if (/^\d{4}-\d{2}-\d{2}-[a-f0-9]{24}\.dump$/.test(name)) {
      const p = join(root, name),
        s = await lstat(p);
      if (s.isFile() && !s.isSymbolicLink() && now - s.mtimeMs > 8 * 86400000) await unlink(p);
    }
  return { file: dest, bytes: (await lstat(dest)).size, reused: false };
}
