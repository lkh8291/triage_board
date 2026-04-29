#!/usr/bin/env python3
"""
Upload findings to the AI Triage Board GitHub repo in a single atomic commit.

Two input modes (auto-detected):

  1. Raw scanner report (file path)
       Same shape as schema-review/raw-reports/RPT-*.json — top-level metadata
       + raw_findings[] with curation_decision. Accepted entries become
       findings/FND-*.json; the report is preserved at reports/RPT-*.json.

  2. Per-finding files in a directory
       Each *.json or *.md file in the directory is treated as one finding.
       Requires --project SLUG. A synthetic reports/RPT-*.json is generated
       so the audit trail stays consistent.

Markdown finding format (.md):
    Optional YAML-ish frontmatter (flat key:value lines) at the top, then
    the body becomes the `summary` field.

      ---
      title: Reflected XSS in profile name
      severity: high
      domain: web
      category: xss-reflected
      cwe: CWE-79
      ai_confidence: 0.87
      ---
      <free-form markdown body — used as `summary`>

Auth:
    GITHUB_TOKEN env var, or `gh auth token` from the GitHub CLI.

Repo / branch:
    Pulled from ./config.js. Override with --repo / --branch.

Examples:
    python scripts/upload_report.py schema-review/raw-reports/RPT-2026-04-29-A.json
    python scripts/upload_report.py ./my-findings --project ecom
    python scripts/upload_report.py ./my-findings --project ecom --dry-run
"""

import argparse
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from urllib import error, request
from urllib.parse import urljoin

REPO_ROOT = Path(__file__).resolve().parent.parent

# ============== project name normalization ==============
# This mirrors src/util.js:normalizeProject — they MUST stay byte-for-byte
# identical so the same input produces the same slug whether it arrived via
# this script or the SPA.

def normalize_project(name: str) -> str:
    if not isinstance(name, str):
        raise TypeError("project must be a string")
    s = unicodedata.normalize("NFKC", name).lower().strip()
    s = re.sub(r"[\s_./:,]+", "-", s)
    # keep only unicode letters/digits and hyphens; preserves Korean etc.
    s = "".join(c for c in s if c == "-" or unicodedata.category(c)[0] in ("L", "N"))
    s = re.sub(r"-+", "-", s).strip("-")
    if not s:
        raise ValueError(f"project name normalizes to empty: {name!r}")
    return s


# ============== config.js + auth ==============

def parse_config():
    """Best-effort regex parse of config.js. We don't run JS to avoid eval."""
    cfg = REPO_ROOT / "config.js"
    if not cfg.exists():
        return {"repo": None, "api_base": "https://api.github.com", "branch": "main"}
    text = cfg.read_text(encoding="utf-8")
    def grab(key, default=None):
        m = re.search(rf"{key}\s*:\s*['\"]([^'\"]+)['\"]", text)
        return m.group(1) if m else default
    return {
        "repo":     grab("repo"),
        "api_base": grab("apiBase", "https://api.github.com"),
        "branch":   grab("branch", "main"),
    }


def get_token() -> str:
    if os.environ.get("GITHUB_TOKEN"):
        return os.environ["GITHUB_TOKEN"]
    if not shutil.which("gh"):
        raise SystemExit("No token. Set GITHUB_TOKEN env var or install GitHub CLI (`gh auth login`).")
    try:
        out = subprocess.run(
            ["gh", "auth", "token"],
            check=True, capture_output=True, text=True,
        )
    except subprocess.CalledProcessError as e:
        raise SystemExit(f"`gh auth token` failed: {e.stderr.strip() or e}") from None
    token = out.stdout.strip()
    if not token:
        raise SystemExit("`gh auth token` returned nothing — run `gh auth login` first.")
    return token


# ============== GitHub Git Data API ==============
# We use blobs+trees+commits (rather than per-file Contents API) so that the
# whole upload becomes a single atomic commit — HANDOFF Decision #12.

