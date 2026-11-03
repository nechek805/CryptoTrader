import { loadConfig } from '@crypto/core';
import { runFixtureWorker } from '@crypto/worker';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const fixtures = await runFixtureWorker();
  const app = buildApp(config, fixtures);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void app.close().catch(() => {
        process.exitCode = 1;
      });
    });
  }

  try {
    await app.listen({ host: config.host, port: config.port });
    app.log.info(
      { mode: config.dataMode, fixtures, execution: 'disabled' },
      'Fixture startup ready',
    );
  } catch (error) {
    await app.close();
    throw error;
  }
}

void main().catch(() => {
  // Avoid reflecting environment values, provider credentials or file contents into logs.
  process.stderr.write('Startup failed. Check runtime, DATA_MODE, HOST, PORT and fixture files.\n');
  process.exitCode = 1;
});
