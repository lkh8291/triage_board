// All rendering. Vanilla DOM via the el() factory in util.js. The data lives in
// state and is rebuilt on every render — the page is small enough that we don't
// need diff-based updates yet.

import { el, esc, timeAgo, severityRank } from './util.js?v=202604291117';
import { consensusFor } from './aggregator.js?v=202604291117';
import { commitUrl } from './api.js?v=202604291117';

// ============== pagination + search state (module-local) ==============
//
// Listing tables (All findings / Project drill-down / Report drill-down) share
// page state — fine because changing the source list clamps _page on render.
// _query lives here so app.js doesn't need to thread it through every call.

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200];
const DEFAULT_PAGE_SIZE = 50;
const PAGE_SIZE_KEY = 'triage-board:page-size';

function clampPageSize(n) { return PAGE_SIZE_OPTIONS.includes(+n) ? +n : DEFAULT_PAGE_SIZE; }

let _pageSize = clampPageSize(+localStorage.getItem(PAGE_SIZE_KEY) || DEFAULT_PAGE_SIZE);
let _page = 1;
let _query = '';

export function setPageSize(n) {
  _pageSize = clampPageSize(n);
  localStorage.setItem(PAGE_SIZE_KEY, String(_pageSize));
  _page = 1;
}
export function setPage(n) { _page = Math.max(1, +n || 1); }
export function setSearchQuery(q) {
  const next = (q || '').trim().toLowerCase();
  if (next !== _query) _page = 1;
  _query = next;
}

// ============== shared bits ==============

// Render a reviewer avatar.
// Layered: colored circle + first letter as fallback (always there), GitHub
// profile image overlaid on top via <img> (auto-removed on 404 / network error).
// "GitHub profile photo if available" is achieved by hitting github.com/<user>.png —
// works for github.com users; for GHES we'd need a different host (handled later).
function _renderAvatar(login, baseClass) {
  const l = (login || '?').toLowerCase();
  const palette = ['alice', 'bob', 'charlie', 'x'];
  let hash = 0;
  for (const c of l) hash = (hash * 31 + c.charCodeAt(0)) | 0;
  const cls = palette[Math.abs(hash) % palette.length];
  const wrap = el('span', { class: `${baseClass} ${cls}`, title: login || '' });
  // text fallback (visible until <img> covers it; stays if img errors)
  wrap.appendChild(el('span', { class: 'av-initial' }, l[0] || '?'));
  if (login && /^[a-zA-Z0-9-]+$/.test(login)) {
    const img = document.createElement('img');
    img.src = `https://github.com/${encodeURIComponent(login)}.png?size=44`;
    img.alt = login;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.addEventListener('error', () => img.remove());
    wrap.appendChild(img);
  }
  return wrap;
}
function avatarFor(login)     { return _renderAvatar(login, 'av-sm'); }
function opinionAvatar(login) { return _renderAvatar(login, 'opinion-av'); }
function emptyAvatar(label = 'no reviewer yet') {
  // Dashed-circle placeholder per V8 — appears when nobody has triaged yet.
  return el('span', { class: 'av-sm empty', title: label }, '?');
}

function severityPill(sev) {
  return el('span', { class: `sev-pill ${sev || 'low'}` }, sev || 'low');
}

function statusTag(status) {
  return el('span', { class: `status-tag ${status}` }, status === 'pending' ? 'pending' :
    status === 'tp' ? 'TP' : status === 'fp' ? 'FP' : 'split');
}

// Pick the freshest opinion this user wrote; null if they haven't triaged yet.
function latestOpinionByUser(opinions, login) {
  if (!login) return null;
  const mine = (opinions || []).filter(o => o.reviewer === login);
  if (!mine.length) return null;
  mine.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  return mine[mine.length - 1];
}

// ============== sidebar ==============

export function renderSidebar(state, currentView) {
  const nav = document.getElementById('sidebarNav');
  nav.innerHTML = '';
  const inbox = el('div', { class: 'nav-section' },
    el('h4', {}, 'Inbox'),
    navItem('All findings', state.findings.length, currentView === 'findings'),
  );
  // Per-project group counts
  const projects = projectSummary(state);
  const projectsBlock = el('div', { class: 'nav-section' }, el('h4', {}, 'Projects'));
  for (const p of projects) {
    projectsBlock.appendChild(navItem(el('span', { class: 'mono', style: "font-family:'JetBrains Mono',monospace;font-size:12px" }, p.id), p.findings.length));
  }
  nav.appendChild(inbox);
  nav.appendChild(projectsBlock);
}

