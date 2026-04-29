#!/usr/bin/env node
// Builds findings/index.json — a single shallow listing of every finding.
// SPA fetches this one file at boot instead of N parallel /contents/{path} calls.
// Detail (target/evidence/ai_rationale/etc.) is lazy-loaded when a finding is opened.
//
// Run after any change to findings/. upload-report.mjs and
// generate-stress-findings.mjs call this automatically at the end.

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIND_DIR = resolve(REPO_ROOT, 'findings');

// Fields the table & sidebar render directly. Anything heavier (target.evidence,
// manifest_excerpt, code_excerpt, remediation_hint, ai_rationale...) is omitted —
// the SPA fetches the full file on detail open.
//
// target is included with only the small fields targetLabel() in views.js needs.
function shallowTarget(t) {
  if (!t || typeof t !== 'object') return undefined;
  const out = {};
  for (const k of ['url', 'method', 'endpoint', 'package', 'component_class',
                   'device_model', 'ip', 'port', 'service']) {
    if (t[k] != null) out[k] = t[k];
  }
  return Object.keys(out).length ? out : undefined;
}

function shallow(f, path) {
  const out = {
    id: f.id,
    report_id: f.report_id,
    project: f.project,
    domain: f.domain,
    severity: f.severity,
    category: f.category,
    title: f.title,
    agent: f.agent,
    discovered_at: f.discovered_at,
    ai_confidence: f.ai_confidence,
    cwe: f.cwe,
    cve: f.cve,
    _path: path,
  };
  const t = shallowTarget(f.target);
  if (t) out.target = t;
  // strip undefined for compactness
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

function main() {
  mkdirSync(FIND_DIR, { recursive: true });
  const names = readdirSync(FIND_DIR).filter(n => n.endsWith('.json') && n !== 'index.json');
  const findings = [];
  let skipped = 0;
  for (const name of names) {
    const abs = resolve(FIND_DIR, name);
    const path = `findings/${name}`;
    try {
      const raw = JSON.parse(readFileSync(abs, 'utf8'));
      findings.push(shallow(raw, path));
    } catch (e) {
      console.warn(`  ! skip ${path}: ${e.message}`);
      skipped++;
    }
  }
  // stable order by id so diffs are clean
  findings.sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')));

  const doc = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    count: findings.length,
    findings,
  };
  const out = JSON.stringify(doc) + '\n';
  writeFileSync(resolve(FIND_DIR, 'index.json'), out);
  const kb = (out.length / 1024).toFixed(1);
  console.log(`  ✓ findings/index.json — ${findings.length} entries, ${kb} KB${skipped ? ` (${skipped} skipped)` : ''}`);
}

main();