class GitHubAPI:
    def __init__(self, base: str, repo: str, branch: str, token: str):
        self.base = base.rstrip("/")
        self.repo = repo
        self.branch = branch
        self.token = token

    def _req(self, method: str, path: str, body=None):
        url = f"{self.base}/repos/{self.repo}{path}"
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = request.Request(url, data=data, method=method)
        req.add_header("Authorization", f"token {self.token}")
        req.add_header("Accept", "application/vnd.github+json")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with request.urlopen(req) as resp:
                raw = resp.read()
                return json.loads(raw.decode("utf-8")) if raw else None
        except error.HTTPError as e:
            body_text = e.read().decode("utf-8", errors="replace")[:500]
            raise SystemExit(f"GitHub API {method} {path} → {e.code}: {body_text}") from None
        except error.URLError as e:
            raise SystemExit(f"GitHub API {method} {path} → network error: {e.reason}") from None

    def get_ref(self):           return self._req("GET",   f"/git/refs/heads/{self.branch}")
    def get_commit(self, sha):   return self._req("GET",   f"/git/commits/{sha}")
    def post_blob(self, content):
        return self._req("POST", "/git/blobs", {"content": content, "encoding": "utf-8"})
    def post_tree(self, base_tree_sha, tree):
        return self._req("POST", "/git/trees", {"base_tree": base_tree_sha, "tree": tree})
    def post_commit(self, message, tree_sha, parent_sha):
        return self._req("POST", "/git/commits",
                         {"message": message, "tree": tree_sha, "parents": [parent_sha]})
    def update_ref(self, sha):
        return self._req("PATCH", f"/git/refs/heads/{self.branch}", {"sha": sha})
    def get_contents(self, path):
        # Returns None on 404 (file doesn't exist yet) — caller falls back.
        try:
            return self._req("GET", f"/contents/{path}?ref={self.branch}")
        except SystemExit as e:
            if " 404" in str(e):
                return None
            raise


# ============== domain inference + finding builders ==============

DOMAIN_TAG = {"web": "W", "android": "A", "device": "D", "ios": "I"}

def infer_domain_from_scanner(scanner: str) -> str:
    s = (scanner or "").lower()
    if "android" in s: return "android"
    if "device"  in s: return "device"
    if "ios"     in s: return "ios"
    return "web"

def infer_domain_from_raw(raw: dict, fallback: str) -> str:
    if raw.get("domain"): return raw["domain"]
    if any(k in raw for k in ("url", "method", "endpoint")):                       return "web"
    if any(k in raw for k in ("package", "component_class", "component", "intent_filter")): return "android"
    if any(k in raw for k in ("device_model", "firmware_version", "ip", "port")):  return "device"
    return fallback or "web"

def make_fid(report_id: str, idx: int, domain: str) -> str:
    m = re.search(r"RPT-(\d{4}-\d{2}-\d{2})", report_id or "")
    date = m.group(1) if m else datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return f"FND-{date}-{DOMAIN_TAG.get(domain, 'X')}{idx + 1:02d}"

def abs_url(path_or_url, root):
    if not path_or_url:
        return None
    if re.match(r"^https?://", path_or_url, re.I):
        return path_or_url
    if not root:
        return path_or_url
    try:
        return urljoin(root, path_or_url)
    except Exception:
        return path_or_url

def decision_class(d: str) -> str:
    s = (d or "").lower()
    if s.startswith("accepted"): return "accepted"
    if s.startswith("rejected"): return "rejected"
    return "deferred"

def _strip_nones(d: dict) -> dict:
    return {k: v for k, v in d.items() if v is not None}