function navItem(label, count, active = false) {
  const node = el('div', { class: 'nav-item' + (active ? ' active' : '') });
  if (typeof label === 'string') node.appendChild(document.createTextNode(label));
  else node.appendChild(label);
  node.appendChild(el('span', { class: 'count' }, String(count)));
  return node;
}

// ============== view counts in tabs ==============

export function renderTabCounts(state) {
  document.getElementById('cnt-findings').textContent = state.findings.length;
  document.getElementById('cnt-reports').textContent  = state.reports.length;
  document.getElementById('cnt-projects').textContent = projectSummary(state).length;
}

// ============== Findings list ==============

export function renderFindingsList(state, root, onPick, onRefresh) {
  root.innerHTML = '';
  appendFindingsTable(state.findings, state, root, onPick, onRefresh);
}

// Reusable rows builder. Used both by the top-level Findings view and by the
// drill-down pages (report / project). Filters by the current search query and
// renders only the active page; pagination controls under the table call
// onRefresh() to re-render after page/size changes.
function appendFindingsTable(findings, state, root, onPick, onRefresh) {
  if (!findings.length) {
    root.appendChild(el('div', { class: 'empty-state' },
      el('h3', {}, '아직 finding이 없습니다.'),
      el('p', {}, '연관된 finding이 아직 등록되지 않았습니다.')
    ));
    return;
  }

  const sorted = [...findings].sort((a, b) =>
    (severityRank(b.severity) - severityRank(a.severity)) ||
    String(a.id).localeCompare(String(b.id))
  );
  const filtered = _query ? sorted.filter(f => findingMatchesQuery(f, _query)) : sorted;

  const totalPages = Math.max(1, Math.ceil(filtered.length / _pageSize));
  if (_page > totalPages) _page = totalPages;
  const startIdx = (_page - 1) * _pageSize;
  const pageRows = filtered.slice(startIdx, startIdx + _pageSize);

  if (!filtered.length) {
    root.appendChild(el('div', { class: 'empty-state' },
      el('h3', {}, `검색 결과 없음`),
      el('p', {}, `"${_query}" 와 일치하는 finding이 없습니다.`)
    ));
    return;
  }

  const head = el('div', { class: 'table-head' },
    el('span', {}), el('span', {}, 'Sev'), el('span', {}, 'Domain'),
    el('span', {}, 'Category'), el('span', {}, 'Target'),
    el('span', {}, 'Reviewers'), el('span', {}, 'Status')
  );
  root.appendChild(head);

  for (const f of pageRows) {
    const cons = consensusFor(state.triage[f.id] || []);
    const row = el('a', {
      class: 'row',
      href: `#/finding/${encodeURIComponent(f.id)}`,
      data: { project: f.project || '', id: f.id },
      onclick: (e) => { e.preventDefault(); onPick(f.id); },
    },
      el('span', {}, el('span', { class: `dot ${f.severity}` })),
      el('span', { class: `sev-text ${f.severity}` }, capitalize(f.severity || '')),
      el('span', {}, el('span', { class: `domain-tag ${f.domain || ''}` }, (f.domain || '').toUpperCase())),
      el('span', {}, el('span', { class: 'cat-chip', title: f.category || '' }, f.category || '')),
      el('span', { class: 'target' }, targetLabel(f)),
      el('span', { class: 'reviewers' }, ...cons.reviewers.map(avatarFor)),
      statusTag(cons.status),
    );
    root.appendChild(row);
  }

  root.appendChild(paginationBar({
    page: _page,
    totalPages,
    pageSize: _pageSize,
    totalItems: filtered.length,
    sourceTotal: findings.length,
    query: _query,
    onRefresh: onRefresh || (() => {}),
  }));
}

