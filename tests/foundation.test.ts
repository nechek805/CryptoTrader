import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '@crypto/api';
import { BootstrapFixtureSchema, HealthResponseSchema } from '@crypto/contracts';
import { loadConfig } from '@crypto/core';
import { runFixtureWorker } from '@crypto/worker';
import { doctor, runCli, smoke } from '../apps/cli/src/commands.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe('fixture-only foundation', () => {
  it('runs offline with an empty environment and repeatable fixture output', async () => {
    expect(loadConfig({})).toEqual({
      dataMode: 'fixture-only',
      host: '127.0.0.1',
      port: 3000,
      logLevel: 'info',
    });
    const first = await runFixtureWorker();
    expect(first).toEqual(await runFixtureWorker());
    expect(first.instruments).toEqual(['BTC/USDT', 'ETH/USDT', 'SOL/USDT']);
    expect(first.instrumentCount).toBe(3);
    expect(first.ordersCreated).toBe(0);
  });

  it.each([
    { DATA_MODE: 'live' },
    { DATA_MODE: 'paper' },
    { PORT: '0' },
    { PORT: '65536' },
    { PORT: '3000.5' },
    { PORT: '' },
    { HOST: '0.0.0.0' },
    { LOG_LEVEL: 'everything' },
  ])('refuses unsupported or unsafe configuration: %j', (env) => {
    expect(() => loadConfig(env)).toThrow();
  });

  it('fails closed for absent or malformed fixtures', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'crypto-foundation-'));
    temporaryDirectories.push(directory);
    const fixture = pathToFileURL(join(directory, 'broken.json'));
    await expect(runFixtureWorker(fixture)).rejects.toThrow();
    await writeFile(fixture, '{broken json', 'utf8');
    await expect(runFixtureWorker(fixture)).rejects.toThrow();
    await writeFile(fixture, JSON.stringify({ mode: 'live' }), 'utf8');
    await expect(runFixtureWorker(fixture)).rejects.toThrow();
  });

  it('rejects duplicate inventory and timestamps without UTC timezone', () => {
    const fixture = {
      schemaVersion: 'bootstrap.v1',
      mode: 'fixture-only',
      fixtureAsOf: '2026-01-01T00:00:00.000Z',
      description: 'synthetic',
      instruments: ['BTC/USDT', 'ETH/USDT', 'BTC/USDT'],
    };
    expect(BootstrapFixtureSchema.safeParse(fixture).success).toBe(false);
    expect(
      BootstrapFixtureSchema.safeParse({
        ...fixture,
        instruments: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
        fixtureAsOf: '2026-01-01T00:00:00',
      }).success,
    ).toBe(false);
  });
});

describe('operational interfaces', () => {
  it('serves validated health, generated correlation IDs and no trading route', async () => {
    const app = buildApp(loadConfig({ LOG_LEVEL: 'silent' }), await runFixtureWorker());
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { 'x-request-id': 'untrusted-request' },
      });
      expect(response.statusCode).toBe(200);
      const body: unknown = response.json();
      expect(HealthResponseSchema.parse(body).execution).toBe('disabled');
      expect(response.headers['x-request-id']).toBeTruthy();
      expect(response.headers['x-request-id']).not.toBe('untrusted-request');
      expect(response.headers['cache-control']).toBe('no-store');
      const second = await app.inject('/health');
      expect(second.headers['x-request-id']).not.toBe(response.headers['x-request-id']);
      for (const url of ['/orders', '/withdrawals', '/trade']) {
        expect((await app.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(404);
      }
    } finally {
      await app.close();
    }
  });

  it('doctor and dry-run smoke exercise startup without required infrastructure', async () => {
    const report = await doctor({ PRIVATE_API_KEY: 'must-not-appear' });
    expect(report.status).toBe('ok');
    expect(report.dependencies).toEqual({ postgres: 'not-required', redis: 'not-required' });
    expect(JSON.stringify(report)).not.toContain('must-not-appear');
    const health = await smoke({});
    expect(health.fixtures).toEqual(report.fixtures);
    expect(await runCli(['doctor'], {})).toEqual(report);
    expect((await runCli(['smoke', '--dry-run'], {})).mode).toBe('fixture-only');
  });

  it('rejects unsupported CLI commands and a smoke command without dry-run', async () => {
    await expect(runCli(['trade'], {})).rejects.toThrow('Usage');
    await expect(runCli(['smoke'], {})).rejects.toThrow('Usage');
    await expect(runCli(['doctor'], { DATA_MODE: 'live' })).rejects.toThrow();
  });

  it('returns a failing exit code without reflecting invalid environment values', async () => {
    const secret = 'sensitive-invalid-mode';
    let failure: unknown;
    try {
      await execFileAsync(process.execPath, ['--import', 'tsx', 'apps/cli/src/main.ts', 'doctor'], {
        env: { ...process.env, DATA_MODE: secret },
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 1, stdout: '' });
    expect(failure).toHaveProperty('stderr');
    expect(String((failure as { stderr: string }).stderr)).not.toContain(secret);
  });
});
