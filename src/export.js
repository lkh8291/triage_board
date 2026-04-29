// Export findings (Markdown / JSON) for a Report or Project drill-down scope.
// Pure functions except triggerDownload(), which touches the DOM to fire a
// browser download. No GitHub API calls — boot already loaded everything.

import { consensusFor } from './aggregator.js';

// ============== filtering ==============

/**
 * Filter `findings` by verdict produced from `triage[fid]`.
 *   filter ∈ {'all'|'tp'|'fp'|'split'|'pending'}
 * Each returned item carries the consensus payload alongside the finding so
 * formatters can describe verdicts + opinions without recomputing.
 */
export function filterByVerdict(findings, triage, filter) {
  const out = [];
  for (const f of findings) {
    const cons = consensusFor(triage[f.id] || []);
    if (filter !== 'all' && cons.status !== filter) continue;
    out.push({ finding: f, consensus: cons });
  }
  return out;
}

/** Counts per verdict for the menu badges. Always returns the same key set. */
export function verdictCounts(findings, triage) {
  const c = { all: findings.length, tp: 0, fp: 0, split: 0, pending: 0 };
  for (const f of findings) {
    c[consensusFor(triage[f.id] || []).status]++;
  }
  return c;
}

// ============== shared scope/filter labels ==============

const FILTER_LABEL = {
  all:     'all findings',
  tp:      'true-positives',
  fp:      'false-positives',
  split:   'split disagreements',
  pending: 'pending',
};

const FILTER_HEADLINE = {
  all:     'All findings',
  tp:      'True positives',
  fp:      'False positives',
  split:   'Split disagreements',
  pending: 'Pending',
};

