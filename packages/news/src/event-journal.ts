import { open, mkdir, lstat, readFile, realpath, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { NewsEventRecord } from '@crypto/contracts';
import { canonicalJson } from '@crypto/core';
import { validateNewsEventChain } from './events.js';
const limit = 64 * 1024 * 1024;
export class NewsEventJournal {
  #closed = false;
  #failed = false;
  private constructor(
    private readonly file: FileHandle,
    private readonly lock: FileHandle,
    private readonly lockPath: string,
    readonly config: unknown,
    readonly graphConfig: unknown,
    readonly records: readonly NewsEventRecord[],
    private bytes: number,
  ) {}
  static async acquire(directory: string, config: unknown, graphConfig: unknown) {
    validateNewsEventChain([], config, graphConfig);
    await mkdir(directory, { recursive: true });
    const root = await realpath(directory),
      lockPath = join(root, 'events.lock'),
      lock = await open(lockPath, 'wx');
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid }));
      await lock.sync();
      const path = join(root, 'events.jsonl');
      try {
        const info = await lstat(path);
        if (!info.isFile() || info.size > limit) throw new Error('Invalid event journal');
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      const file = await open(path, 'a+');
      try {
        const body = await readFile(path, 'utf8');
        if (Buffer.byteLength(body) > limit || (body && !body.endsWith('\n')))
          throw new Error('Incomplete event journal');
        const records = validateNewsEventChain(
          body
            ? body
                .slice(0, -1)
                .split('\n')
                .map((s) => JSON.parse(s) as unknown)
            : [],
          config,
          graphConfig,
        );
        return new NewsEventJournal(
          file,
          lock,
          lockPath,
          config,
          graphConfig,
          records,
          Buffer.byteLength(body),
        );
      } catch (error) {
        await file.close();
        throw error;
      }
    } catch (error) {
      await lock.close();
      await unlink(lockPath);
      throw error;
    }
  }
  async append(record: NewsEventRecord) {
    if (this.#closed || this.#failed) throw new Error('Event journal closed or failed');
    validateNewsEventChain([...this.records, record], this.config, this.graphConfig);
    const body = `${canonicalJson(record)}\n`;
    if (this.bytes + Buffer.byteLength(body) > limit) throw new Error('Event journal limit');
    try {
      await this.file.writeFile(body);
      await this.file.sync();
    } catch (error) {
      this.#failed = true;
      throw error;
    }
    (this.records as NewsEventRecord[]).push(record);
    this.bytes += Buffer.byteLength(body);
  }
  async close() {
    if (!this.#closed) {
      this.#closed = true;
      await this.file.close();
      await this.lock.close();
      await unlink(this.lockPath);
    }
  }
}
