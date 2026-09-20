/**
 * `npm run db:migrate` / `db:seed` / `db:reset`.
 *
 * Every command here is local-only: `openLocalDatabase()` refuses remote
 * bindings, and the persistence path is `.wrangler/state`, which is
 * git-ignored. Nothing in this file can reach a deployed database, and no
 * Cloudflare credential is read.
 *
 * `db:reset` leaves an EMPTY database. It deliberately does not migrate or
 * seed, so that the documented sequence
 *
 *     npm run db:reset && npm run db:migrate && npm run db:seed
 *
 * means what it says, and so that "migrations reproduce the schema from
 * empty" is exercised by the scripts rather than asserted in a comment.
 */

import {
  LOCAL_D1_STATE_DIR,
  deleteLocalDatabaseFiles,
  listTables,
  openLocalDatabase,
} from './local.ts';
import { migrate } from './migrations.ts';
import { applySeed } from './seed.ts';

const USAGE = `
Amped Up local D1 (development only)

  npm run db:migrate   Apply pending migrations from ./migrations
  npm run db:seed      Load the fixture-equivalent seed dataset
  npm run db:reset     Delete the local database file, leaving it empty

Local state lives in .wrangler/state (git-ignored). No remote database,
credential or Cloudflare account is used by any of these commands.
`.trim();

async function withDatabase<T>(fn: (db: D1Database) => Promise<T>): Promise<T> {
  const { db, dispose } = await openLocalDatabase();
  try {
    return await fn(db);
  } finally {
    await dispose();
  }
}

async function runMigrate(): Promise<void> {
  await withDatabase(async (db) => {
    const result = await migrate(db);

    if (result.applied.length === 0) {
      console.log(`db:migrate  nothing to do (${result.alreadyApplied.length} already applied)`);
      return;
    }

    for (const migration of result.applied) {
      console.log(`db:migrate  applied ${migration.name} (${migration.statements.length} statements)`);
    }
    console.log(`db:migrate  ${result.applied.length} applied, ${result.alreadyApplied.length} already present`);
  });
}

async function runSeed(): Promise<void> {
  await withDatabase(async (db) => {
    const result = await applySeed(db);

    for (const [label, count] of Object.entries(result.counts)) {
      console.log(`db:seed     ${label.padEnd(24)} ${count}`);
    }
    console.log(`db:seed     ${result.totalRows} rows in ${result.statements} statements`);
  });
}

async function runReset(): Promise<void> {
  const removed = deleteLocalDatabaseFiles();
  console.log(
    removed
      ? `db:reset    removed ${LOCAL_D1_STATE_DIR}`
      : `db:reset    ${LOCAL_D1_STATE_DIR} did not exist; nothing to remove`,
  );

  // Verify rather than assume: an empty database is the whole contract of this
  // command, and a wrong persistence path would otherwise fail silently.
  await withDatabase(async (db) => {
    const tables = await listTables(db);
    if (tables.length > 0) {
      throw new Error(
        `db:reset removed ${LOCAL_D1_STATE_DIR} but the database still contains ` +
          `${tables.length} tables (${tables.slice(0, 5).join(', ')}...). ` +
          'Local state is being persisted somewhere else; do not continue until that is understood.',
      );
    }
    console.log('db:reset    local database is empty');
  });
}

async function main(): Promise<void> {
  const command = process.argv[2];

  switch (command) {
    case 'migrate':
      await runMigrate();
      return;
    case 'seed':
      await runSeed();
      return;
    case 'reset':
      await runReset();
      return;
    default:
      console.log(USAGE);
      process.exitCode = command === undefined || command === '--help' || command === '-h' ? 0 : 1;
  }
}

main().catch((error: unknown) => {
  console.error(`db: failed - ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