function nowIso() {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

function utcLabel(iso = nowIso()) {
  return iso.replace('T', ' ').replace('Z', ' UTC');
}

// ============== Markdown formatter ==============

function escMd(s) {
  // Don't break tables when a value happens to include "|".
  return String(s == null ? '' : s).replace(/\|/g, '\\|');
}

function verdictLabel(status) {
  return ({ tp: 'TP', fp: 'FP', split: 'split', pending: 'pending' })[status] || status;
}

function describeVerdictWithSplit(consensus) {
  const op = consensus.opinions || [];
  if (!op.length) return 'pending';
  if (consensus.status !== 'split') return verdictLabel(consensus.status);
  // Split → list each reviewer's verdict, mark which is most recent
  const sorted = [...op].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  const latest = sorted[sorted.length - 1];
  const parts = sorted.map(o => `${o.reviewer} ${verdictLabel(o.verdict)}`).join(', ');
  return `**split** (${parts} — ${latest.reviewer} latest)`;
}

function formatOpinionMd(o) {
  const ts = utcLabel(o.ts);
  const body = (o.rationale || '').trim() || '_(no rationale recorded)_';
  // 2-space indent on continuation lines so they stay inside the list item
  const indented = body.replace(/\n/g, '\n  ');
  return `- **${o.reviewer} — ${verdictLabel(o.verdict)}** · ${ts}\n  ${indented}`;
}

function findingSectionMd({ finding: f, consensus }) {
  const opinions = [...(consensus.opinions || [])]
    .sort((a, b) => String(b.ts).localeCompare(String(a.ts))); // newest first

  const meta = [
    ['Severity',  f.severity],
    ['Domain',    f.domain],
    ['Category',  f.category],
    ['Project',   f.project],
    ['Report',    f.report_id],
    ['AI agent',  f.agent],
    ['CWE',       f.cwe],
    ['CVE',       f.cve],
    ['**Verdict**', describeVerdictWithSplit(consensus)],
  ].filter(([, v]) => v != null && v !== '');

  const head = `## ${f.id} — ${f.title || f.id}`;
  const table = [
    '| | |', '|---|---|',
    ...meta.map(([k, v]) => `| ${k} | ${escMd(v)} |`),
  ].join('\n');

  const summary = (f.summary || f.ai_rationale || '').trim();

  const opinionsBlock = opinions.length
    ? '### Triage opinions (latest per reviewer)\n\n' + opinions.map(formatOpinionMd).join('\n')
    : '### Triage opinions\n\n_(no triage opinions yet)_';

  const parts = [head, '', table];
  if (summary) parts.push('', '### Summary', '', summary);
  parts.push('', opinionsBlock);
  return parts.join('\n');
}

export function formatMarkdown(items, scopeMeta, filter, login) {
  const scopeLine = scopeMeta.type === 'project'
    ? `Project: ${scopeMeta.id}`
    : `Report: ${scopeMeta.id}`;
  const ts = nowIso();

  const headerTable = [
    `# Triage Export — ${scopeLine} · ${FILTER_LABEL[filter]}`,
    '',
    '| | |', '|---|---|',
    `| Exported    | ${utcLabel(ts)} |`,
    `| Exported by | ${escMd(login || 'unknown')} |`,
    `| Filter      | ${FILTER_HEADLINE[filter]} |`,
    `| Total       | ${items.length} ${items.length === 1 ? 'finding' : 'findings'} |`,
    scopeMeta.project ? `| Project     | ${escMd(scopeMeta.project)} |` : null,
    scopeMeta.scanner ? `| Scanner     | ${escMd(scopeMeta.scanner)} |` : null,
    '',
    '---',
    '',
  ].filter(Boolean).join('\n');

  if (!items.length) {
    return headerTable + '\n_(no findings match this filter)_\n';
  }

  return headerTable + items.map(findingSectionMd).join('\n\n---\n\n') + '\n';
}

// ============== JSON formatter ==============

export function formatJson(items, scopeMeta, filter, login) {
  const scope = { type: scopeMeta.type, id: scopeMeta.id };
  if (scopeMeta.project) scope.project = scopeMeta.project;
  if (scopeMeta.scanner) scope.scanner = scopeMeta.scanner;

  const findings = items.map(({ finding: f, consensus }) => {
    // Drop loader-internal fields starting with _ (e.g. _shallow, _path).
    const cleaned = {};
    for (const [k, v] of Object.entries(f)) if (!k.startsWith('_')) cleaned[k] = v;
    cleaned.consensus_verdict = consensus.status;
    cleaned.triage_opinions = (consensus.opinions || [])
      .map(o => ({
        reviewer: o.reviewer,
        verdict:  o.verdict,
        rationale: o.rationale || '',
        ts:       o.ts,
      }))
      .sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
    return cleaned;
  });

  return JSON.stringify({
    exported_at: nowIso(),
    exported_by: login || null,
    scope,
    filter,
    total: findings.length,
    findings,
  }, null, 2) + '\n';
}

// ============== filename + download ==============

function safeSlug(s) {
  return String(s || 'unknown').toLowerCase().replace(/[^\p{L}\p{N}-]+/gu, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'unknown';
}

function dateStamp(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

export function exportFilename(scopeMeta, filter, format) {
  const ext = format === 'json' ? 'json' : 'md';
  return `triage-${scopeMeta.type}-${safeSlug(scopeMeta.id)}-${filter}-${dateStamp()}.${ext}`;
}

/**
 * Top-level builder used by views.js.
 *   format ∈ {'markdown'|'json'}
 *   filter ∈ {'all'|'tp'|'fp'|'split'|'pending'}
 * Returns the file payload ready for triggerDownload().
 */
export function buildExport({ scopeFindings, triage, scopeMeta, filter, format, login }) {
  const items = filterByVerdict(scopeFindings, triage, filter);
  const content = format === 'json'
    ? formatJson(items, scopeMeta, filter, login)
    : formatMarkdown(items, scopeMeta, filter, login);
  return {
    filename: exportFilename(scopeMeta, filter, format),
    content,
    mime: format === 'json' ? 'application/json' : 'text/markdown',
  };
}

// ============== download trigger ==============

export function triggerDownload(content, filename, mime) {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  // Some browsers ignore .download unless the link is in the document tree.
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 0);
}
