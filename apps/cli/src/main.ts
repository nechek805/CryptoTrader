import { runCli } from './commands.js';

void runCli(process.argv.slice(2))
  .then((report) => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  })
  .catch(() => {
    process.stderr.write(
      'Doctor/smoke failed. Check Node, configuration and fixtures. Usage: doctor | smoke --dry-run\n',
    );
    process.exitCode = 1;
  });
