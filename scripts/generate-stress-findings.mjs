#!/usr/bin/env node
// Synthetic finding generator for SPA load-testing.
// 10 projects × 300-1000 findings each. Single bulk write — caller commits once.
// Easy to identify and remove: every report_id starts "RPT-STRESS-",
// every finding id starts "FND-STRESS-".

import { writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Seeded RNG for reproducibility — same seed → same data.
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(42);
const pick = (arr) => arr[Math.floor(rng() * arr.length)];
const pickWeighted = (entries) => {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [v, w] of entries) { if ((r -= w) <= 0) return v; }
  return entries[entries.length - 1][0];
};
const randInt = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

const PROJECTS = [
  'e-commerce-frontend', 'mobile-banking-app', 'iot-smart-home',
  'corporate-portal', 'payment-gateway', 'inventory-management',
  'crm-saas', 'video-streaming', 'healthcare-records', 'logistics-tracker',
];

const DOMAINS = ['web', 'android', 'device'];

const CAT = {
  web: ['xss-reflected', 'xss-stored', 'sqli-blind', 'sqli-error', 'idor', 'csrf',
        'ssrf', 'open-redirect', 'path-traversal', 'cmd-injection', 'auth-bypass',
        'jwt-weak', 'cors-misconfig', 'header-x-frame-options-missing',
        'banner-server-disclosure', 'rate-limiting-missing', 'race-condition-toctou',
        'xxe', 'prototype-pollution', 'graphql-introspection-exposed'],
  android: ['exposed-component-payment-bypass', 'deeplink-permission-bypass',
            'exported-broadcast-receiver', 'intent-redirection',
            'parcelable-deserialization', 'intent-uri-smuggle',
            'content-provider-leak', 'weak-cryptography', 'insecure-storage',
            'webview-js-injection', 'pendingintent-mutable', 'tapjacking',
            'janus-signature-bypass', 'cleartext-traffic'],
  device: ['telnet-enabled', 'default-credentials', 'ssh-weak-cipher',
           'http-admin-exposed', 'snmp-public', 'ftp-anonymous', 'upnp-exposed',
           'firmware-unsigned', 'rtsp-no-auth', 'mqtt-anonymous',
           'modbus-exposed', 'jtag-uart-exposed'],
};

const SEV = [['critical', 1], ['high', 4], ['medium', 8], ['low', 6], ['info', 3]];

const CWE = ['CWE-79', 'CWE-89', 'CWE-22', 'CWE-352', 'CWE-918', 'CWE-601',
             'CWE-200', 'CWE-862', 'CWE-639', 'CWE-94', 'CWE-78', 'CWE-441',
             'CWE-926', 'CWE-502', 'CWE-798', 'CWE-287', 'CWE-20', 'CWE-269',
             'CWE-732', 'CWE-862', 'CWE-863', 'CWE-1021', 'CWE-1188'];

const PATHS = ['/api/users/profile', '/api/orders', '/api/admin/config',
               '/api/v2/checkout', '/api/auth/token', '/api/files/upload',
               '/search', '/login', '/account', '/dashboard', '/api/internal/sync'];

