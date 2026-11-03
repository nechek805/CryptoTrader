import { ResearchDatabase } from '@crypto/db';
import { seedDatabase, workingTreeVersion } from './database-fixtures.js';

async function main() {
  const command = process.argv[2];
  if (!['migrate', 'seed', 'clean'].includes(command ?? '') || process.argv.length !== 3)
    throw new Error();
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error();
  const schema = process.env.DATABASE_SCHEMA ?? 'crypto_research';
  if ((command === 'seed' || command === 'clean') && !/^crypto_fixture_[a-z0-9_]+$/.test(schema))
    throw new Error();
  const db = new ResearchDatabase({ connectionString, schema });
  try {
    const result =
      command === 'migrate'
        ? { schemaVersion: 'migration-report.v1', schema, applied: await db.migrate() }
        : command === 'clean'
          ? { schemaVersion: 'fixture-clean-report.v1', schema, applied: await db.resetFixtures() }
          : await seedDatabase(db, await workingTreeVersion());
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await db.close();
  }
}
void main().catch(() => {
  process.stderr.write(
    'Database command failed. Check PostgreSQL, DATABASE_URL, DATABASE_SCHEMA and migrations. Seed/clean require crypto_fixture_* schemas.\n',
  );
  process.exitCode = 1;
});
