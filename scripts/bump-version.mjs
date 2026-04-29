#!/usr/bin/env node
// Stamp every relative import / asset reference with ?v=<version> so browsers
// fetch fresh JS/CSS after a deploy instead of serving cached old files.
//
// Run before each commit that changes anything under src/ or assets/:
//   node scripts/bump-version.mjs            # auto: UTC timestamp YYYYMMDDHHMM
//   node scripts/bump-version.mjs 20260429-7 # explicit version string

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function defaultVersion() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`
       + `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
}

const VERSION = process.argv[2] || defaultVersion();

// Match relative .js/.css references in quotes — including any existing ?v=...
// the replacement strips. Captures: 1=quote, 2=path-without-query.
const PATTERN = /(['"`])(\.{0,2}\/[^'"`?\s]+\.(?:js|css))(?:\?v=[^'"`\s]*)?\1/g;

function bumpFile(absPath, displayPath) {
  const text = readFileSync(absPath, 'utf8');
  const updated = text.replace(PATTERN, (_, q, p) => `${q}${p}?v=${VERSION}${q}`);
  if (text === updated) {
    console.log(`  = ${displayPath} (no refs)`);
    return;
  }
  writeFileSync(absPath, updated);
  const matches = (updated.match(PATTERN) || []).length;
  console.log(`  ↑ ${displayPath} (${matches} refs)`);
}

bumpFile(resolve(REPO_ROOT, 'index.html'), 'index.html');
for (const name of readdirSync(resolve(REPO_ROOT, 'src'))) {
  if (name.endsWith('.js')) bumpFile(resolve(REPO_ROOT, 'src', name), `src/${name}`);
}

console.log(`\nVersion: ${VERSION}`);
console.log('Now: git add -u && git commit && git push');
