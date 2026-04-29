// All rendering. Vanilla DOM via the el() factory in util.js. The data lives in
// state and is rebuilt on every render — the page is small enough that we don't
// need diff-based updates yet.

import { el, esc, timeAgo, severityRank } from './util.js';
import { consensusFor } from './aggregator.js';
import { commitUrl } from './api.js';

const SEV_ORDER = ['critical', 'high', 'medium', 'low'];

// ============== shared bits ==============

function avatarFor(login) {
  // Just lowercase first letter; deterministic color from a small palette.
  const l = (login || '?').toLowerCase();
  const palette = ['alice', 'bob', 'charlie', 'x'];
  let hash = 0;
  for (const c of l) hash = (hash * 31 + c.charCodeAt(0)) | 0;
  const cls = palette[Math.abs(hash) % palette.length];
  return el('span', { class: `av-sm ${cls}` }, l[0] || '?');
}
function opinionAvatar(login) {
  const l = (login || '?').toLowerCase();
  const palette = ['alice', 'bob', 'charlie', 'x'];
  let hash = 0;
  for (const c of l) hash = (hash * 31 + c.charCodeAt(0)) | 0;
  const cls = palette[Math.abs(hash) % palette.length];
  return el('span', { class: `opinion-av ${cls}` }, l[0] || '?');
}

function severityPill(sev) {
  return el('span', { class: `sev-pill ${sev || 'low'}` }, sev || 'low');
}

function severityCounts(findings) {
  const c = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) c[f.severity] = (c[f.severity] || 0) + 1;
  return c;
}

function statusTag(status) {
  return el('span', { class: `status-tag ${status}` }, status === 'pending' ? 'pending' :
    status === 'tp' ? 'TP' : status === 'fp' ? 'FP' : 'split');
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

export function renderFindingsList(state, root, onPick) {
  root.innerHTML = '';
  if (!state.findings.length) {
    root.appendChild(el('div', { class: 'empty-state' },
      el('h3', {}, '아직 finding이 없습니다.'),
      el('p', {}, 'scripts/upload-report.mjs로 raw-report를 업로드해 보드에 등록하세요.')
    ));
    return;
  }
  const head = el('div', { class: 'table-head' },
    el('span', {}), el('span', {}, 'Sev'), el('span', {}, 'Domain'),
    el('span', {}, 'Category'), el('span', {}, 'Target'),
    el('span', {}, 'AI conf'), el('span', {}, 'Reviewers'), el('span', {}, 'Status')
  );
  root.appendChild(head);

  const sorted = [...state.findings].sort((a, b) =>
    (severityRank(b.severity) - severityRank(a.severity)) ||
    String(a.id).localeCompare(String(b.id))
  );

  for (const f of sorted) {
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
      el('span', {}, el('span', { class: 'cat-chip' }, f.category || '')),
      el('span', { class: 'target' }, targetLabel(f)),
      el('span', { class: 'conf' },
        el('span', { class: 'conf-bar' }, el('i', { style: `width:${Math.round((f.ai_confidence || 0) * 100)}%` })),
        (f.ai_confidence != null ? f.ai_confidence.toFixed(2) : '—')
      ),
      el('span', { class: 'reviewers' }, ...cons.reviewers.map(opinionAvatar)),
      statusTag(cons.status),
    );
    root.appendChild(row);
  }
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

  // Triage actions
  const rationale = el('textarea', {
    class: 'triage-rationale',
    placeholder: '판정 근거 (선택) — 다른 점검자도 볼 수 있는 메모. TP/FP를 누르면 함께 기록됩니다.',
  });

  const tpBtn = el('button', { class: 'btn tp', onclick: () => handlers.onTriage(f.id, 'tp', rationale.value) }, 'Mark True Positive');
  const fpBtn = el('button', { class: 'btn fp', onclick: () => handlers.onTriage(f.id, 'fp', rationale.value) }, 'Mark False Positive');
  const skip = el('button', { class: 'btn skip', onclick: () => history.back() }, 'Need more info →');

  const countEl = hasOpinions
    ? el('span', { class: 'triage-count' },
        `${cons.opinions.length}명 트리아지함 (${cons.status}) · `,
        el('a', { onclick: (e) => { e.preventDefault(); handlers.openTriageDrawer(fid); } }, '의견 보기 →')
      )
    : el('span', { class: 'triage-count empty' }, '아직 트리아지 0건');

  const triageCard = el('div', { class: 'triage-actions' },
    el('div', { class: 'triage-row' }, tpBtn, fpBtn, skip, countEl),
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
    const counts = severityCounts(findings);
    const triagedCount = findings.filter(f => consensusFor(state.triage[f.id] || []).status !== 'pending').length;
    list.appendChild(el('article', { class: 'group-card', data: { project: r.project || '' } },
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
        sevRow(counts, findings.length, triagedCount)
      )
    ));
  }
  root.appendChild(list);
}

function sevRow(counts, total, triaged) {
  const total_ = Math.max(total, 1);
  const bar = el('div', { class: 'sev-bar' });
  for (const k of SEV_ORDER) {
    if (counts[k]) bar.appendChild(el('i', { class: k, style: `width:${(counts[k] / total_) * 100}%` }));
  }
  const counts_ = el('div', { class: 'sev-counts' });
  for (const k of SEV_ORDER) {
    if (counts[k]) counts_.appendChild(el('span', { class: `sev-count ${k}` }, el('span', { class: 'd' }), String(counts[k])));
  }
  return el('div', { class: 'gc-row-2' },
    bar,
    counts_,
    el('div', { class: 'progress' }, el('i', { style: `width:${(triaged / total_) * 100}%` })),
    el('div', { class: 'triage-text' }, `${triaged} / ${total} triaged`),
    el('div', { class: 'gc-stat' },
      el('div', { class: 'num' }, String(total)),
      el('div', { class: 'label' }, total === 1 ? 'finding' : 'findings'))
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
    const counts = severityCounts(p.findings);
    const triagedCount = p.findings.filter(f => consensusFor(state.triage[f.id] || []).status !== 'pending').length;
    list.appendChild(el('article', { class: 'group-card', data: { project: p.id } },
      el('div', { class: 'gc-head' },
        el('div', { class: 'gc-title' },
          p.id,
          el('span', { class: 'id-mono' }, `${p.reports.size} report · ${p.findings.length} findings`)
        ),
      ),
      el('div', { class: 'gc-body' },
        sevRow(counts, p.findings.length, triagedCount)
      )
    ));
  }
  root.appendChild(list);
}

// ============== Search filter ==============

export function applySearchFilter(query) {
  const q = (query || '').trim().toLowerCase();
  const active = document.querySelector('section#viewRoot');
  if (!active) return;
  for (const item of active.querySelectorAll('.row, .group-card')) {
    if (!q) { item.style.display = ''; continue; }
    const project = (item.dataset.project || '').toLowerCase();
    const text = item.textContent.toLowerCase();
    item.style.display = (project.includes(q) || text.includes(q)) ? '' : 'none';
  }
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
