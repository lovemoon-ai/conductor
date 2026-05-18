#!/usr/bin/env node
/**
 * Bundle smoke test: verify the three subpath entries don't leak content
 * from the wrong environment.
 *
 *   1. dist/server/index.js — Node code. Must NOT import any browser-only
 *      symbols (`document`, `window` references etc.).
 *   2. dist/react/index.js  — Browser code. Must NOT import Node built-ins
 *      (`node:fs`, `node:crypto`, etc.) or use Node-only globals.
 *   3. dist/index.js        — Pure types/constants. Must NOT contain Node
 *      built-in imports or DOM symbols.
 *
 * This is a string-grep guard. It's not a full bundle test — that comes
 * later via the example app's Vite build — but it catches 90% of regressions
 * (someone accidentally imports `node:crypto` in a /react module, etc.).
 *
 * Exits non-zero on any violation.
 */
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const BANNED_IN_REACT = [
  // Node built-in imports
  /from\s+['"]node:/,
  /require\(['"]node:/,
  // Node globals that should never appear in browser code.
  /\bprocess\.env\b/,
  /\bglobal\.[A-Za-z_]/,
];

const BANNED_IN_SERVER = [
  // Browser-only DOM symbols
  /\bdocument\.[A-Za-z_]/,
  /\bwindow\.[A-Za-z_]/,
  // React jsx-runtime (allowed only in /react).
  /from\s+['"]react\/jsx-runtime['"]/,
];

const BANNED_IN_TYPES = [
  /from\s+['"]node:/,
  /require\(['"]node:/,
  /\bdocument\.[A-Za-z_]/,
  /\bwindow\.[A-Za-z_]/,
  /from\s+['"]react/,
  /from\s+['"]ws['"]/,
];

const checks = [
  { file: 'dist/server/index.js', banned: BANNED_IN_SERVER, label: '/server' },
  { file: 'dist/react/index.js', banned: BANNED_IN_REACT, label: '/react' },
  { file: 'dist/index.js', banned: BANNED_IN_TYPES, label: 'root' },
];

let failed = 0;

for (const { file, banned, label } of checks) {
  const path = resolve(root, file);
  try {
    await stat(path);
  } catch {
    console.error(`[bundle-smoke] missing: ${file} — run \`npm run build\` first.`);
    failed += 1;
    continue;
  }
  const content = await readFile(path, 'utf8');
  let entryFailed = false;
  for (const pattern of banned) {
    if (pattern.test(content)) {
      const match = content.match(pattern);
      console.error(
        `[bundle-smoke] FAIL ${label} (${file}): banned pattern ${pattern} matched: ${
          match?.[0] ?? '(no match snippet)'
        }`,
      );
      entryFailed = true;
    }
  }
  if (entryFailed) {
    failed += 1;
  } else {
    console.log(`[bundle-smoke] OK ${label} (${file})`);
  }
}

if (failed > 0) {
  console.error(`\n[bundle-smoke] ${failed} entry(ies) failed.`);
  process.exit(1);
}
console.log('\n[bundle-smoke] all entries clean.');

// -------------------------------------------------------------------------
// Public d.ts surface guard (M1 regression net).
//
// stripInternal in tsup.config.ts removes any declaration tagged
// `/** @internal */` from the generated .d.ts. We assert here that the
// transport plumbing (Fetcher / AppWebSocket / TasksRestApi etc.) never
// reappears in the public d.ts — a regression that would otherwise be
// invisible until someone hovered over a symbol in their editor.
// -------------------------------------------------------------------------
const DTS_INTERNAL_SYMBOLS = [
  /\bclass\s+Fetcher\b/,
  /\bclass\s+AppWebSocket\b/,
  /\bclass\s+TasksRestApi\b/,
  /\binterface\s+FetcherOptions\b/,
  /\binterface\s+AppWebSocketOptions\b/,
  /\binterface\s+RequestOptions\b/,
];
const dtsChecks = [
  { file: 'dist/server/index.d.ts', label: '/server d.ts' },
  { file: 'dist/index.d.ts', label: 'root d.ts' },
  { file: 'dist/react/index.d.ts', label: '/react d.ts' },
];

let dtsFailed = 0;
for (const { file, label } of dtsChecks) {
  const path = resolve(root, file);
  try {
    await stat(path);
  } catch {
    console.error(`[dts-surface] missing: ${file} — run \`npm run build\` first.`);
    dtsFailed += 1;
    continue;
  }
  const content = await readFile(path, 'utf8');
  let entryFailed = false;
  for (const pattern of DTS_INTERNAL_SYMBOLS) {
    if (pattern.test(content)) {
      const match = content.match(pattern);
      console.error(
        `[dts-surface] FAIL ${label} (${file}): internal symbol pattern ${pattern} leaked into public d.ts: ${
          match?.[0] ?? '(no match snippet)'
        }`,
      );
      entryFailed = true;
    }
  }
  if (entryFailed) {
    dtsFailed += 1;
  } else {
    console.log(`[dts-surface] OK ${label} (${file})`);
  }
}

if (dtsFailed > 0) {
  console.error(`\n[dts-surface] ${dtsFailed} d.ts entry(ies) failed.`);
  process.exit(1);
}
console.log('\n[dts-surface] all d.ts entries clean.');
