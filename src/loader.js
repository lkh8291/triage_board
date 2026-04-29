// One-shot loader. Calls git/trees once to learn every path in the repo,
// then batch-fetches the JSON for findings/, triage/, reports/ in parallel.
// 30s polling (HANDOFF Phase 5) plugs in here once we want auto-refresh.

import { getTree, getJson } from './api.js';

const FINDING_RE  = /^findings\/[^/]+\.json$/;
const TRIAGE_RE   = /^triage\/([^/]+)\/[^/]+\.json$/;
const REPORT_RE   = /^reports\/[^/]+\.json$/;

export async function loadAll() {
  const tree = await getTree();
  const findingPaths = [];
  const triagePaths  = [];
  const reportPaths  = [];
  for (const t of tree) {
    if (t.type !== 'blob') continue;
    if (FINDING_RE.test(t.path)) findingPaths.push(t.path);
    else if (TRIAGE_RE.test(t.path)) triagePaths.push(t.path);
    else if (REPORT_RE.test(t.path)) reportPaths.push(t.path);
  }

  // settle even when some files fail — we'd rather show a partial board than nothing
  const findings = (await Promise.allSettled(findingPaths.map(p => getJson(p))))
    .map((r, i) => r.status === 'fulfilled' ? { ...r.value.json, _path: findingPaths[i] }
                                              : { _error: r.reason?.message, _path: findingPaths[i] })
    .filter(f => !f._error);

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
