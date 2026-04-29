// Boot + router + state management.
//
// Layout: hash-based routing
//   #/                  → findings list
//   #/finding/:id       → detail
//   #/reports           → reports list
//   #/projects          → projects list

import { ensureToken, auth, showAuthModal } from './auth.js?v=202604291117';
import { putJson, getJson } from './api.js?v=202604291117';
import { loadAll } from './loader.js?v=202604291117';
import * as views from './views.js?v=202604291117';
import { tsForPath } from './util.js?v=202604291117';

let state = { findings: [], triage: {}, reports: [], login: null };

async function boot() {
  if (!window.CONFIG?.repo) {
    views.showBanner('error', 'config.js 누락 — repo / apiBase 설정이 필요합니다.');
    return;
  }
  state.login = await ensureToken();
  document.getElementById('userPill').textContent = '@' + state.login;
  await refresh();
  router();
  window.addEventListener('hashchange', router);

  document.getElementById('searchInput').addEventListener('input', (e) => views.applySearchFilter(e.target.value, router));
  document.getElementById('refreshBtn').addEventListener('click', () => refresh());
  document.getElementById('logoutBtn').addEventListener('click', () => {
    auth.clear();
    location.reload();
  });
  for (const t of document.querySelectorAll('.view-tab')) {
    t.addEventListener('click', () => {
      const v = t.dataset.view;
      location.hash = v === 'findings' ? '#/' : `#/${v}`;
    });
  }
  document.getElementById('triageClose').addEventListener('click', views.closeTriageDrawer);
  document.getElementById('triageOverlay').addEventListener('click', views.closeTriageDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') views.closeTriageDrawer(); });
}

async function refresh() {
  try {
    state = { ...state, ...(await loadAll()) };
    views.renderTabCounts(state);
    views.renderSidebar(state);
    router();
  } catch (e) {
    if (e.status === 401) {
      const login = await showAuthModal({ initialError: e.message });
      state.login = login;
      return refresh();
    }
    views.showBanner('error', `로딩 실패: ${e.message}`, { label: 'Retry', onClick: refresh });
  }
}

function router() {
  const hash = location.hash || '#/';
  const root = document.getElementById('viewRoot');
  setActiveTab(hash);
  views.applySearchFilter(document.getElementById('searchInput').value);
  const onPickFinding = (fid) => { location.hash = `#/finding/${encodeURIComponent(fid)}`; };

  if (hash.startsWith('#/finding/')) {
    const id = decodeURIComponent(hash.slice('#/finding/'.length));
    document.getElementById('pageTitle').textContent = id;
    document.getElementById('crumbs').innerHTML =
      `Workspace · <strong>AI Triage</strong> · <a href="#/">Findings</a> · ${escapeHtml(id)}`;
    const renderDetail = () => views.renderFindingDetail(state, root, id, {
      onTriage: writeTriage,
      openTriageDrawer: (fid) => views.openTriageDrawer(state, fid),
      currentUser: state.login,
    });
    renderDetail();
    // Index gives us only shallow metadata — pull full JSON on demand and re-render.
    hydrateIfShallow(id).then((changed) => {
      if (changed && location.hash === `#/finding/${encodeURIComponent(id)}`) renderDetail();
    });
    return;
  }
  if (hash.startsWith('#/report/')) {
    const id = decodeURIComponent(hash.slice('#/report/'.length));
    document.getElementById('pageTitle').textContent = id;
    document.getElementById('crumbs').innerHTML =
      `Workspace · <strong>AI Triage</strong> · <a href="#/reports">Reports</a> · ${escapeHtml(id)}`;
    views.renderReportDetail(state, root, id, onPickFinding, router);
    return;
  }
  if (hash.startsWith('#/project/')) {
    const id = decodeURIComponent(hash.slice('#/project/'.length));
    document.getElementById('pageTitle').textContent = id;
    document.getElementById('crumbs').innerHTML =
      `Workspace · <strong>AI Triage</strong> · <a href="#/projects">Projects</a> · ${escapeHtml(id)}`;
    views.renderProjectDetail(state, root, id, onPickFinding, router);
    return;
  }
  if (hash === '#/reports') {
    document.getElementById('pageTitle').textContent = 'Reports';
    document.getElementById('crumbs').innerHTML = 'Workspace · <strong>AI Triage</strong> · Reports';
    views.renderReports(state, root);
    return;
  }
  if (hash === '#/projects') {
    document.getElementById('pageTitle').textContent = 'Projects';
    document.getElementById('crumbs').innerHTML = 'Workspace · <strong>AI Triage</strong> · Projects';
    views.renderProjects(state, root);
    return;
  }
  // default: findings list
  document.getElementById('pageTitle').textContent = 'All findings';
  document.getElementById('crumbs').innerHTML = 'Workspace · <strong>AI Triage</strong>';
  views.renderFindingsList(state, root, onPickFinding, router);
}

// Index entries carry only shallow metadata — full target/evidence/rationale
// arrives only when the user opens the detail drawer.
async function hydrateIfShallow(fid) {
  const f = state.findings.find(x => x.id === fid);
  if (!f || !f._shallow || !f._path) return false;
  try {
    const { json } = await getJson(f._path);
    Object.assign(f, json, { _shallow: false });
    return true;
  } catch (e) {
    console.warn('[hydrate]', f._path, e);
    return false;
  }
}

function setActiveTab(hash) {
  let v = 'findings';
  if (hash.startsWith('#/reports') || hash.startsWith('#/report/')) v = 'reports';
  else if (hash.startsWith('#/projects') || hash.startsWith('#/project/')) v = 'projects';
  for (const t of document.querySelectorAll('.view-tab')) t.classList.toggle('active', t.dataset.view === v);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ============== Triage write ==============
//
// Append-only model: each (finding, reviewer, ts) is its own file. No SHA needed,
// no merge conflicts. Latest-wins is computed at read time by the aggregator.
async function writeTriage(fid, verdict, rationale) {
  const ts = new Date().toISOString();
  const path = `triage/${fid}/${state.login}-${tsForPath()}.json`;
  const body = {
    finding_id: fid,
    verdict,
    reviewer: state.login,
    rationale: rationale || '',
    ts,
  };

  // Optimistic UI: stitch into local state immediately, render, then network.
  (state.triage[fid] ||= []).push(body);
  router();

  try {
    await putJson(path, body, { message: `triage(${verdict}): ${fid} by ${state.login}` });
    views.showBanner('info', `${verdict.toUpperCase()} 기록됨 — ${path}`);
    setTimeout(() => { document.getElementById('banner').hidden = true; }, 3000);
  } catch (e) {
    // Roll back optimistic update on failure.
    state.triage[fid] = (state.triage[fid] || []).filter(o => o !== body);
    router();
    if (e.status === 401) {
      await showAuthModal({ initialError: e.message });
      return writeTriage(fid, verdict, rationale);
    }
    views.showBanner('error', `Triage 기록 실패: ${e.message}`);
  }
}

boot().catch((e) => {
  console.error(e);
  views.showBanner('error', `Boot failed: ${e.message}`);
});