function findingMatchesQuery(f, q) {
  if (!q) return true;
  // Cheap field-by-field test; avoids JSON.stringify on hot path.
  const t = f.target || {};
  const haystack = [
    f.id, f.project, f.domain, f.category, f.severity, f.title,
    f.cwe, f.cve, f.report_id,
    t.url, t.endpoint, t.method, t.package, t.component_class,
    t.device_model, t.ip, t.service,
  ];
  for (const v of haystack) {
    if (v != null && String(v).toLowerCase().includes(q)) return true;
  }
  return false;
}

function paginationBar({ page, totalPages, pageSize, totalItems, sourceTotal, query, onRefresh }) {
  const select = el('select', { class: 'page-size-select',
    onchange: (e) => { setPageSize(e.target.value); onRefresh(); }
  });
  for (const n of PAGE_SIZE_OPTIONS) {
    const opt = el('option', { value: String(n) }, String(n));
    if (n === pageSize) opt.selected = true;
    select.appendChild(opt);
  }

  const prev = el('button', {
    class: 'page-btn',
    onclick: () => { if (page > 1) { setPage(page - 1); onRefresh(); } },
  }, '← Prev');
  if (page <= 1) prev.disabled = true;

  const next = el('button', {
    class: 'page-btn',
    onclick: () => { if (page < totalPages) { setPage(page + 1); onRefresh(); } },
  }, 'Next →');
  if (page >= totalPages) next.disabled = true;

  const filteredNote = query && totalItems !== sourceTotal
    ? ` (filtered from ${sourceTotal.toLocaleString()})`
    : '';

  return el('div', { class: 'pagination' },
    prev,
    el('span', { class: 'page-info' }, 'Page ', el('strong', {}, String(page)), ` / ${totalPages}`),
    next,
    el('span', { class: 'page-spacer' }),
    el('span', { class: 'page-meta' }, `${totalItems.toLocaleString()} results${filteredNote}`),
    el('label', { class: 'page-size' }, 'Rows: ', select),
  );
}

function safeHost(url) {
  if (!url || typeof url !== 'string') return '';
  try { return new URL(url).host; } catch { return ''; }
}

function targetLabel(f) {
  // tolerant of partial schemas — if target.* is missing, fall back to title or id
  const t = f.target || {};
  if (f.domain === 'web' && (t.endpoint || t.url)) {
    return [el('strong', {}, t.method || 'GET'), ' ', safeHost(t.url), ' ', t.endpoint || t.url || ''];
  }
  if (f.domain === 'android' && t.package) {
    return [el('strong', {}, t.package), t.component_class ? ' · ' + t.component_class.split('.').pop() : ''];
  }
  if (f.domain === 'device' && t.device_model) {
    return [el('strong', {}, t.device_model), t.ip ? ` · ${t.ip}:${t.port || ''}/${t.service || ''}` : ''];
  }
  return f.title || f.id;
}

function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : ''; }

// ============== Finding detail ==============

