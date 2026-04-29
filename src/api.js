// Thin GitHub Contents/Trees API client. Same code paths for github.com and GHES —
// only window.CONFIG.apiBase differs. All calls authenticate with the PAT in sessionStorage.

import { auth } from './auth.js';

function base() { return window.CONFIG.apiBase; }
function repo() { return window.CONFIG.repo; }
function branch() { return window.CONFIG.branch || 'main'; }

function headers() {
  const t = auth.token();
  if (!t) throw new Error('not authenticated');
  return { Authorization: `token ${t}`, Accept: 'application/vnd.github+json' };
}

// Concrete failures matter — surface 401 separately so the app can re-prompt.
async function check(r) {
  if (r.status === 401) {
    auth.clear();
    throw Object.assign(new Error('Token rejected (401). Re-enter token.'), { status: 401 });
  }
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`${r.status} ${r.statusText}: ${body.slice(0, 200)}`);
  }
  return r;
}

// GET /repos/{repo}/git/trees/{ref}?recursive=1 — single round-trip listing of every path.
// Returns an array of {path, type, sha}.
export async function getTree() {
  const r = await fetch(
    `${base()}/repos/${repo()}/git/trees/${branch()}?recursive=1`,
    { headers: headers() }
  );
  await check(r);
  const data = await r.json();
  if (data.truncated) {
    console.warn('git/trees truncated — repo above 100k entries; sharding needed for v1.5');
  }
  return data.tree || [];
}

// GET /repos/{repo}/contents/{path} → { content (base64), sha }
export async function getJson(path) {
  const r = await fetch(
    `${base()}/repos/${repo()}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}?ref=${branch()}`,
    { headers: headers() }
  );
  await check(r);
  const data = await r.json();
  // base64 → utf-8 string. atob gives latin-1 bytes; decode through TextDecoder.
  const bin = atob(data.content.replace(/\n/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const text = new TextDecoder('utf-8').decode(bytes);
  return { json: JSON.parse(text), sha: data.sha };
}

// PUT /repos/{repo}/contents/{path} → create-or-update a single file (a single commit).
// For triage writes (one file each), this is plenty atomic. For multi-file uploads,
// scripts/upload_report.py uses git/blobs+trees+commits for atomic multi-file upload (HANDOFF Decision #12).
export async function putJson(path, data, { sha, message } = {}) {
  const text = JSON.stringify(data, null, 2);
  // utf-8 → base64
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const content = btoa(bin);

  const body = {
    message: message || `triage: write ${path}`,
    content,
    branch: branch(),
  };
  if (sha) body.sha = sha;

  const r = await fetch(
    `${base()}/repos/${repo()}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`,
    { method: 'PUT', headers: { ...headers(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
  await check(r);
  return r.json();
}

// Convenience: human-friendly URL to a specific commit for audit links in the UI.
export function commitUrl(sha) {
  // Works for both github.com and GHES (replace /api/v3 → /).
  const webBase = base().replace(/\/api\/v3\/?$/, '').replace(/^https:\/\/api\.github\.com$/, 'https://github.com');
  return `${webBase}/${repo()}/commit/${sha}`;
}
