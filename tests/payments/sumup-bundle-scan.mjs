/**
 * AMPED-07A post-build client-bundle secret scan.
 *
 * Run AFTER `npm run build`:
 *
 *   node tests/payments/sumup-bundle-scan.mjs
 *
 * It scans the browser-facing build output (everything under dist/ that is not
 * the server Worker bundle) and fails if a SumUp secret name or a sentinel
 * value appears there. The server bundle may legitimately reference the
 * environment variable name, so it is excluded on purpose.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');

const SENTINEL = 'sup_sk_test_not-a-real-key-000000000000';
const FORBIDDEN = ['SUMUP_API_KEY', 'SUMUP_MERCHANT_CODE', SENTINEL];

if (!existsSync(dist)) {
  console.error('bundle scan: dist/ does not exist - run `npm run build` first');
  process.exit(1);
}

const clientFiles = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // The server bundle and the worker entry may name environment variables.
      if (full.replaceAll('\\', '/').endsWith('/dist/server')) continue;
      walk(full);
    } else if (/\.(js|mjs|css|html)$/.test(entry)) {
      clientFiles.push(full);
    }
  }
};
walk(dist);

const hits = [];
for (const file of clientFiles) {
  const source = readFileSync(file, 'utf8');
  for (const needle of FORBIDDEN) {
    if (source.includes(needle)) hits.push({ file, needle });
  }
}

if (clientFiles.length === 0) {
  console.error('bundle scan: no client bundle files found - refusing to pass vacuously');
  process.exit(1);
}

if (hits.length > 0) {
  console.error('bundle scan FAILED: secret material found in client output');
  for (const hit of hits) console.error(`  ${hit.needle} in ${hit.file}`);
  process.exit(1);
}

console.log(`bundle scan: clean (${clientFiles.length} client files checked, no SumUp secrets)`);