export function renderFindingDetail(state, root, fid, handlers) {
  const f = state.findings.find(x => x.id === fid);
  if (!f) {
    root.innerHTML = '';
    root.appendChild(el('div', { class: 'empty-state' }, el('h3', {}, `Finding ${fid} not found.`)));
    return;
  }
  const opinions = state.triage[fid] || [];
  const cons = consensusFor(opinions);
  const hasOpinions = cons.opinions.length > 0;

  root.innerHTML = '';

  const wrap = el('div', { class: 'detail-wrap' });
  const main = el('div');
  const sidebar = el('aside', { class: 'detail-sidebar' });

  // Header card
  const meta = el('div', { class: 'meta-row' },
    el('span', { class: 'id-block' }, f.id),
    severityPill(f.severity),
    f.category && el('span', { class: 'cat-chip' }, f.category),
    f.cwe      && el('span', { class: 'cat-chip', style: 'color:#9ca3af' }, f.cwe),
  );
  const headerCard = el('div', { class: 'card' },
    meta,
    el('h1', { class: 'headline' }, f.title || (f.id + ' — ' + (f.category || ''))),
    el('div', { class: 'meta-row', style: 'color: var(--text-2); font-size: 12.5px;' },
      f.agent ? `found by ${f.agent}` : '', ' · ',
      f.discovered_at || '', ' · ',
      f.report_id ? `report ${f.report_id}` : ''
    )
  );
  main.appendChild(headerCard);

  // Summary card (only when ai_rationale exists; other free-form summary fields could plug in here)
  if (f.ai_rationale || f.summary) {
    main.appendChild(el('div', { class: 'card summary-card' },
      el('h2', {}, 'Summary'),
      el('p', {}, f.summary || f.ai_rationale)
    ));
  }

  // Triage actions — buttons start neutral; the user's own latest verdict
  // shows as the filled (active) button so they always see what they decided.
  // The rationale textarea can be saved standalone via "Save note" (or Ctrl/Cmd+Enter)
  // after a verdict has been recorded, so users can elaborate after-the-fact
  // without re-clicking TP/FP.
  const myLatest = latestOpinionByUser(opinions, handlers.currentUser);
  const myVerdict = myLatest?.verdict;
  const initialRationale = myLatest?.rationale || '';

  const rationale = el('textarea', {
    class: 'triage-rationale',
    placeholder: '판정 근거 (선택) — TP/FP를 누르면 함께 기록됩니다. 나중에 메모만 추가/수정하려면 "Save note" 또는 Ctrl/⌘+Enter.',
  });
  rationale.value = initialRationale;

  const tpBtn = el('button', {
    class: 'btn tp' + (myVerdict === 'tp' ? ' active' : ''),
    onclick: () => handlers.onTriage(f.id, 'tp', rationale.value),
  }, myVerdict === 'tp' ? '✓ True Positive' : 'Mark True Positive');

  const fpBtn = el('button', {
    class: 'btn fp' + (myVerdict === 'fp' ? ' active' : ''),
    onclick: () => handlers.onTriage(f.id, 'fp', rationale.value),
  }, myVerdict === 'fp' ? '✓ False Positive' : 'Mark False Positive');

  // Save-note button: writes a new triage entry under the current verdict with
  // just the updated rationale. Disabled until a verdict exists AND the textarea
  // differs from what's already saved.
  const noteBtn = el('button', {
    class: 'btn note',
    title: myVerdict ? '메모만 갱신 (현재 판정 유지)' : 'TP / FP를 먼저 선택해주세요',
    onclick: () => {
      if (!myVerdict || rationale.value === initialRationale) return;
      handlers.onTriage(f.id, myVerdict, rationale.value);
    },
  }, 'Save note');
  noteBtn.disabled = !myVerdict || rationale.value === initialRationale;

  rationale.addEventListener('input', () => {
    noteBtn.disabled = !myVerdict || rationale.value === initialRationale;
  });
  rationale.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      if (myVerdict && rationale.value !== initialRationale) {
        handlers.onTriage(f.id, myVerdict, rationale.value);
      }
    }
  });

  const countEl = hasOpinions
    ? el('span', { class: 'triage-count' },
        `${cons.opinions.length}명 트리아지함 (${cons.status}) · `,
        el('a', { onclick: (e) => { e.preventDefault(); handlers.openTriageDrawer(fid); } }, '의견 보기 →')
      )
    : el('span', { class: 'triage-count empty' }, '아직 트리아지 0건');

  const triageCard = el('div', { class: 'triage-actions' },
    el('div', { class: 'triage-row' }, tpBtn, fpBtn, noteBtn, countEl),
    rationale
  );
  main.appendChild(triageCard);

  // Generic key-value renderer for target.* and evidence.* — tolerant of missing fields
  if (f.target) main.appendChild(kvCard('Target', f.target));
  if (f.evidence) main.appendChild(kvCard('Evidence', f.evidence));
  if (f.remediation_hint) {
    main.appendChild(el('div', { class: 'card' },
      el('h2', {}, 'Remediation hint'),
      el('p', { style: 'margin: 0; line-height: 1.65;' }, f.remediation_hint)
    ));
  }

  // Sidebar
  sidebar.appendChild(el('div', { class: 'card' },
    el('h2', {}, 'Classification'),
    field('domain', f.domain),
    field('category', f.category, true),
    field('severity', (f.severity || '').toUpperCase()),
    field('cwe', f.cwe, true),
    field('cve', f.cve, true),
  ));
  sidebar.appendChild(el('div', { class: 'card' },
    el('h2', {}, 'Asset'),
    field('project', f.project || '—', true),
    field('report_id', f.report_id || '—', true),
  ));

  wrap.appendChild(main);
  wrap.appendChild(sidebar);
  root.appendChild(wrap);
}

