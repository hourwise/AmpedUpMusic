/**
 * SQL file handling for the local migration runner.
 *
 * Why this exists at all: D1's `exec()` rejects a "statement" that is only a
 * comment, and the migration files are commented for review. Splitting here
 * means the comments are stripped once, deterministically, before anything
 * reaches the database - and it gives the runner a statement count it can
 * report and test.
 *
 * Only `--` line comments and un-nested block comments are understood, which
 * is all this repository's migration files use. Single-quoted string literals
 * are respected, including the `''` escape, so a `--` or `;` inside a literal
 * is never mistaken for the end of anything. Double-quoted identifiers are not
 * used by these migrations and are not treated as quoted regions.
 */

/** Strip SQL comments, leaving string literals untouched. */
export function stripSqlComments(sql: string): string {
  let out = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql.charAt(i);
    const next = sql.charAt(i + 1);

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
        out += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }

    if (inString) {
      out += char;
      if (char === "'") {
        if (next === "'") {
          out += next;
          i += 1;
        } else {
          inString = false;
        }
      }
      continue;
    }

    if (char === '-' && next === '-') {
      inLineComment = true;
      i += 1;
      continue;
    }

    if (char === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }

    if (char === "'") inString = true;

    out += char;
  }

  return out;
}

/**
 * Split a SQL script into individual statements.
 *
 * Comments are removed first, blank statements are dropped, and every
 * statement is trimmed. The result is fed to the database one statement at a
 * time, which is what D1's `prepare()` expects.
 */
export function splitStatements(sql: string): string[] {
  const stripped = stripSqlComments(sql);
  const statements: string[] = [];
  let current = '';
  let inString = false;

  for (let i = 0; i < stripped.length; i += 1) {
    const char = stripped.charAt(i);

    if (inString) {
      current += char;
      if (char === "'") {
        if (stripped.charAt(i + 1) === "'") {
          current += "'";
          i += 1;
        } else {
          inString = false;
        }
      }
      continue;
    }

    if (char === "'") {
      inString = true;
      current += char;
      continue;
    }

    if (char === ';') {
      statements.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  statements.push(current);

  return statements.map((statement) => statement.trim()).filter((statement) => statement.length > 0);
}