def build_web(raw, ctx):
    url = abs_url(raw.get("url"), ctx.get("target_root"))
    return _strip_nones({
        "id": ctx["fid"],
        "report_id": ctx["report_id"],
        "project": ctx["project"],
        "domain": "web",
        "category": raw.get("type"),
        "severity": raw.get("severity_estimate"),
        "title": raw.get("title") or url or raw.get("url") or raw.get("type"),
        "agent": ctx.get("agent"),
        "discovered_at": raw.get("discovered_at") or ctx.get("completed_at"),
        "target": _strip_nones({
            "url": url,
            "method": raw.get("method", "GET"),
            "endpoint": raw.get("endpoint") or raw.get("url"),
            "parameter": raw.get("parameter"),
            "auth_required": raw.get("auth_required"),
        }),
        "evidence": raw.get("evidence"),
        "ai_confidence": raw.get("ai_confidence"),
        "ai_rationale": raw.get("ai_notes") or raw.get("ai_rationale"),
        "cwe": raw.get("cwe"),
        "cve": raw.get("cve"),
    })

def build_android(raw, ctx):
    return _strip_nones({
        "id": ctx["fid"],
        "report_id": ctx["report_id"],
        "project": ctx["project"],
        "domain": "android",
        "category": raw.get("type"),
        "severity": raw.get("severity_estimate"),
        "title": raw.get("title") or raw.get("component_class") or raw.get("type"),
        "agent": ctx.get("agent"),
        "discovered_at": raw.get("discovered_at") or ctx.get("completed_at"),
        "target": raw.get("target") or _strip_nones({
            "package": raw.get("package"),
            "component_class": raw.get("component_class") or raw.get("component"),
            "exported": raw.get("exported"),
        }),
        "evidence": raw.get("evidence"),
        "ai_confidence": raw.get("ai_confidence"),
        "ai_rationale": raw.get("ai_notes") or raw.get("ai_rationale"),
        "cwe": raw.get("cwe"),
        "cve": raw.get("cve"),
    })

def build_device(raw, ctx):
    return _strip_nones({
        "id": ctx["fid"],
        "report_id": ctx["report_id"],
        "project": ctx["project"],
        "domain": "device",
        "category": raw.get("type"),
        "severity": raw.get("severity_estimate"),
        "title": raw.get("title") or f"{raw.get('device_model','')} {raw.get('type','')}".strip(),
        "agent": ctx.get("agent"),
        "discovered_at": raw.get("discovered_at") or ctx.get("completed_at"),
        "target": raw.get("target") or _strip_nones({
            "device_model": raw.get("device_model"),
            "ip": raw.get("ip"),
            "port": raw.get("port"),
            "service": raw.get("service"),
        }),
        "evidence": raw.get("evidence"),
        "ai_confidence": raw.get("ai_confidence"),
        "ai_rationale": raw.get("ai_notes") or raw.get("ai_rationale"),
        "cwe": raw.get("cwe"),
        "cve": raw.get("cve"),
    })

BUILDERS = {"web": build_web, "android": build_android, "device": build_device}


# ============== input parsers ==============

def parse_raw_report(path: Path, project_override):
    raw = json.loads(path.read_text(encoding="utf-8"))
    if "report_id" not in raw:
        raise SystemExit(f"raw-report missing report_id: {path}")
    project_input = project_override or raw.get("project")
    if not project_input:
        raise SystemExit(f"raw-report missing project field (and no --project given): {path}")
    project = normalize_project(project_input)

    accepted = [f for f in raw.get("raw_findings", [])
                if decision_class(f.get("curation_decision")) == "accepted"]
    report_domain = infer_domain_from_scanner(raw.get("scanner"))
    base_ctx = {
        "report_id": raw["report_id"],
        "project": project,
        "agent": raw.get("scanner"),
        "completed_at": raw.get("completed_at"),
        "target_root": raw.get("target_root"),
    }

    files = []
    for i, rf in enumerate(accepted):
        domain = infer_domain_from_raw(rf, report_domain)
        fid = make_fid(raw["report_id"], rf.get("raw_idx", i), domain)
        builder = BUILDERS.get(domain, BUILDERS["web"])
        finding = builder(rf, {**base_ctx, "fid": fid})
        files.append((f"findings/{fid}.json",
                      json.dumps(finding, ensure_ascii=False, indent=2) + "\n"))

    raw_with_norm = {**raw, "project": project}
    files.append((f"reports/{raw['report_id']}.json",
                  json.dumps(raw_with_norm, ensure_ascii=False, indent=2) + "\n"))

    return {
        "project": project,
        "report_id": raw["report_id"],
        "files": files,
        "summary": f"{len(accepted)} findings + 1 report (raw-report mode)",
    }


