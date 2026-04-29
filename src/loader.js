// One-shot loader. Calls git/trees once to learn every path in the repo.
// Findings: prefer findings/index.json (one file, shallow metadata); the per-finding
// detail JSON is fetched lazily when the user opens a card. Falls back to legacy
// per-file fetch when the index is absent.
// Triage + reports: parallel per-file fetch (small enough for now).
// 30s polling (HANDOFF Phase 5) plugs in here once we want auto-refresh.

import { getTree, getJson, getJsonRaw } from './api.js?v=202604291117';

const FINDING_RE  = /^findings\/(?!index\.json$)[^/]+\.json$/;
const INDEX_PATH  = 'findings/index.json';
const TRIAGE_RE   = /^triage\/([^/]+)\/[^/]+\.json$/;
const REPORT_RE   = /^reports\/[^/]+\.json$/;

export async function loadAll() {
  const tree = await getTree();
  const findingPaths = [];
  const triagePaths  = [];
  const reportPaths  = [];
  let hasIndex = false;
  for (const t of tree) {
    if (t.type !== 'blob') continue;
    if (t.path === INDEX_PATH) hasIndex = true;
    else if (FINDING_RE.test(t.path)) findingPaths.push(t.path);
    else if (TRIAGE_RE.test(t.path)) triagePaths.push(t.path);
    else if (REPORT_RE.test(t.path)) reportPaths.push(t.path);
  }

  let findings;
  if (hasIndex) {
    // Index is multi-MB once findings >3K — must use raw media type (the JSON
    // endpoint returns content="" past 1MB). _shallow flag tells the detail
    // view to lazy-fetch the full JSON; _path is derived from id (file naming
    // convention is `findings/${id}.json`).
    const { json } = await getJsonRaw(INDEX_PATH);
    findings = (json.findings || []).map(f => ({
      ...f,
      _shallow: true,
      _path: `findings/${f.id}.json`,
    }));
  } else {
    // Legacy fallback: parallel per-file fetch. Rate-limited above ~1k findings.
    findings = (await Promise.allSettled(findingPaths.map(p => getJson(p))))
      .map((r, i) => r.status === 'fulfilled' ? { ...r.value.json, _path: findingPaths[i] }
                                                : { _error: r.reason?.message, _path: findingPaths[i] })
      .filter(f => !f._error);
  }

  const triageRaws = await Promise.allSettled(triagePaths.map(p => getJson(p)));
  const triage = {};                       // { findingId: [opinion, ...] }
  triageRaws.forEach((r, i) => {
    if (r.status !== 'fulfilled') return;
    const t = r.value.json;
    const m = TRIAGE_RE.exec(triagePaths[i]);
    const fid = (t.finding_id) || (m && m[1]);
    if (!fid) return;
    (triage[fid] ||= []).push(t);
  });
  // sort each finding's opinions by ts ascending so the drawer reads chronologically
  for (const fid of Object.keys(triage)) {
    triage[fid].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  }

  const reports = (await Promise.allSettled(reportPaths.map(p => getJson(p))))
    .map((r, i) => r.status === 'fulfilled' ? { ...r.value.json, _path: reportPaths[i] } : null)
    .filter(Boolean);

  return { findings, triage, reports };
}
