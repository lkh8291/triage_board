// PAT auth — sessionStorage by default, localStorage when user opts in via the
// "remember on this device" checkbox. v1 swaps this out for OAuth Web Flow +
// serverless token exchange (HANDOFF Phase 2).

const KEY = 'triage_pat';
const USER_KEY = 'triage_user';

// Try session first (active tab), then local (remembered device).
function readStored(name) {
  return sessionStorage.getItem(name) || localStorage.getItem(name);
}

export const auth = {
  token() { return readStored(KEY); },
  user()  { return readStored(USER_KEY); },
  set(token, login, { remember = false } = {}) {
    const target = remember ? localStorage : sessionStorage;
    const other  = remember ? sessionStorage : localStorage;
    target.setItem(KEY, token);
    if (login) target.setItem(USER_KEY, login);
    other.removeItem(KEY);
    other.removeItem(USER_KEY);
  },
  clear() {
    sessionStorage.removeItem(KEY); sessionStorage.removeItem(USER_KEY);
    localStorage.removeItem(KEY);   localStorage.removeItem(USER_KEY);
  },
};

// Verify token by hitting GET /user. Returns the GitHub login.
// Surfaces concrete reasons (401, network, scope) so the modal can show why.
export async function verifyToken(token) {
  const apiBase = window.CONFIG.apiBase;
  const r = await fetch(`${apiBase}/user`, {
    headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github+json' },
  });
  if (r.status === 401) throw new Error('GitHub returned 401 — token invalid or expired.');
  if (!r.ok) throw new Error(`GitHub /user returned ${r.status}.`);
  const u = await r.json();
  if (!u.login) throw new Error('Token authenticated but no login in response.');
  return u.login;
}

// Build a pre-filled classic-PAT creation URL so users land on the right page
// with the right scope checked. Fine-grained PATs don't accept pre-fill yet (2026).
function patCreationUrl() {
  const desc = `AI Triage Board (${window.CONFIG.repo})`;
  const params = new URLSearchParams({ description: desc, scopes: 'repo' });
  return `https://github.com/settings/tokens/new?${params}`;
}

export function showAuthModal({ initialError = '' } = {}) {
  return new Promise((resolve) => {
    const modal   = document.getElementById('authModal');
    const input   = document.getElementById('patInput');
    const submit  = document.getElementById('patSubmit');
    const err     = document.getElementById('patError');
    const remember = document.getElementById('rememberToken');
    const link    = document.getElementById('patNewLink');

    document.getElementById('cfgRepo').textContent = window.CONFIG.repo;
    document.getElementById('cfgApi').textContent  = window.CONFIG.apiBase;
    if (link) link.href = patCreationUrl();

    function setError(msg) {
      if (msg) { err.textContent = msg; err.hidden = false; }
      else { err.textContent = ''; err.hidden = true; }
    }
    if (initialError) setError(initialError); else setError('');

    modal.hidden = false;
    input.value = '';
    setTimeout(() => input.focus(), 50);

    async function go() {
      const token = input.value.trim();
      if (!token) return setError('토큰을 입력해주세요.');
      submit.disabled = true; setError('');
      try {
        const login = await verifyToken(token);
        auth.set(token, login, { remember: !!remember?.checked });
        // Clean up handlers so the next showAuthModal() call doesn't double-bind.
        submit.onclick = null; input.onkeydown = null;
        submit.disabled = false;
        modal.hidden = true;
        resolve(login);
      } catch (e) {
        setError(e.message);
        submit.disabled = false;
      }
    }
    submit.onclick = go;
    input.onkeydown = (e) => { if (e.key === 'Enter') go(); };
  });
}

// Boot helper: returns the verified login. If no stored token or it's invalid,
// shows the modal until the user provides one that works.
export async function ensureToken() {
  const stored = auth.token();
  if (stored) {
    try { return await verifyToken(stored); }
    catch { auth.clear(); /* fall through to modal */ }
  }
  return showAuthModal();
}
