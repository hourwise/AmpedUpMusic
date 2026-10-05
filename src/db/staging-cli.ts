/**
 * Remote STAGING database operations (AMPED-CF-01).
 *
 * WHY NOT `wrangler d1 migrations apply`
 * This repository already has a migration discipline. Wrangler's command
 * keeps its own `d1_migrations` ledger, which knows nothing about
 * `schema_migrations`, the per-file checksums, or the compound-statement
 * markers migration 0011 depends on. Running it would apply every file a
 * second time. `wrangler.jsonc` has warned about this since AMPED-02A.
 *
 * WHY NOT `getPlatformProxy({ remoteBindings: true })`
 * Because it does not do what it says here. Tested before relying on it: a
 * table created through such a proxy, with `environment: 'staging'`, did NOT
 * appear in the remote database - `wrangler d1 execute --remote` showed only
 * `_cf_KV`. It had written to a local simulation. A migration tool that
 * silently targets the wrong database is worse than no tool, so the proxy is
 * not used. (It also loads `.dev.vars`, so `AMPED_ENV` read through it says
 * `development` whatever the environment selects.)
 *
 * WHAT THIS DOES INSTEAD
 * It provides TRANSPORT ONLY: a minimal `D1Database`-shaped shim over
 * `wrangler d1 execute DB --env staging --remote`, handed to the
 * SAME `migrate()` the local scripts and the test suite use. Every decision
 * that matters - which migrations exist, their order, their checksums, what
 * the ledger records - stays in `src/db/migrations.ts`, untouched. The target
 * database is named explicitly on every single call, so there is no ambiguity
 * about what is being written.
 *
 * KNOWN LIMITATION, AND WHY IT IS ACCEPTABLE HERE
 * The real `db.batch()` is atomic. This shim is NOT: it sends one statement
 * per invocation. One `--file` per migration was tried first and corrupted
 * migration 0011 - wrangler splits a file on semicolons, which mangles that
 * migration's trigger body and produced "SQL code did not contain a
 * statement". Correct statement boundaries matter more than a transaction
 * this transport cannot give us anyway.
 *
 * The ledger insert is LAST, so a partial failure leaves the schema ahead of
 * the ledger and never the reverse: the next run retries the migration
 * rather than skipping it, and on an empty staging database the remedy is to
 * drop and recreate. That trade is fine for bootstrapping staging and is NOT
 * fine for production, which needs a transactional path. Adopting one is its
 * own slice.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PROJECT_ROOT, listTables } from './local.ts';
import { loadMigrations, migrate, readAppliedMigrations } from './migrations.ts';

/** The only database this tool will ever write to. No override exists. */
const STAGING_BINDING = 'DB';
const MIGRATIONS_DIR = join(PROJECT_ROOT, 'migrations');
const WRANGLER_BIN = join(PROJECT_ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

interface D1Row {
  [key: string]: unknown;
}

/** Run one wrangler invocation against the named remote database. */
function execute(args: string[]): D1Row[] {
  // Wrangler's JS entry directly, not `npx`: a `.cmd` shim cannot be spawned
  // without a shell on Windows, and going through a shell would mean quoting
  // SQL on the command line.
  let output: string;
  try {
    output = execFileSync(
      process.execPath,
      [WRANGLER_BIN, 'd1', 'execute', STAGING_BINDING, '--env', 'staging', '--remote', '--json', ...args],
      { cwd: PROJECT_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (error) {
    // Wrangler reports the real SQL problem on stderr; surfacing only
    // "command failed" would make every migration failure undebuggable.
    const detail = (error as { stderr?: string; stdout?: string });
    throw new Error(
      `wrangler d1 execute failed
${detail.stderr ?? ''}
${detail.stdout ?? ''}`.trim(),
    );
  }
  // Wrangler prints a banner before the JSON; take from the first bracket.
  const start = output.indexOf('[');
  if (start === -1) return [];
  const parsed = JSON.parse(output.slice(start)) as Array<{ results?: D1Row[] }>;
  return parsed.flatMap((entry) => entry.results ?? []);
}

/** SQLite string literal. Only ever used for values the runner generates. */
function quote(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

/** Substitute anonymous `?` placeholders in order. */
function inline(sql: string, params: readonly unknown[]): string {
  if (params.length === 0) return sql;
  let index = 0;
  return sql.replace(/\?/g, () => quote(params[index++]));
}

class RemoteStatement {
  // Plain fields, not parameter properties: `node src/db/*.ts` runs under
  // Node's strip-only TypeScript, which rejects those.
  readonly sql: string;
  readonly params: readonly unknown[];

  constructor(sql: string, params: readonly unknown[] = []) {
    this.sql = sql;
    this.params = params;
  }

  bind(...params: unknown[]): RemoteStatement {
    return new RemoteStatement(this.sql, params);
  }

  text(): string {
    return inline(this.sql, this.params);
  }

  async run(): Promise<{ success: true }> {
    execute(['--command', this.text()]);
    return { success: true };
  }

  async all<T = D1Row>(): Promise<{ results: T[]; success: true }> {
    return { results: execute(['--command', this.text()]) as T[], success: true };
  }

  async first<T = D1Row>(): Promise<T | null> {
    const rows = execute(['--command', this.text()]);
    return (rows[0] as T) ?? null;
  }
}

/** The narrow slice of `D1Database` the accepted migration runner needs. */
function remoteStagingDatabase(): D1Database {
  return {
    prepare: (sql: string) => new RemoteStatement(sql),
    async batch(statements: RemoteStatement[]) {
      // ONE `--command` PER STATEMENT, not one `--file` for the batch.
      //
      // `--file` was tried first and migration 0011 failed on it with "SQL
      // code did not contain a statement": wrangler splits a file on
      // semicolons, which mangles 0011's trigger body. That trigger is
      // exactly why this repository carries its own compound-statement
      // markers and its own runner. `--command` sends the statement whole.
      //
      // Statements run in the order the runner produced them, with the
      // ledger insert last, so a failure part-way leaves the schema ahead of
      // the ledger and never the reverse.
      for (const statement of statements) execute(['--command', statement.text()]);
      return statements.map(() => ({ success: true }));
    },
  } as unknown as D1Database;
}

/** A directory holding migrations 0001..`upTo` only, for a staged run. */
function migrationsUpTo(upTo: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'amped-staging-migrations-'));
  for (const name of readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith('.sql')).sort()) {
    if (name.slice(0, 4) > upTo) continue;
    // Copied byte-for-byte: the runner checksums file CONTENTS, so a copy
    // produces the identical ledger entry a full run would.
    copyFileSync(join(MIGRATIONS_DIR, name), join(dir, name));
  }
  return dir;
}

async function runMigrate(upTo?: string): Promise<void> {
  const db = remoteStagingDatabase();
  const dir = upTo ? migrationsUpTo(upTo) : MIGRATIONS_DIR;
  try {
    const result = await migrate(db, { dir });
    for (const migration of result.applied) {
      console.log(`applied  ${migration.name} (${migration.statements.length} statements)`);
    }
    console.log(
      `staging migrate: ${result.applied.length} applied, ${result.alreadyApplied.length} already present`,
    );
  } finally {
    if (upTo) rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The mandatory pre-check for migration 0012.
 *
 * 0012 adds a partial UNIQUE index on non-null `payment_reference`. With
 * duplicates it would fail on apply - and, far worse, duplicates would mean a
 * checkout id does not uniquely identify an order, so the webhook and the
 * reconciler could credit the wrong customer.
 */
async function runDuplicateCheck(): Promise<void> {
  const db = remoteStagingDatabase();
  const total = await db.prepare('select count(*) as n from orders').first<{ n: number }>();
  const nonNull = await db
    .prepare('select count(*) as n from orders where payment_reference is not null')
    .first<{ n: number }>();
  const dupes = await db
    .prepare(
      'select payment_reference, count(*) as n from orders ' +
        'where payment_reference is not null group by payment_reference having count(*) > 1',
    )
    .all<{ payment_reference: string; n: number }>();

  console.log(`orders:                     ${total?.n ?? 0}`);
  console.log(`non-null payment_reference: ${nonNull?.n ?? 0}`);
  console.log(`DUPLICATES:                 ${dupes.results.length}`);
  for (const row of dupes.results) console.log(`  DUP ${row.payment_reference} x${row.n}`);
  console.log(dupes.results.length === 0 ? 'PRE-CHECK PASS' : 'PRE-CHECK FAIL');
  if (dupes.results.length > 0) process.exitCode = 1;
}

async function runInspect(): Promise<void> {
  const db = remoteStagingDatabase();
  const applied = await readAppliedMigrations(db);
  const expected = loadMigrations();
  console.log(`ledger rows: ${applied.length}`);
  for (const row of applied) {
    console.log(`  ${row.id}  ${row.name}  ${String(row.checksum).slice(0, 12)}...`);
  }
  const tables = await listTables(db);
  console.log(`tables (${tables.length}): ${tables.join(', ')}`);

  // Inspect must prove that the remote ledger describes the files in this
  // checkout before anyone assumes the schema is ready. This is read-only.
  const recorded = new Map(applied.map((row) => [row.id, row]));
  const expectedIds = new Set(expected.map((migration) => migration.id));
  const problems = expected.flatMap((migration) => {
    const row = recorded.get(migration.id);
    if (!row) return [`missing ${migration.name}`];
    if (row.name !== migration.name || row.checksum !== migration.checksum) {
      return [`mismatch ${migration.name}`];
    }
    return [];
  });
  for (const row of applied) {
    if (!expectedIds.has(row.id)) problems.push(`unexpected ${row.name}`);
  }
  if (problems.length > 0) throw new Error(`ledger does not match local migrations: ${problems.join(', ')}`);
  console.log(`ledger verified: ${expected.length} local migration files match remote checksums`);
}

const [command, argument] = process.argv.slice(2);

const USAGE = `
Amped Up STAGING database (remote, "${STAGING_BINDING}" in staging only)

  node src/db/staging-cli.ts migrate [0011]   apply migrations, optionally up to a prefix
  node src/db/staging-cli.ts check-duplicates run the mandatory 0012 pre-check
  node src/db/staging-cli.ts inspect          verify ledger checksums and list tables
`.trim();

try {
  if (command === 'migrate') await runMigrate(argument);
  else if (command === 'check-duplicates') await runDuplicateCheck();
  else if (command === 'inspect') await runInspect();
  else {
    console.log(USAGE);
    process.exitCode = command ? 1 : 0;
  }
} catch (error) {
  console.error(`staging: failed - ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