function field(label, value, mono = false) {
  const v = value == null || value === '' ? el('span', { class: 'value', style: 'color:var(--text-3); font-style:italic;' }, 'null')
    : el('span', { class: 'value' + (mono ? ' mono' : '') }, String(value));
  return el('div', { class: 'field' },
    el('span', { class: 'label' }, label), v
  );
}

function kvCard(title, obj) {
  const tbody = el('tbody');
  for (const [k, v] of Object.entries(obj || {})) {
    const td = el('td', { class: 'mono' });
    if (v == null) td.appendChild(el('span', { class: 'null' }, 'null'));
    else if (typeof v === 'boolean') td.appendChild(el('span', { class: v ? 'bool-true' : '' }, String(v)));
    else if (typeof v === 'object') {
      const pre = el('pre', { class: 'code' }, JSON.stringify(v, null, 2));
      td.appendChild(pre);
    } else if (typeof v === 'string' && v.length > 200) {
      td.appendChild(el('pre', { class: 'code' }, v));
    } else {
      td.textContent = String(v);
    }
    tbody.appendChild(el('tr', {}, el('th', {}, k), td));
  }
  return el('div', { class: 'card' },
    el('h2', {}, title),
    el('table', { class: 'kv-table' }, tbody)
  );
}

// ============== Triage drawer ==============

export function openTriageDrawer(state, fid) {
  const ops = state.triage[fid] || [];
  const cons = consensusFor(ops);
  document.getElementById('triageTitle').textContent =
    `Triage opinions — ${cons.opinions.length}건 (${cons.status})`;

  const body = document.getElementById('triageBody');
  body.innerHTML = '';
  if (!cons.opinions.length) {
    body.appendChild(el('p', { class: 'muted' }, '아직 의견이 없습니다.'));
  } else {
    body.appendChild(el('p', { class: 'muted small', style: 'margin: 0 0 14px;' },
      '같은 finding을 본 점검자들의 판정과 근거. 의견이 갈리면 (split) 추가 검토가 필요합니다.'
    ));
    for (const o of cons.opinions) {
      body.appendChild(el('div', { class: `triage-opinion ${o.verdict}` },
        el('div', { class: 'opinion-head' },
          opinionAvatar(o.reviewer),
          el('span', { class: 'opinion-name' }, o.reviewer),
          el('span', { class: `verdict-badge ${o.verdict}` }, o.verdict),
          el('span', { class: 'opinion-ts' }, o.ts || '')
        ),
        o.rationale
          ? el('p', { class: 'opinion-rationale' }, o.rationale)
          : el('p', { class: 'opinion-rationale empty' }, '근거 메모 없음')
      ));
    }
  }

  document.getElementById('triageFoot').textContent =
    cons.status === 'split'
      ? '의견이 갈렸음 — latest-wins 룰로 새 판정이 들어오면 split이 갱신됩니다.'
      : `consensus: ${cons.status}`;

  document.getElementById('triageOverlay').classList.add('open');
  const p = document.getElementById('triagePanel');
  p.classList.add('open');
  p.setAttribute('aria-hidden', 'false');
}

export function closeTriageDrawer() {
  document.getElementById('triageOverlay').classList.remove('open');
  const p = document.getElementById('triagePanel');
  p.classList.remove('open');
  p.setAttribute('aria-hidden', 'true');
}

// ============== Reports view ==============

export function renderReports(state, root) {
  root.innerHTML = '';
  if (!state.reports.length) {
    root.appendChild(el('div', { class: 'empty-state' }, el('h3', {}, '아직 업로드된 report가 없습니다.')));
    return;
  }
  const list = el('div', { class: 'group-list' });
  const sorted = [...state.reports].sort((a, b) => String(b.completed_at || '').localeCompare(String(a.completed_at || '')));
  for (const r of sorted) {
    const findings = state.findings.filter(f => f.report_id === r.report_id);
    list.appendChild(el('article', {
      class: 'group-card',
      data: { project: r.project || '' },
      onclick: () => { location.hash = `#/report/${encodeURIComponent(r.report_id)}`; },
    },
      el('div', { class: 'gc-head' },
        el('div', { class: 'gc-title' },
          (r.target_root || r.target_apk_path || r.target_subnet || '(report)'),
          el('span', { class: 'id-mono' }, r.report_id),
          r.project && el('span', { class: 'proj-chip' }, r.project),
        ),
        el('div', { class: 'gc-meta' },
          r.uploader?.github ? `uploaded by ${r.uploader.github}` : '',
          r.completed_at ? timeAgo(r.completed_at) : '',
          r.scanner || ''
        )
      ),
      el('div', { class: 'gc-body' },
        progressRow(state, findings)
      )
    ));
  }
  root.appendChild(list);
}

