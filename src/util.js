// HTML escape — always use when injecting user / API content into innerHTML.
export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// element factory
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'data') for (const [dk, dv] of Object.entries(v)) node.dataset[dk] = dv;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

// Project name normalization — must match scripts/normalize.mjs.
// "Ecom", " ECOM ", "e-com" → "ecom". Unicode letters are preserved.
export function normalizeProject(name) {
  if (typeof name !== 'string') throw new TypeError('project must be a string');
  let s = name.normalize('NFKC').toLowerCase().trim();
  s = s.replace(/[\s_./:,]+/g, '-');
  s = s.replace(/[^\p{L}\p{N}-]/gu, '');
  s = s.replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!s) throw new Error(`project name normalizes to empty: ${JSON.stringify(name)}`);
  return s;
}

// "2026-04-29T05:22:22.123Z" → "2026-04-29T05-22-22-123Z" (path-safe)
export function tsForPath(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, '-');
}

// Friendly relative time. Falls back to ISO date for older.
export function timeAgo(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return iso;
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return iso.slice(0, 10);
}

export function severityRank(s) {
  return ({ critical: 4, high: 3, medium: 2, low: 1 }[s] || 0);
}
