#!/usr/bin/env node
// Reads a raw scanner report (JSON), normalizes the project name, splits accepted
// raw_findings into findings/FND-*.json, and writes the curated report to reports/.
// User then commits and pushes — git history is the audit log.
//
// Usage:
//   node scripts/upload-report.mjs <path-to-raw-report.json>
//   node scripts/upload-report.mjs <path-to-raw-report.json> --dry-run
//
// Future (HANDOFF Decision #12): replace fs writes with a single
// git/blobs+trees+commits POST so the upload is a single atomic commit even
// from CI without a working tree.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeProject } from './normalize.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function usage() {
  console.error('usage: node scripts/upload-report.mjs <raw-report.json> [--dry-run]');
  process.exit(1);
}

function dieIf(cond, msg) {
  if (cond) { console.error('✗ ' + msg); process.exit(1); }
}

function decisionClass(d) {
  const v = String(d || '').toLowerCase();
  if (v.startsWith('accepted')) return 'accepted';
  if (v.startsWith('rejected')) return 'rejected';
  return 'deferred';
}

// One scanner type → one builder. Adds new domain by adding a key here.
const BUILDERS = {
  web: buildWebFinding,
  android: buildAndroidFinding,
  device: buildDeviceFinding,
};

// Map raw → finding. Each builder is intentionally permissive — missing fields
// just don't appear in the output. AI-curation upstream owns completeness.
function buildWebFinding(raw, ctx) {
  return {
    id: ctx.fid,
    report_id: ctx.report_id,
    project: ctx.project,
    domain: 'web',
    category: raw.type,
    severity: raw.severity_estimate,
    title: raw.title || raw.url || raw.type,
    agent: ctx.agent,
    discovered_at: raw.discovered_at || ctx.completed_at,
    target: {
      url: raw.url,
      method: raw.method || 'GET',
      endpoint: raw.endpoint || raw.url,
      parameter: raw.parameter,
      auth_required: raw.auth_required,
    },
    evidence: raw.evidence || (raw.payload || raw.request_raw ? {
      payload: raw.payload, request_raw: raw.request_raw, response_excerpt: raw.response_excerpt,
    } : undefined),
    ai_confidence: raw.ai_confidence,
    ai_rationale: raw.ai_notes || raw.ai_rationale,
    cwe: raw.cwe, cve: raw.cve,
  };
}
function buildAndroidFinding(raw, ctx) {
  return {
    id: ctx.fid,
    report_id: ctx.report_id,
    project: ctx.project,
    domain: 'android',
    category: raw.type,
    severity: raw.severity_estimate,
    title: raw.title || raw.component_class || raw.type,
    agent: ctx.agent,
    discovered_at: raw.discovered_at || ctx.completed_at,
    target: raw.target || {
      package: raw.package, component_class: raw.component_class,
      exported: raw.exported,
    },
    evidence: raw.evidence,
    ai_confidence: raw.ai_confidence, ai_rationale: raw.ai_notes,
    cwe: raw.cwe, cve: raw.cve,
  };
}
function buildDeviceFinding(raw, ctx) {
  return {
    id: ctx.fid,
    report_id: ctx.report_id,
    project: ctx.project,
    domain: 'device',
    category: raw.type,
    severity: raw.severity_estimate,
    title: raw.title || `${raw.device_model || ''} ${raw.type || ''}`.trim(),
    agent: ctx.agent,
    discovered_at: raw.discovered_at || ctx.completed_at,
    target: raw.target || {
      device_model: raw.device_model, ip: raw.ip, port: raw.port, service: raw.service,
    },
    evidence: raw.evidence,
    ai_confidence: raw.ai_confidence, ai_rationale: raw.ai_notes,
    cwe: raw.cwe, cve: raw.cve,
  };
}

function inferDomain(raw, fallback) {
  if (raw.domain) return raw.domain;
  if (raw.url || raw.method || raw.endpoint) return 'web';
  if (raw.package || raw.component_class || raw.component || raw.intent_filter) return 'android';
  if (raw.device_model || raw.firmware_version || raw.ip || raw.port) return 'device';
  return fallback || 'web';
}

function inferDomainFromScanner(scanner) {
  const s = String(scanner || '').toLowerCase();
  if (s.includes('android')) return 'android';
  if (s.includes('device')) return 'device';
  if (s.includes('ios')) return 'ios';
  return 'web';
}

function makeFid({ report_id, raw_idx, domain }) {
  // FND-{date}-{domainShort}{seq}, derived from report_id (which already has the date).
  // RPT-2026-04-29-A → 2026-04-29 + idx → FND-2026-04-29-W{idx} for web, A{idx} for android, D{idx} for device.
  const date = (report_id.match(/RPT-(\d{4}-\d{2}-\d{2})/) || [])[1] || new Date().toISOString().slice(0, 10);
  const tag = ({ web: 'W', android: 'A', device: 'D' })[domain] || 'X';
  return `FND-${date}-${tag}${String(raw_idx + 1).padStart(2, '0')}`;
}

function writeIfChanged(path, content, dryRun) {
  const abs = resolve(REPO_ROOT, path);
  mkdirSync(dirname(abs), { recursive: true });
  if (existsSync(abs) && readFileSync(abs, 'utf8') === content) {
    console.log(`  = ${path} (unchanged)`);
    return;
  }
  if (dryRun) { console.log(`  ✎ ${path} (dry-run, not written)`); return; }
  writeFileSync(abs, content);
  console.log(`  + ${path}`);
}

function main(argv) {
  const args = argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const path = args.find(a => !a.startsWith('--'));
  if (!path) usage();

  const raw = JSON.parse(readFileSync(path, 'utf8'));
  dieIf(!raw.report_id, 'raw-report missing required "report_id" field');
  dieIf(raw.project == null, 'raw-report missing required "project" field');

  const original = raw.project;
  let project;
  try { project = normalizeProject(original); }
  catch (e) { dieIf(true, e.message); }

  const accepted = (raw.raw_findings || []).filter(f => decisionClass(f.curation_decision) === 'accepted');
  const reportDomain = inferDomainFromScanner(raw.scanner);
  const ctx = {
    report_id: raw.report_id,
    project,
    agent: raw.scanner,
    completed_at: raw.completed_at,
  };

  console.log(`raw-report: ${path}`);
  console.log(`  report_id:            ${raw.report_id}`);
  console.log(`  project (input):      ${JSON.stringify(original)}`);
  console.log(`  project (normalized): ${JSON.stringify(project)}`);
  console.log(`  raw_findings:         ${(raw.raw_findings || []).length} (accepted: ${accepted.length})`);
  console.log(`---`);

  // Build + write each accepted finding
  for (let i = 0; i < accepted.length; i++) {
    const rawF = accepted[i];
    const domain = inferDomain(rawF, reportDomain);
    const fid = makeFid({ report_id: raw.report_id, raw_idx: rawF.raw_idx ?? i, domain });
    const builder = BUILDERS[domain] || BUILDERS.web;
    const finding = builder(rawF, { ...ctx, fid });
    writeIfChanged(`findings/${fid}.json`, JSON.stringify(finding, null, 2) + '\n', dryRun);
  }

  // Write the report itself (raw, with normalized project) so the audit drawer can show it later.
  const reportOut = { ...raw, project };
  writeIfChanged(`reports/${raw.report_id}.json`, JSON.stringify(reportOut, null, 2) + '\n', dryRun);

  console.log(`---`);
  console.log(`Done. ${dryRun ? '(dry-run — no files written)' : 'Now: git add findings/ reports/ && git commit && git push'}`);
}

main(process.argv);