// Drill-down: header strip with report meta, then the full triage table for findings in this report.
export function renderReportDetail(state, root, reportId, onPick, onRefresh) {
  const r = state.reports.find(x => x.report_id === reportId);
  root.innerHTML = '';
  if (!r) {
    root.appendChild(el('div', { class: 'empty-state' }, el('h3', {}, `Report ${reportId} not found.`)));
    return;
  }
  const findings = state.findings.filter(f => f.report_id === reportId);
  const triagedCount = findings.filter(f => consensusFor(state.triage[f.id] || []).status !== 'pending').length;

  root.appendChild(el('div', { class: 'detail-strip' },
    el('span', { class: 'ds-title' }, r.target_root || r.target_apk_path || r.target_subnet || r.report_id),
    el('span', { class: 'ds-id' }, r.report_id),
    r.project && el('span', { class: 'proj-chip' }, r.project),
    el('span', { class: 'ds-meta ds-spacer' },
      el('span', {}, `${findings.length} findings`),
      el('span', {}, `${triagedCount} triaged`),
      r.scanner && el('span', {}, r.scanner),
      r.completed_at && el('span', {}, timeAgo(r.completed_at))
    )
  ));
  appendFindingsTable(findings, state, root, onPick, onRefresh);
}

// Triage-progress chart for Reports/Projects card body. Severity is intentionally
// omitted (low confidence in scanner severity). Layout = V6 (left % + bar) +
// V8 (right avatar pile + 2-line summary), per the chart-variants page.
function progressRow(state, scopeFindings) {
  const total = scopeFindings.length;
  let tp = 0, fp = 0, split = 0;
  const reviewers = new Set();
  for (const f of scopeFindings) {
    const cons = consensusFor(state.triage[f.id] || []);
    if      (cons.status === 'tp')    tp++;
    else if (cons.status === 'fp')    fp++;
    else if (cons.status === 'split') split++;
    for (const r of cons.reviewers) reviewers.add(r);
  }
  const triaged = tp + fp + split;
  const pending = total - triaged;
  const pct = total > 0 ? Math.round((triaged / total) * 100) : 0;
  const resolved = total > 0 && pending === 0;
  const reviewersList = [...reviewers];

  // ---- right-side text: just the single summary line (no TP/FP breakdown there) ----
  const reviewerLabel = reviewersList.length === 0
    ? 'no reviewer'
    : (reviewersList.length === 1 ? '1 reviewer' : `${reviewersList.length} reviewers`);
  const progressLabel = resolved && total > 0 ? `all ${total} triaged` : `${triaged} of ${total} triaged`;
  const row1 = `${reviewerLabel} · ${progressLabel}`;

  // ---- avatar pile ----
  const pile = el('div', { class: 'progress-pile' });
  for (const r of reviewersList.slice(0, 4)) pile.appendChild(avatarFor(r));
  if (reviewersList.length > 4)
    pile.appendChild(el('span', { class: 'av-sm av-overflow', title: `+${reviewersList.length - 4} more` }, `+${reviewersList.length - 4}`));
  if (reviewersList.length === 0)
    pile.appendChild(emptyAvatar());

  // ---- V7 segmented bar: filled portions show TP/FP/split ratio,
  //      remaining space is implicit pending ----
  const safe = Math.max(total, 1);
  const bar = el('div', { class: 'progress-bar' });
  if (tp)    bar.appendChild(el('i', { class: 'seg-tp',    style: `width:${(tp    / safe) * 100}%` }));
  if (fp)    bar.appendChild(el('i', { class: 'seg-fp',    style: `width:${(fp    / safe) * 100}%` }));
  if (split) bar.appendChild(el('i', { class: 'seg-split', style: `width:${(split / safe) * 100}%` }));

  // ---- secondary dot row (V6) below the bar — only non-zero categories ----
  const secondary = el('div', { class: 'progress-secondary' });
  if (tp)      secondary.appendChild(el('span', { class: 'p-tp' },      `● ${tp} TP`));
  if (fp)      secondary.appendChild(el('span', { class: 'p-fp' },      `● ${fp} FP`));
  if (split)   secondary.appendChild(el('span', { class: 'p-split' },   `● ${split} split`));
  if (pending) secondary.appendChild(el('span', { class: 'p-pending' }, `● ${pending} pending`));

  return el('div', { class: 'progress-row' },
    el('div', { class: 'progress-label' },
      el('div', { class: 'pct-line' + (resolved ? ' resolved' : '') },
        el('span', { class: 'pct' }, `${pct}%`)
      ),
      el('div', { class: 'sub' }, resolved ? 'Triage Completed' : 'triaged')
    ),
    el('div', { class: 'progress-bar-wrap' },
      bar,
      secondary
    ),
    el('div', { class: 'progress-right' },
      pile,
      el('div', { class: 'sum-row1' + (resolved ? ' resolved' : '') }, row1)
    )
  );
}