def parse_frontmatter(text: str):
    """Tiny YAML-flat parser. Returns (meta_dict, body)."""
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n?(.*)$", text, re.DOTALL)
    if not m:
        return ({}, text)
    meta = {}
    for line in m.group(1).splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        kv = re.match(r"^([^:]+):\s*(.*)$", line)
        if not kv:
            continue
        k = kv.group(1).strip()
        v = kv.group(2).strip()
        if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
            v = v[1:-1]
        elif re.match(r"^-?\d+$", v):
            v = int(v)
        elif re.match(r"^-?\d+\.\d+$", v):
            v = float(v)
        elif v.lower() in ("true", "false"):
            v = v.lower() == "true"
        elif v.lower() in ("null", "~"):
            v = None
        meta[k] = v
    return (meta, m.group(2))


def parse_md_finding(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    meta, body = parse_frontmatter(text)
    if not meta:
        title_m = re.search(r"^#+\s+(.+)$", body, re.MULTILINE)
        meta = {"title": title_m.group(1).strip() if title_m else path.stem}
    meta["summary"] = body.strip()
    meta["_source_file"] = path.name
    return meta


def parse_json_finding(path: Path) -> dict:
    obj = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(obj, dict):
        raise SystemExit(f"{path}: top-level JSON must be an object")
    obj["_source_file"] = path.name
    return obj


def parse_dir(path: Path, project_override):
    if not project_override:
        raise SystemExit("Directory mode requires --project SLUG")
    project = normalize_project(project_override)

    files_in = sorted(p for p in path.iterdir()
                      if p.is_file()
                      and p.suffix.lower() in (".json", ".md")
                      and not p.name.startswith("."))
    if not files_in:
        raise SystemExit(f"No .json or .md files in {path}")

    now = datetime.now(timezone.utc)
    today = now.strftime("%Y-%m-%d")
    nonce = now.strftime("%H%M")
    report_id = f"RPT-{today}-{nonce}"

    files = []
    raw_index = []
    for i, p in enumerate(files_in):
        data = parse_md_finding(p) if p.suffix.lower() == ".md" else parse_json_finding(p)
        domain = (data.get("domain") or "web").lower()
        fid = data.get("id") or make_fid(report_id, i, domain)
        finding = _strip_nones({
            "id": fid,
            "report_id": report_id,
            "project": project,
            "domain": domain,
            "category": data.get("category") or data.get("type"),
            "severity": (data.get("severity") or "medium").lower() if data.get("severity") else "medium",
            "title": data.get("title") or data.get("name") or fid,
            "agent": data.get("agent") or "manual-curated",
            "discovered_at": data.get("discovered_at") or now.isoformat().replace("+00:00", "Z"),
            "summary": data.get("summary"),
            "ai_confidence": data.get("ai_confidence"),
            "ai_rationale": data.get("ai_rationale") or data.get("rationale"),
            "cwe": data.get("cwe"),
            "cve": data.get("cve"),
            "target": data.get("target"),
            "evidence": data.get("evidence"),
            "remediation_hint": data.get("remediation_hint"),
        })
        files.append((f"findings/{fid}.json",
                      json.dumps(finding, ensure_ascii=False, indent=2) + "\n"))
        raw_index.append({
            "raw_idx": i,
            "source_file": data.get("_source_file"),
            "fid": fid,
            "title": finding.get("title"),
            "severity": finding.get("severity"),
        })

    try:
        rel = path.relative_to(REPO_ROOT)
        source_dir = str(rel)
    except ValueError:
        source_dir = str(path)

    raw_report = {
        "report_id": report_id,
        "project": project,
        "scanner": "manual-curated",
        "uploaded_via": "scripts/upload_report.py (directory mode)",
        "uploaded_at": now.isoformat().replace("+00:00", "Z"),
        "source_dir": source_dir,
        "raw_findings": raw_index,
    }
    files.append((f"reports/{report_id}.json",
                  json.dumps(raw_report, ensure_ascii=False, indent=2) + "\n"))

    return {
        "project": project,
        "report_id": report_id,
        "files": files,
        "summary": f"{len(raw_index)} findings + 1 synthetic report (directory mode)",
    }


# ============== findings index ==============
# The SPA loads findings/index.json at boot to avoid N parallel /contents fetches.
# Whenever we push new findings, we fold their shallow metadata into the index
# in the same atomic commit so the SPA never sees a stale index.

INDEX_PATH = "findings/index.json"
SHALLOW_TARGET_KEYS = ("url", "method", "endpoint", "package", "component_class",
                       "device_model", "ip", "port", "service")
SHALLOW_FINDING_KEYS = ("id", "report_id", "project", "domain", "severity",
                        "category", "title", "agent", "discovered_at",
                        "ai_confidence", "cwe", "cve")

def shallow_finding(f: dict) -> dict:
    # _path is derived as `findings/${id}.json` at SPA load time — omit here.
    out = {k: f[k] for k in SHALLOW_FINDING_KEYS if f.get(k) is not None}
    t = f.get("target") or {}
    if isinstance(t, dict):
        st = {k: t[k] for k in SHALLOW_TARGET_KEYS if t.get(k) is not None}
        if st:
            out["target"] = st
    return out

def build_index_update(api, files):
    """Returns updated index.json content (str) merging existing remote index
    with the findings being uploaded. Falls back to None if no remote index
    and we can't safely reconstruct it locally — caller should warn."""
    # Pull existing remote index. Single API call; tiny vs per-finding fetch.
    new_entries = {}
    for path, content in files:
        if not path.startswith("findings/") or path == INDEX_PATH:
            continue
        try:
            obj = json.loads(content)
        except json.JSONDecodeError:
            continue
        if obj.get("id"):
            new_entries[obj["id"]] = shallow_finding(obj)
    if not new_entries:
        return None  # nothing to merge

    existing = []
    remote = api.get_contents(INDEX_PATH)
    if remote and remote.get("content"):
        try:
            decoded = base64.b64decode(remote["content"]).decode("utf-8")
            existing = (json.loads(decoded).get("findings") or [])
        except Exception as e:
            print(f"  ! existing index parse failed: {e} — rebuilding from local only")

    merged = {f["id"]: f for f in existing if f.get("id")}
    merged.update(new_entries)            # new wins on collision
    findings_sorted = sorted(merged.values(), key=lambda f: str(f.get("id") or ""))
    doc = {
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "count": len(findings_sorted),
        "findings": findings_sorted,
    }
    return json.dumps(doc, ensure_ascii=False) + "\n"


# ============== output ==============

def push_atomic(api: GitHubAPI, files, message):
    print(f"  → fetching base ref…")
    ref = api.get_ref()
    base_sha = ref["object"]["sha"]
    base_commit = api.get_commit(base_sha)
    base_tree = base_commit["tree"]["sha"]

    print(f"  → uploading {len(files)} blobs in parallel-ish…")
    tree_entries = []
    for path, content in files:
        b = api.post_blob(content)
        tree_entries.append({
            "path": path, "mode": "100644", "type": "blob", "sha": b["sha"],
        })

    print(f"  → creating tree…")
    tree = api.post_tree(base_tree, tree_entries)
    print(f"  → creating commit…")
    commit = api.post_commit(message, tree["sha"], base_sha)
    print(f"  → updating ref {api.branch} → {commit['sha'][:8]}")
    api.update_ref(commit["sha"])
    return commit


def write_local(files, dry_run: bool):
    for path, content in files:
        abs_path = REPO_ROOT / path
        abs_path.parent.mkdir(parents=True, exist_ok=True)
        if dry_run:
            print(f"  ✎ {path} (dry-run)")
            continue
        if abs_path.exists() and abs_path.read_text(encoding="utf-8") == content:
            print(f"  = {path} (unchanged)")
        else:
            abs_path.write_text(content, encoding="utf-8")
            print(f"  + {path}")


def web_url_from_api_base(api_base: str, repo: str) -> str:
    if api_base.endswith("/api/v3"):
        return api_base[:-len("/api/v3")] + f"/{repo}"
    if "api.github.com" in api_base:
        return f"https://github.com/{repo}"
    return f"{api_base}/{repo}"


# ============== main ==============

def main():
    ap = argparse.ArgumentParser(
        description="Upload findings to AI Triage Board GitHub repo.",
        formatter_class=argparse.RawTextHelpFormatter,
        epilog=__doc__.split("Examples:", 1)[1] if "Examples:" in (__doc__ or "") else "",
    )
    ap.add_argument("input", help="Raw-report JSON file OR directory of per-finding .json/.md files")
    ap.add_argument("--project", help="Project slug (required for directory mode; auto-normalized)")
    ap.add_argument("--message", help="Custom commit message")
    ap.add_argument("--repo", help="Override owner/repo (default from config.js)")
    ap.add_argument("--branch", help="Override branch (default from config.js)")
    ap.add_argument("--dry-run", action="store_true", help="Print plan without pushing or writing")
    ap.add_argument("--local", action="store_true", help="Write files to working tree instead of pushing via API")
    args = ap.parse_args()

    input_path = Path(args.input).resolve()
    if not input_path.exists():
        raise SystemExit(f"Input not found: {args.input}")

    if input_path.is_dir():
        result = parse_dir(input_path, args.project)
    else:
        result = parse_raw_report(input_path, args.project)

    print(f"input:    {input_path}")
    print(f"project:  {result['project']}")
    print(f"summary:  {result['summary']}")
    print(f"files:")
    for path, _ in result["files"]:
        print(f"   - {path}")

    message = args.message or f"upload: {result['report_id']} ({result['project']}, {len(result['files'])} files)"

    if args.local:
        print(f"\n--local mode: writing to working tree")
        write_local(result["files"], args.dry_run)
        if not args.dry_run:
            # Rebuild the local index by scanning findings/ on disk — same source
            # of truth as scripts/build-findings-index.mjs uses.
            try:
                subprocess.run(
                    ["node", str(REPO_ROOT / "scripts" / "build-findings-index.mjs")],
                    check=True, cwd=REPO_ROOT,
                )
            except (subprocess.CalledProcessError, FileNotFoundError) as e:
                print(f"  ! could not rebuild index ({e}) — run scripts/build-findings-index.mjs manually")
            print("\nNext: git add findings/ reports/ && git commit && git push")
        return

    if args.dry_run:
        print(f"\n--dry-run: would push '{message}' to GitHub (not pushing)")
        return

    cfg = parse_config()
    repo     = args.repo   or cfg["repo"]
    branch   = args.branch or cfg["branch"]
    api_base = cfg["api_base"]
    if not repo:
        raise SystemExit("No repo configured (set in config.js or pass --repo).")
    token = get_token()

    print(f"\npushing to {repo}@{branch} via {api_base}")
    api = GitHubAPI(api_base, repo, branch, token)

    # Fold the new findings into findings/index.json in the same commit so the SPA
    # never reads a stale index. Best-effort — if remote index is missing, the
    # generated entry only covers the new findings; user should run
    # scripts/build-findings-index.mjs once locally to rebuild from full history.
    index_content = build_index_update(api, result["files"])
    if index_content:
        result["files"].append((INDEX_PATH, index_content))
        print(f"  + {INDEX_PATH} (merged with remote)")

    commit = push_atomic(api, result["files"], message)
    web_base = web_url_from_api_base(api_base, repo)
    print(f"\n✓ pushed: {web_base}/commit/{commit['sha']}")


if __name__ == "__main__":
    main()
