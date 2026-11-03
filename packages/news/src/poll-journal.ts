import { open, mkdir, readFile, lstat, realpath, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { NewsPollConfigSchema, NewsPollRecordSchema } from '@crypto/contracts';
import type { NewsPollAction, NewsPollConfig } from '@crypto/contracts';
import { canonicalHash, canonicalJson } from '@crypto/core';

export const newsPollGenesis = canonicalHash({ schemaVersion: 'news-poll-chain.v1' });
const maxBytes = 64 * 1024 * 1024;
export class NewsPollJournal {
  readonly records: ReturnType<typeof NewsPollRecordSchema.parse>[];
  readonly config: NewsPollConfig;
  readonly configHash: string;
  #bytes: number;
  #closed = false;
  private constructor(
    private readonly file: FileHandle,
    private readonly lock: FileHandle,
    private readonly lockPath: string,
    config: NewsPollConfig,
    readonly codeVersion: string,
    records: ReturnType<typeof NewsPollRecordSchema.parse>[],
    bytes: number,
  ) {
    this.config = config;
    this.configHash = canonicalHash(config);
    this.records = records;
    this.#bytes = bytes;
  }
  static async acquire(directory: string, configInput: unknown, codeVersion: string) {
    const config = NewsPollConfigSchema.parse(configInput);
    await mkdir(directory, { recursive: true });
    const root = await realpath(directory),
      lockPath = join(root, 'poll.lock');
    const lock = await open(lockPath, 'wx');
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, configHash: canonicalHash(config) }));
      await lock.sync();
      const path = join(root, 'poll.jsonl');
      try {
        const info = await lstat(path);
        if (!info.isFile() || info.size > maxBytes) throw new Error('Invalid news poll journal');
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      const file = await open(path, 'a+');
      try {
        const body = await readFile(path, 'utf8');
        if (Buffer.byteLength(body) > maxBytes || (body && !body.endsWith('\n')))
          throw new Error('Incomplete news poll journal');
        const lines = body ? body.slice(0, -1).split('\n') : [];
        if (lines.length > 5000) throw new Error('News poll journal limit');
        let previousHash = newsPollGenesis;
        const records = lines.map((line, index) => {
          const record = NewsPollRecordSchema.parse(JSON.parse(line)),
            { hash, ...payload } = record;
          if (
            record.index !== index ||
            record.previousHash !== previousHash ||
            record.configHash !== canonicalHash(config) ||
            canonicalHash(payload) !== hash
          )
            throw new Error('News poll chain mismatch');
          previousHash = hash;
          return record;
        });
        return new NewsPollJournal(
          file,
          lock,
          lockPath,
          config,
          codeVersion,
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
  async append(input: NewsPollAction) {
    if (this.#closed || this.records.length >= 5000)
      throw new Error('News poll journal closed or full');
    const prior = this.records.at(-1);
    if (prior && input.at < prior.action.at) throw new Error('News polling clock regressed');
    const payload = {
      schemaVersion: 'news-poll-record.v1' as const,
      index: this.records.length,
      previousHash: prior?.hash ?? newsPollGenesis,
      configHash: this.configHash,
      codeVersion: this.codeVersion,
      action: input,
    };
    const record = NewsPollRecordSchema.parse({ ...payload, hash: canonicalHash(payload) }),
      line = `${canonicalJson(record)}\n`;
    if (this.#bytes + Buffer.byteLength(line) > maxBytes)
      throw new Error('News poll journal byte limit');
    await this.file.writeFile(line);
    await this.file.sync();
    this.records.push(record);
    this.#bytes += Buffer.byteLength(line);
    return record;
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
