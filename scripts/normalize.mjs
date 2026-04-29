// Single source of truth for project name normalization. The browser SPA
// (src/util.js → normalizeProject) intentionally duplicates this logic byte-for-byte
// so the same input produces the same slug whether it arrived via upload script or UI.
//
// Rules:
//   1. NFKC unicode normalization (collapses width variants, ligatures)
//   2. lowercase
//   3. trim
//   4. runs of whitespace, _, ., /, :, , → single hyphen
//   5. drop everything that is not [unicode letter, unicode digit, hyphen]
//   6. collapse multiple hyphens → single
//   7. strip leading / trailing hyphens
// Throws on empty result.

export function normalizeProject(name) {
  if (typeof name !== 'string') {
    throw new TypeError('project must be a string');
  }
  let s = name.normalize('NFKC').toLowerCase().trim();
  s = s.replace(/[\s_./:,]+/g, '-');
  s = s.replace(/[^\p{L}\p{N}-]/gu, '');
  s = s.replace(/-+/g, '-');
  s = s.replace(/^-|-$/g, '');
  if (!s) {
    throw new Error(`project name normalizes to empty string: ${JSON.stringify(name)}`);
  }
  return s;
}