// ============== Projects view ==============

export function projectSummary(state) {
  const groups = new Map();
  for (const f of state.findings) {
    const p = f.project || '(unassigned)';
    if (!groups.has(p)) groups.set(p, { id: p, findings: [], reports: new Set() });
    groups.get(p).findings.push(f);
    if (f.report_id) groups.get(p).reports.add(f.report_id);
  }
  return [...groups.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function renderProjects(state, root) {
  root.innerHTML = '';
  const projects = projectSummary(state);
  if (!projects.length) {
    root.appendChild(el('div', { class: 'empty-state' }, el('h3', {}, 'project가 아직 없습니다.')));
    return;
  }
  const list = el('div', { class: 'group-list' });
  for (const p of projects) {
    list.appendChild(el('article', {
      class: 'group-card',
      data: { project: p.id },
      onclick: () => { location.hash = `#/project/${encodeURIComponent(p.id)}`; },
    },
      el('div', { class: 'gc-head' },
        el('div', { class: 'gc-title' },
          p.id,
          el('span', { class: 'id-mono' }, `${p.reports.size} report · ${p.findings.length} findings`)
        ),
      ),
      el('div', { class: 'gc-body' },
        progressRow(state, p.findings)
      )
    ));
  }
  root.appendChild(list);
}

export function renderProjectDetail(state, root, projectId, onPick, onRefresh) {
  const findings = state.findings.filter(f => f.project === projectId);
  root.innerHTML = '';
  if (!findings.length) {
    root.appendChild(el('div', { class: 'empty-state' }, el('h3', {}, `Project ${projectId} has no findings yet.`)));
    return;
  }
  const reports = new Set(findings.map(f => f.report_id).filter(Boolean));
  const triagedCount = findings.filter(f => consensusFor(state.triage[f.id] || []).status !== 'pending').length;

  root.appendChild(el('div', { class: 'detail-strip' },
    el('span', { class: 'ds-title' }, `Project: ${projectId}`),
    el('span', { class: 'ds-meta ds-spacer' },
      el('span', {}, `${reports.size} ${reports.size === 1 ? 'report' : 'reports'}`),
      el('span', {}, `${findings.length} findings`),
      el('span', {}, `${triagedCount} triaged`)
    )
  ));
  appendFindingsTable(findings, state, root, onPick, onRefresh);
}

// ============== Search filter ==============
//
// Stores the query in module state and lets the caller re-run the current
// route (so the filter applies pre-pagination across all matching rows,
// not just the rows already in the DOM).

export function applySearchFilter(query, onRefresh) {
  setSearchQuery(query);
  if (onRefresh) onRefresh();
}

// ============== Banner (errors / status) ==============

export function showBanner(kind, msg, action) {
  const b = document.getElementById('banner');
  b.className = `banner ${kind}`;
  b.innerHTML = '';
  b.appendChild(document.createTextNode(msg));
  if (action) {
    const btn = el('button', { onclick: () => { b.hidden = true; action(); } }, action.label || 'Retry');
    b.appendChild(btn);
  } else {
    b.appendChild(el('button', { onclick: () => b.hidden = true }, '✕'));
  }
  b.hidden = false;
}
