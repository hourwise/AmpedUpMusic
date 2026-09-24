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
 * Explicit compound-statement directives (AMPED-06C0).
 *
 * A migration can wrap ONE SQLite statement that legitimately contains internal
 * semicolons (a `CREATE TRIGGER ... BEGIN ... ; ... END`) in these markers. The
 * markers are recognised only as exact, trimmed comment lines outside string
 * literals, so the same text inside a quoted value is ordinary SQL.
 */
export const COMPOUND_STATEMENT_BEGIN = '-- amped:statement-begin';
export const COMPOUND_STATEMENT_END = '-- amped:statement-end';

/**
 * Split a SQL script into individual statements.
 *
 * Comments are removed first, blank statements are dropped, and every
 * statement is trimmed. The result is fed to the database one statement at a
 * time, which is what D1's `prepare()` expects.
 *
 * Outside an explicit compound block the behaviour is exactly what it always
 * was: split on semicolons outside single-quoted strings, strip comments.
 * Inside a compound block the content is kept verbatim (still comment-stripped
 * outside strings, and never rewritten) and returned as ONE statement, so a
 * trigger body survives intact. Malformed marker structures fail loudly rather
 * than falling back to ordinary splitting.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let block = '';
  let inString = false;
  let inBlockComment = false;
  let inCompound = false;
  let i = 0;

  const append = (text: string): void => {
    if (inCompound) block += text;
    else current += text;
  };
  const flush = (): void => {
    const trimmed = current.trim();
    if (trimmed.length > 0) statements.push(trimmed);
    current = '';
  };

  while (i < sql.length) {
    const char = sql.charAt(i);
    const next = sql.charAt(i + 1);

    if (inString) {
      append(char);
      if (char === "'") {
        if (next === "'") {
          append(next);
          i += 2;
          continue;
        }
        inString = false;
      }
      i += 1;
      continue;
    }

    if (inBlockComment) {
      // Outside a compound block comments are stripped as before; inside one
      // they are kept verbatim so the body is never silently rewritten.
      if (inCompound) block += char;
      if (char === '*' && next === '/') {
        if (inCompound) block += next;
        inBlockComment = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (char === '-' && next === '-') {
      let end = sql.indexOf('\n', i);
      if (end === -1) end = sql.length;
      const comment = sql.slice(i, end).trim();

      if (comment === COMPOUND_STATEMENT_BEGIN) {
        if (inCompound) {
          throw new Error('migration sql: nested compound statement block is not allowed');
        }
        if (current.trim().length > 0) flush();
        inCompound = true;
        block = '';
        i = end + 1;
        continue;
      }
      if (comment === COMPOUND_STATEMENT_END) {
        if (!inCompound) {
          throw new Error('migration sql: compound statement end without begin');
        }
        const trimmedBlock = block.trim();
        if (trimmedBlock.length === 0) {
          throw new Error('migration sql: compound statement block is empty');
        }
        statements.push(trimmedBlock);
        inCompound = false;
        block = '';
        i = end + 1;
        continue;
      }

      // Ordinary comment: stripped, exactly as before (outside) or preserved
      // verbatim as part of the trigger body (inside).
      if (inCompound) block += sql.slice(i, end);
      i = end;
      continue;
    }

    if (char === '/' && next === '*') {
      inBlockComment = true;
      i += 2;
      if (inCompound) block += '/*';
      continue;
    }

    if (char === "'") {
      inString = true;
      append(char);
      i += 1;
      continue;
    }

    if (char === ';') {
      if (inCompound) block += char;
      else flush();
      i += 1;
      continue;
    }

    append(char);
    i += 1;
  }

  if (inCompound) {
    throw new Error('migration sql: compound statement block was not closed');
  }

  flush();
  return statements;
}
