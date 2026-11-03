import { open, mkdir, readFile, lstat, realpath, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { NewsCorrectionRecord } from '@crypto/contracts';
import { canonicalJson } from '@crypto/core';
import { validateNewsCorrectionChain, NewsReviewError } from './review.js';

const limit = 64 * 1024 * 1024;
/** One owner; correction operations in NewsReviewService are serialized within that owner. */
export class NewsCorrectionJournal {
  #closed = false;
  #failed = false;
  private constructor(
    private readonly file: FileHandle,
    private readonly lock: FileHandle,
    private readonly lockPath: string,
    readonly records: readonly NewsCorrectionRecord[],
    private bytes: number,
  ) {}
  static async acquire(directory: string) {
    await mkdir(directory, { recursive: true });
    const root = await realpath(directory),
      lockPath = join(root, 'corrections.lock'),
      lock = await open(lockPath, 'wx');
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid }));
      await lock.sync();
      const path = join(root, 'corrections.jsonl');
      try {
        const info = await lstat(path);
        if (!info.isFile() || info.size > limit) throw new NewsReviewError('INTEGRITY');
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      const file = await open(path, 'a+');
      try {
        const body = await readFile(path, 'utf8');
        if (Buffer.byteLength(body) > limit || (body && !body.endsWith('\n')))
          throw new NewsReviewError('INTEGRITY');
        const records = validateNewsCorrectionChain(
          body
            ? body
                .slice(0, -1)
                .split('\n')
                .map((s) => JSON.parse(s) as unknown)
            : [],
        );
        return new NewsCorrectionJournal(file, lock, lockPath, records, Buffer.byteLength(body));
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
  async append(record: NewsCorrectionRecord) {
    if (this.#closed || this.#failed) throw new NewsReviewError('INTEGRITY');
    validateNewsCorrectionChain([...this.records, record]);
    const line = `${canonicalJson(record)}\n`;
    if (this.bytes + Buffer.byteLength(line) > limit) throw new NewsReviewError('CAPACITY');
    try {
      await this.file.writeFile(line);
      await this.file.sync();
    } catch (error) {
      this.#failed = true;
      throw error;
    }
    (this.records as NewsCorrectionRecord[]).push(record);
    this.bytes += Buffer.byteLength(line);
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
