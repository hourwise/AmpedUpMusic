/**
 * AMPED-06C0 - compound migration statement support.
 *
 * Proves the explicit `-- amped:statement-begin/end` mechanism transports one
 * SQLite statement that contains internal semicolons (a trigger), that legacy
 * splitting is byte-for-byte unchanged, that malformed markers fail closed, and
 * that a real trigger created through the splitter/runner path both exists and
 * fires.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { getPlatformProxy } from 'wrangler';

import {
  COMPOUND_STATEMENT_BEGIN,
  COMPOUND_STATEMENT_END,
  splitStatements,
  stripSqlComments,
} from '../src/db/sql.ts';
import { WRANGLER_CONFIG_PATH } from '../src/db/local.ts';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const TRIGGER_SQL = `${COMPOUND_STATEMENT_BEGIN}
CREATE TRIGGER test_guard
BEFORE UPDATE OF n ON test_guard_table
BEGIN
  SELECT RAISE(ABORT, 'test_guard');
END;
${COMPOUND_STATEMENT_END}`;

describe('AMPED-06C0 splitStatements', () => {
  it('splits ordinary statements exactly as before', () => {
    expect(splitStatements('create table a (id text); create table b (id text);')).toEqual([
      'create table a (id text)',
      'create table b (id text)',
    ]);
    expect(splitStatements('  ;  ')).toEqual([]);
  });

  it('keeps a semicolon inside a single-quoted string', () => {
    const statements = splitStatements("insert into t values ('a;b'); insert into t values ('c');");
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("'a;b'");
  });

  it('strips comments outside compound blocks as before', () => {
    const statements = splitStatements('-- hello\ncreate table x (id text); /* mid */');
    expect(statements).toEqual(['create table x (id text)']);
    expect(stripSqlComments('select 1 -- x')).toBe('select 1 ');
  });

  it('returns a compound trigger as one statement', () => {
    const statements = splitStatements(TRIGGER_SQL);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('CREATE TRIGGER test_guard');
    expect(statements[0]).toContain('BEGIN');
    expect(statements[0]).toContain('END');
    expect(statements[0]).not.toContain('amped:statement');
  });

  it('keeps a multi-statement trigger body as one statement', () => {
    const sql = `${COMPOUND_STATEMENT_BEGIN}
CREATE TRIGGER multi_guard BEFORE UPDATE ON t
BEGIN
  SELECT RAISE(ABORT, 'first');
  SELECT RAISE(ABORT, 'second');
END;
${COMPOUND_STATEMENT_END}`;
    const statements = splitStatements(sql);
    expect(statements).toHaveLength(1);
    // Two body statements plus the trigger's closing terminator.
    expect(statements[0]!.match(/;/g)?.length).toBe(3);
  });

  it('keeps semicolons inside trigger strings and CASE expressions intact', () => {
    const sql = `${COMPOUND_STATEMENT_BEGIN}
CREATE TRIGGER case_guard BEFORE UPDATE ON t
BEGIN
  SELECT CASE WHEN new.n = 1 THEN RAISE(ABORT, 'one;two') ELSE RAISE(ABORT, 'other') END;
END;
${COMPOUND_STATEMENT_END}`;
    const statements = splitStatements(sql);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("'one;two'");
    expect(statements[0]).toContain('CASE');
  });

  it('splits a compound trigger plus an ordinary statement', () => {
    const statements = splitStatements(`${TRIGGER_SQL}\nCREATE INDEX t_n_idx ON test_guard_table (n);`);
    expect(statements).toHaveLength(2);
    expect(statements[1]).toBe('CREATE INDEX t_n_idx ON test_guard_table (n)');
  });

  it('preserves an ordinary statement before a compound trigger', () => {
    const statements = splitStatements(`CREATE TABLE before_t (id text);\n${TRIGGER_SQL}`);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toBe('CREATE TABLE before_t (id text)');
    expect(statements[1]).toContain('CREATE TRIGGER test_guard');
  });

  it('does not interpret marker text inside a SQL string', () => {
    const statements = splitStatements(
      `insert into t values ('${COMPOUND_STATEMENT_BEGIN}'); create table y (id text);`,
    );
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain(COMPOUND_STATEMENT_BEGIN);
  });

  it('does not interpret a partial marker comment', () => {
    const statements = splitStatements('-- amped:statement-beginning\ncreate table z (id text);');
    expect(statements).toEqual(['create table z (id text)']);
  });

  it('fails closed on malformed marker structures', () => {
    expect(() => splitStatements(`${COMPOUND_STATEMENT_BEGIN}\nselect 1;`)).toThrow(/not closed/);
    expect(() => splitStatements(`select 1;\n${COMPOUND_STATEMENT_END}`)).toThrow(/end without begin/);
    expect(() =>
      splitStatements(
        `${COMPOUND_STATEMENT_BEGIN}\n${COMPOUND_STATEMENT_BEGIN}\nselect 1;\n${COMPOUND_STATEMENT_END}`,
      ),
    ).toThrow(/nested/);
    expect(() =>
      splitStatements(`${COMPOUND_STATEMENT_BEGIN}\n  \n${COMPOUND_STATEMENT_END}`),
    ).toThrow(/empty/);
  });

  it('leaves the accepted migrations statement counts unchanged', () => {
    const files = readdirSync(join(root, 'migrations')).filter((name) => name.endsWith('.sql')).sort();
    expect(files).toHaveLength(14);
    const counts = files.filter((name) => name < '0014_').map((name) =>
      splitStatements(readFileSync(join(root, 'migrations', name), 'utf8')).length,
    );
    // The counts the accepted runner reports for 0001..0013 (0011 is the
    // compound-marked capacity trigger and 0012 the payment-reference unique
    // index, one statement each; 0013 is two discrepancy tables plus their
    // four indexes).
    expect(counts).toEqual([4, 5, 7, 16, 4, 4, 2, 1, 1, 1, 1, 1, 6]);
  });
});

describe('AMPED-06C0 real D1 trigger proof', () => {
  it('creates and fires a trigger through the splitter/runner path', async () => {
    const proxy = await getPlatformProxy({
      configPath: WRANGLER_CONFIG_PATH,
      persist: false,
      remoteBindings: false,
    });
    const db = (proxy.env as { DB: D1Database }).DB;

    try {
      await db.prepare('create table test_guard_table (id text primary key, n integer)').run();

      // Exactly the migration runner's path: split -> prepare -> db.batch.
      const statements = splitStatements(TRIGGER_SQL);
      expect(statements).toHaveLength(1);
      await db.batch(statements.map((statement) => db.prepare(statement)));

      const trigger = await db
        .prepare("select name from sqlite_master where type = 'trigger' and name = 'test_guard'")
        .first<{ name: string }>();
      expect(trigger?.name).toBe('test_guard');

      await db.prepare("insert into test_guard_table values ('a', 1)").run();
      await expect(
        db.prepare("update test_guard_table set n = 2 where id = 'a'").run(),
      ).rejects.toThrow(/test_guard/);
      const row = await db
        .prepare("select n from test_guard_table where id = 'a'")
        .first<{ n: number }>();
      expect(row?.n).toBe(1);
    } finally {
      await proxy.dispose();
    }
  });
});
