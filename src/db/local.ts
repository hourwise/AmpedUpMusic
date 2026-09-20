/**
 * Local D1 access for the `db:*` scripts and the schema tests.
 *
 * AMPED-02A is local-only, and this module is where that is enforced rather
 * than merely intended:
 *
 *  - `remoteBindings: false` makes Wrangler refuse to resolve a binding
 *    against a remote service. The binding cannot reach production even if a
 *    later slice configures one, because this module never opts in.
 *  - `persist: true` uses the same `.wrangler/state` directory as
 *    `wrangler dev`, so `npm run dev` and `npm run db:seed` see one database.
 *    That directory is git-ignored; no database file is ever committed.
 *  - Nothing in this file is imported by the application. `src/db/**` is
 *    used by scripts and tests only; no page, component or service reads it,
 *    which is why AMPED-02A changes no application behaviour at all.
 *
 * The D1 binding is read from a real `D1Database` proxy rather than from a
 * SQL string, so every statement written against it can be parameterised.
 */

import { existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPlatformProxy } from 'wrangler';

/** Repository root, derived from this file's location (src/db/local.ts). */
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The Wrangler config every db:* script and test reads. */
export const WRANGLER_CONFIG_PATH = join(PROJECT_ROOT, 'wrangler.jsonc');

/** Wrangler's local persistence root for this project. Git-ignored. */
export const LOCAL_STATE_DIR = join(PROJECT_ROOT, '.wrangler', 'state');

/** Wrangler's local D1 storage. Only this subtree is ever reset. */
export const LOCAL_D1_STATE_DIR = join(LOCAL_STATE_DIR, 'v3', 'd1');

/** The bindings this project declares for the local run. */
export interface LocalBindings {
  DB: D1Database;
  AMPED_ENV: string;
}

export interface LocalDatabase {
  db: D1Database;
  dispose(): Promise<void>;
}

/**
 * Open the local D1 database.
 *
 * Fails loudly rather than silently falling back to fixtures: if the binding
 * is missing, the config is wrong and the caller must know.
 */
export async function openLocalDatabase(): Promise<LocalDatabase> {
  return openDatabase(true);
}

/**
 * Open an isolated, throwaway database for tests.
 *
 * `persist: false` means nothing is written to disk, so each call starts from
 * an empty database and the developer's local data is untouched. It is the
 * same binding, the same runtime and the same SQL as the real thing.
 */
export async function openEphemeralDatabase(): Promise<LocalDatabase> {
  return openDatabase(false);
}

async function openDatabase(persist: boolean): Promise<LocalDatabase> {
  const proxy = await getPlatformProxy<LocalBindings>({
    configPath: WRANGLER_CONFIG_PATH,
    persist,
    remoteBindings: false,
  });

  const db = proxy.env.DB;
  if (!db) {
    await proxy.dispose();
    throw new Error(
      `No "DB" D1 binding was resolved from ${WRANGLER_CONFIG_PATH}. ` +
        'AMPED-02A expects a local d1_databases entry with the binding name "DB".',
    );
  }

  return { db, dispose: () => proxy.dispose() };
}

/**
 * Every user table in the database, oldest first.
 *
 * Wrangler's local D1 keeps its own bookkeeping in `_cf_METADATA`, which is
 * not part of this schema and is filtered out alongside SQLite's internals.
 */
export async function listTables(db: D1Database): Promise<string[]> {
  const result = await db
    .prepare(
      "select name from sqlite_master where type = 'table' " +
        "and name not like 'sqlite_%' and name not like '_cf_%' order by name",
    )
    .all<{ name: string }>();
  return result.results.map((row) => row.name);
}

/**
 * Delete the local D1 database file.
 *
 * Deliberately narrow: only `.wrangler/state/v3/d1` is removed, so any future
 * local KV or R2 state is untouched. The caller is expected to verify that the
 * result really is an empty database - see `resetLocalDatabase` in cli.ts.
 */
export function deleteLocalDatabaseFiles(): boolean {
  if (!existsSync(LOCAL_D1_STATE_DIR)) return false;
  rmSync(LOCAL_D1_STATE_DIR, { recursive: true, force: true });
  return true;
}
