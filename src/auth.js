// PAT auth — sessionStorage-backed. Token is gone when the tab closes.
// In v1 production this becomes OAuth Web Flow + PKCE; for the prototype,
// a fine-grained PAT keeps the moving parts to one.

const KEY = 'triage_pat';
const USER_KEY = 'triage_user';

export const auth = {
  token() { return sessionStorage.getItem(KEY); },
  user()  { return sessionStorage.getItem(USER_KEY); },
  set(token, login) {
    sessionStorage.setItem(KEY, token);
    if (login) sessionStorage.setItem(USER_KEY, login);
  },
  clear() {
    sessionStorage.removeItem(KEY);
    sessionStorage.removeItem(USER_KEY);
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

// Show modal, wait for user to submit a working token, persist it. Resolves on success.
export function showAuthModal({ initialError = '' } = {}) {
  return new Promise((resolve) => {
    const modal = document.getElementById('authModal');
    const input = document.getElementById('patInput');
    const submit = document.getElementById('patSubmit');
    const err = document.getElementById('patError');
    document.getElementById('cfgRepo').textContent = window.CONFIG.repo;
    document.getElementById('cfgApi').textContent = window.CONFIG.apiBase;

    function setError(msg) {
      if (msg) { err.textContent = msg; err.hidden = false; }
      else { err.textContent = ''; err.hidden = true; }
    }
    if (initialError) setError(initialError);

    modal.hidden = false;
    input.value = '';
    input.focus();

    async function go() {
      const token = input.value.trim();
      if (!token) return setError('토큰을 입력해주세요.');
      submit.disabled = true; setError('');
      try {
        const login = await verifyToken(token);
        auth.set(token, login);
        modal.hidden = true;
        submit.disabled = false;
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
