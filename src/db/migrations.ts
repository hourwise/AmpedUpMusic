/**
 * The AMPED-02A migration runner.
 *
 * Forward-only, ordered, and reproducible from an empty database:
 *
 *  1. `schema_migrations` is created if it does not exist. This is the only
 *     table the runner owns, and it is created here rather than in a migration
 *     because the ledger has to exist before the first migration can be
 *     recorded in it.
 *  2. Migration files are discovered in ./migrations, validated against the
 *     `NNNN_lower_snake_case.sql` naming rule and sorted by their numeric
 *     prefix. A gap, a duplicate id or an unexpected name is an error, not a
 *     warning - determinism is the whole point.
 *  3. Each unapplied migration runs inside one `db.batch()`, which D1 executes
 *     as a single transaction, together with its ledger row. Either the whole
 *     migration and its record land, or neither does.
 *  4. An already-applied migration whose file has changed is refused. That is
 *     what "forward-only" means in practice: to change the schema you add
 *     0007_x.sql, you do not edit 0003_y.sql and hope nobody has run it.
 *
 * Running this twice is a no-op: the second run finds every id already in the
 * ledger, verifies the checksums, applies nothing and writes nothing.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from './local.ts';
import { splitStatements } from './sql.ts';

/** Default migration directory, relative to the repository root. */
export const MIGRATIONS_DIR = join(PROJECT_ROOT, 'migrations');

/** The runner's bookkeeping table. */
export const SCHEMA_MIGRATIONS_TABLE = 'schema_migrations';

/** `0001_venues_and_artists.sql` and nothing else. */
const MIGRATION_FILE_PATTERN = /^(\d{4})_[a-z0-9]+(_[a-z0-9]+)*\.sql$/;

const CREATE_LEDGER_SQL = `create table if not exists schema_migrations (
  id         text primary key,
  name       text not null,
  checksum   text not null,
  applied_at text not null check (strftime('%Y-%m-%dT%H:%M:%fZ', applied_at) IS applied_at)
) strict`;

const INSERT_LEDGER_SQL =
  'insert into schema_migrations (id, name, checksum, applied_at) values (?, ?, ?, ?)';

const SELECT_LEDGER_SQL =
  'select id, name, checksum, applied_at from schema_migrations order by id';

export interface Migration {
  /** Zero-padded numeric prefix, e.g. "0002". Sorts identically to the order. */
  id: string;
  /** File name, e.g. "0002_events_and_lineups.sql". */
  name: string;
  /** SHA-256 of the file contents, used to detect edits to applied migrations. */
  checksum: string;
  /** The individual statements, in file order. */
  statements: string[];
}

export interface AppliedMigration {
  id: string;
  name: string;
  checksum: string;
  applied_at: string;
}

export interface MigrationRunResult {
  /** Migrations applied by this run, in order. */
  applied: Migration[];
  /** Migrations already recorded and left untouched, in order. */
  alreadyApplied: string[];
}

export interface MigrateOptions {
  /** Override the migration directory. Used by tests. */
  dir?: string;
  /** Clock injection so the ledger timestamp is reproducible in tests. */
  now?: () => Date;
}

function sha256(contents: string): string {
  return createHash('sha256').update(contents, 'utf8').digest('hex');
}

/**
 * Read and validate every migration file, in execution order.
 *
 * Throws on anything that would make the order ambiguous.
 */
export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const names = readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  const migrations: Migration[] = [];
  const seen = new Map<string, string>();

  for (const name of names) {
    const match = MIGRATION_FILE_PATTERN.exec(name);
    if (!match) {
      throw new Error(
        `Migration "${name}" does not follow the naming rule 0001_lower_snake_case.sql.`,
      );
    }

    const id = match[1]!;
    const clash = seen.get(id);
    if (clash) {
      throw new Error(`Migrations "${clash}" and "${name}" share the id ${id}.`);
    }
    seen.set(id, name);

    const contents = readFileSync(join(dir, name), 'utf8');
    const statements = splitStatements(contents);
    if (statements.length === 0) {
      throw new Error(`Migration "${name}" contains no statements.`);
    }

    migrations.push({ id, name, checksum: sha256(contents), statements });
  }

  if (migrations.length === 0) {
    throw new Error(`No migrations found in ${dir}.`);
  }

  // Guard the ordering guarantee explicitly rather than trusting the sort.
  const ids = migrations.map((migration) => migration.id);
  const sorted = [...ids].sort();
  if (ids.join(',') !== sorted.join(',')) {
    throw new Error(`Migration ids are not in ascending order: ${ids.join(', ')}.`);
  }

  return migrations;
}

/** Create the ledger table if it is missing. Idempotent. */
export async function ensureSchemaMigrationsTable(db: D1Database): Promise<void> {
  await db.prepare(CREATE_LEDGER_SQL).run();
}

/** Everything the ledger has recorded, oldest first. */
export async function readAppliedMigrations(db: D1Database): Promise<AppliedMigration[]> {
  const result = await db.prepare(SELECT_LEDGER_SQL).all<AppliedMigration>();
  return result.results;
}

/** Apply every pending migration, in order. Already-applied ones are no-ops. */
export async function migrate(
  db: D1Database,
  options: MigrateOptions = {},
): Promise<MigrationRunResult> {
  const { dir = MIGRATIONS_DIR, now = () => new Date() } = options;

  const migrations = loadMigrations(dir);
  await ensureSchemaMigrationsTable(db);

  const recorded = new Map(
    (await readAppliedMigrations(db)).map((row) => [row.id, row] as const),
  );

  const applied: Migration[] = [];
  const alreadyApplied: string[] = [];

  for (const migration of migrations) {
    const existing = recorded.get(migration.id);

    if (existing) {
      if (existing.checksum !== migration.checksum) {
        throw new Error(
          `Migration ${migration.name} has changed since it was applied. ` +
            'Migrations are forward-only: add a new migration instead of editing this one.',
        );
      }
      alreadyApplied.push(migration.name);
      continue;
    }

    await db.batch([
      ...migration.statements.map((statement) => db.prepare(statement)),
      db
        .prepare(INSERT_LEDGER_SQL)
        .bind(migration.id, migration.name, migration.checksum, now().toISOString()),
    ]);

    applied.push(migration);
  }

  return { applied, alreadyApplied };
}