function pad(n, w = 4) { return String(n).padStart(w, '0'); }
function isoDate(daysAgo) {
  const d = new Date('2026-04-29T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString();
}
function isoYmd(daysAgo) { return isoDate(daysAgo).slice(0, 10); }

function genWebTarget(rid) {
  const path = pick(PATHS);
  return {
    url: `https://${rid}.example.com${path}?id=${randInt(1, 9999)}`,
    method: pick(['GET', 'POST', 'PUT', 'DELETE']),
    endpoint: path,
    parameter: pick(['id', 'name', 'q', 'redirect', 'callback', 'token', 'page']),
    auth_required: rng() < 0.6,
  };
}
function genAndroidTarget() {
  const pkg = `com.example.${pick(['shop', 'bank', 'social', 'media', 'health'])}`;
  return {
    package: pkg,
    version_name: `${randInt(1, 9)}.${randInt(0, 20)}.${randInt(0, 50)}`,
    component_type: pick(['activity', 'service', 'receiver', 'provider']),
    component_class: `${pkg}.${pick(['ui', 'sync', 'core'])}.${pick(['Main', 'Detail', 'Add', 'Cover', 'Login'])}Activity`,
    exported: rng() < 0.7,
    permission_required: rng() < 0.3 ? `${pkg}.permission.ACCESS` : null,
  };
}
function genDeviceTarget() {
  return {
    device_model: `${pick(['SmartCam', 'GW-Router', 'PLC-IO', 'NVR-X', 'Thermo'])}-${randInt(100, 999)}`,
    ip: `192.168.${randInt(0, 50)}.${randInt(2, 254)}`,
    port: pick([22, 23, 80, 161, 443, 502, 554, 1883, 8080, 8888]),
    service: pick(['ssh', 'telnet', 'http', 'snmp', 'modbus', 'rtsp', 'mqtt']),
    firmware_version: `fw-${randInt(1, 5)}.${randInt(0, 20)}`,
  };
}

function makeFinding({ projectIdx, project, fid, rid, daysAgo }) {
  const domain = pick(DOMAINS);
  const category = pick(CAT[domain]);
  const severity = pickWeighted(SEV);
  const target = domain === 'web' ? genWebTarget(`p${projectIdx}`)
               : domain === 'android' ? genAndroidTarget()
               : genDeviceTarget();
  return {
    id: fid,
    report_id: rid,
    project,
    domain,
    category,
    severity,
    title: `${category} on ${target.url || target.component_class || target.device_model}`,
    agent: `stress-scanner-v0.${randInt(1, 9)}`,
    discovered_at: isoDate(daysAgo),
    target,
    ai_confidence: Math.round((0.4 + rng() * 0.6) * 100) / 100,
    ai_rationale: `Synthetic finding for SPA load testing. project=${project}, domain=${domain}, category=${category}.`,
    cwe: pick(CWE),
    cve: rng() < 0.05 ? `CVE-${randInt(2020, 2026)}-${randInt(1000, 99999)}` : null,
  };
}

function purgeStress() {
  for (const dir of ['findings', 'reports']) {
    const abs = resolve(REPO_ROOT, dir);
    let n = 0;
    for (const name of readdirSync(abs)) {
      if (name.startsWith('FND-STRESS-') || name.startsWith('RPT-STRESS-')) {
        unlinkSync(resolve(abs, name)); n++;
      }
    }
    console.log(`  purged ${n} stress files from ${dir}/`);
  }
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--purge')) { purgeStress(); return; }

  mkdirSync(resolve(REPO_ROOT, 'findings'), { recursive: true });
  mkdirSync(resolve(REPO_ROOT, 'reports'), { recursive: true });

  let totalFindings = 0;
  for (let p = 0; p < PROJECTS.length; p++) {
    const project = PROJECTS[p];
    const count = randInt(300, 1000);
    const reportDate = isoYmd(p);                          // distinct date per project
    const rid = `RPT-STRESS-${pad(p + 1, 2)}-${reportDate}`;
    const reportFindings = [];

    for (let i = 0; i < count; i++) {
      const fid = `FND-STRESS-${pad(p + 1, 2)}-${pad(i + 1, 4)}`;
      const daysAgo = randInt(0, 29);
      const f = makeFinding({ projectIdx: p + 1, project, fid, rid, daysAgo });
      writeFileSync(
        resolve(REPO_ROOT, 'findings', `${fid}.json`),
        JSON.stringify(f, null, 2) + '\n',
      );
      reportFindings.push({
        raw_idx: i,
        domain: f.domain,
        type: f.category,
        severity_estimate: f.severity,
        title: f.title,
        ai_confidence: f.ai_confidence,
        ai_notes: f.ai_rationale,
        curation_decision: `accepted → ${fid}`,
      });
    }

    const report = {
      _comment: 'Synthetic stress-test data — generated by scripts/generate-stress-findings.mjs',
      report_id: rid,
      project,
      scanner: 'stress-scanner-v0.x',
      scan_id: `scan-stress-${pad(p + 1, 2)}`,
      started_at: isoDate(p + 1),
      completed_at: isoDate(p),
      raw_findings: reportFindings,
      sibling_finding_ids: reportFindings.map(rf => rf.curation_decision.split(' → ')[1]),
    };
    writeFileSync(
      resolve(REPO_ROOT, 'reports', `${rid}.json`),
      JSON.stringify(report, null, 2) + '\n',
    );

    totalFindings += count;
    console.log(`  ${project.padEnd(24)} ${String(count).padStart(4)} findings → ${rid}`);
  }

  console.log(`\nTotal: ${totalFindings} findings across ${PROJECTS.length} projects.`);
}

main();
