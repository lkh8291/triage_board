# HANDOFF — AI Vulnerability Triage Board

**작성**: 2026-04-29
**상태**: **프로토타입 e2e 구현 완료.** 셋업 + dogfood 단계.
**다음 세션 목표**: SETUP.md 따라 본인 github.com repo에 배포·테스트 → 점검자 1~2명 dogfood → v1 production 작업 진입.

## 프로토타입 구현 현황 (2026-04-29 완료)

| HANDOFF Phase | 상태 | 위치 |
|---|---|---|
| Phase 0 — 부트스트랩 | ✅ vanilla JS (Vite는 v1에서) | `index.html`, `src/`, `assets/`, `package.json` |
| Phase 1 — repo 데이터 모양 | ✅ | `findings/`, `triage/`, `reports/` (8 findings + 3 reports + 2 triage seed) |
| Phase 2 — auth | ✅ PAT 모달 (OAuth는 v1에서) | `src/auth.js` |
| Phase 3 — load + render | ✅ tree + batch fetch, 3 view | `src/loader.js`, `src/views.js` |
| Phase 4 — triage write | ✅ optimistic UI + append-only PUT | `src/app.js` `writeTriage()` |
| Phase 5 — polling | ⏸ 수동 ↻ Refresh로 대체 | (v1에서 30s) |
| Phase 6 — GH Pages | ⏸ 사용자가 SETUP 따라 활성화 | `SETUP.md` 2c |
| Phase 7 — GHES 이전 | ⏸ 사용자가 SETUP 따라 swap | `SETUP.md` §4 |

추가 구현:
- ✅ Project 모델 (site+product → 단일 project, normalize)
- ✅ 다중 의견 drawer (rationale + verdict + ts)
- ✅ Search by project / target / category
- ✅ `scripts/upload-report.mjs` — raw-report 분해, project 정규화, FND 자동 ID

**다음**: SETUP.md 따라 셋업 → 채택 게이트 4개 통과 확인.

---

## 빠른 재개 (Quick start)

다음 세션에서 첫 번째로 할 일:

1. 이 파일과 design doc 읽기 (5분):
   - `HANDOFF.md` (이 파일)
   - `~/.gstack/projects/triage_board/lkh8291-main-design-20260429-112149.md` (design doc, plan-eng-review 결과 포함)
   - `TODOS.md` (블로커·dev/prod 분리 항목)
2. **개인 GitHub public repo에 dev 환경 셋업** (TODO 2 참조)
3. Vite + Preact 프로젝트 부트스트랩
4. minimum viable end-to-end flow 구현 → GH Pages 배포 → 트리아지 클릭 → 반영 확인
5. 작동 확인되면 GHES로 옮겨 사내 점검자와 dogfood

---

## 프로젝트 한 줄 정의

사내 보안 점검자들이 AI 에이전트가 발견한 취약점을 **공동으로 TP/FP 트리아지하는 GitHub Pages 정적 웹앱**. 데이터·인프라·인증을 모두 GitHub Enterprise에 위임해서 외부 SaaS 의존 0.

---

## 결정 잠금 (Architecture, plan-eng-review 2026-04-29)

| # | 결정 | 선택 |
|---|---|---|
| 1 | Mutation API | **브라우저가 GHES Contents API에 OAuth user token으로 직접 PUT** (서버 0) |
| 2 | 동시성 | **Append-only files** — `triage/{fid}/{user}-{ts}.json`, 충돌 0 |
| 3 | OAuth 토큰 | **sessionStorage + 탭 close 자동 폐기** + XSS 하드닝 |
| 4 | 데이터 전달 | **100% client-side rendering** — `git/trees` + batch fetch + 30초 polling |
| 5 | Scale | v1: ~2000 finding ceiling. 초과 시 v1.5 sharding |
| 6 | Schema 검증 | strict at write (브라우저 + CLI), CI 안전망 |
| 7 | Upload | v1: **사람 선별 + scripts/upload-report.mjs CLI** / v2: AI 자동 |
| 8 | Repo | **GHES private repo** (운영) + github.com personal (개발) |
| 9 | SPA 스택 | **Preact + Vite + TSX** (~12KB 번들) |
| 10 | DRY | `/schemas/` 단일 SoT, SPA + CLI 양쪽 ajv 검증 |
| 11 | 에러 | silent failure 금지, 모든 실패 visible banner |
| 12 | CLI atomicity | `git/blobs+trees+commits` 단일 atomic commit (Contents API per-file ❌) |

---

## 결정 미정 (다음 단계로 미룸)

- **JSON Schema 정확한 모양**: schema-review 자료(`schema-review/`)로 점검자 의견 수렴 필요. 프로토타입은 **느슨한 schema** 또는 schema-less로 진행 후 확정 시점에 수렴.
- **AI 스캐너 자동 업로드 (v2)**: v1은 사람 + script
- **전문성 라우팅 (v2)**: XSS 전문가 ↔ XSS finding
- **Reports/Projects 자체 필터 UI** (v1.5)
- **Sharding (v1.5)**: 2000 ceiling 도달 시
- **Disagreement 알림 (v2)**: Slack/Email
- **Mobile 반응형 (v2)**

---

## 다음 세션 목표 정의 — "Workflow Prototype"

이전 plan-eng-review는 **production-ready v1**을 가정해 100% test coverage·strict schema 등을 권장했음. 이번 세션 목표는 **workflow validation prototype**으로 더 가벼움. 합의된 변경:

### 프로토타입 우선순위 (vs production v1)
- ✅ End-to-end flow 작동 (login → finding 보임 → 클릭 → 반영) **무조건**
- ✅ GH Pages 배포 자동화 **무조건**
- ✅ GHES에서 작동 확인 **무조건**
- ⏸ Schema validation (loose JSON.parse + try/catch만, 검증 없음)
- ⏸ 100% test coverage (smoke test 1~2개만)
- ⏸ Virtualized list (≤500 finding이면 불필요)
- ⏸ 도메인별 polymorphic renderer (generic key-value renderer로 모든 도메인 처리)
- ⏸ 3 view 모드 — Findings 뷰만 우선, Reports/Projects는 plan만 잡고
- ⏸ Projects manifest 자동 집계 (project는 finding/report 첫 등장 시 자동 생성, 별도 manifest 불필요한 방식 우선) — 빈 디렉토리로 두고 나중에

### 프로토타입 채택 게이트 (= "성공" 정의)
1. 점검자 1~2명이 사내 GHES에서 로그인해 finding 카드 본다
2. 한 명이 [TP] 클릭하면 다른 사람이 30초 내에 본다
3. git log로 "누가 언제 어떻게 판정"이 audit log로 남는다
4. 사용 후 점검자가 "이 워크플로가 일상 점검에 쓸 만하다 / 안 쓸 만하다" 의견을 줄 수 있다

이 4개가 통과하면 프로토타입은 임무 완료. v1 production 작업으로 진입.

---

## 구체 구현 플랜 (다음 세션)

### Phase 0: Dev 환경 부트스트랩 (~30분)

```bash
cd /home/lkh8291/work/ai/triage_board
git init
# 본인 github.com personal account에 새 repo 생성: triage-board-dev
git remote add origin https://github.com/<personal>/triage-board-dev.git

# Vite + Preact + TS + ESLint
bun create vite . --template preact-ts
# 또는 npm create vite@latest . -- --template preact-ts

# 디렉토리 구조 만들기
mkdir -p src/{auth,data,views,components,lib} schemas scripts findings triage reports raw-reports projects
```

### Phase 1: Repo 데이터 모양 (10분, schema 미정 상태)

`findings/` 와 `triage/` 만 있으면 실제로 작동.

`findings/FND-2026-04-29-001.json` (loose schema, key 자유):
```json
{
  "id": "FND-2026-04-29-001",
  "report_id": "RPT-2026-04-29-A",
  "project": "ecom",
  "title": "Reflected XSS in user profile name parameter",
  "severity": "high",
  "category": "xss-reflected",
  "domain": "web",
  "target": "GET /api/users/profile?name=",
  "ai_confidence": 0.87,
  "ai_rationale": "name 파라미터가 unescaped로 반영...",
  "discovered_at": "2026-04-29T03:14:00Z"
}
```

`project`는 raw-report에 명시 → upload script가 finding으로 상속. 같은 project 첫 등장 시 자동 생성, 이후 동일 project 업로드 시 finding append.

(향후 추가될 fields는 client에서 ignore하면 되므로 forward-compatible)

`triage/FND-2026-04-29-001/alice-2026-04-29T05-22-22Z.json`:
```json
{
  "finding_id": "FND-2026-04-29-001",
  "verdict": "tp",
  "reviewer": "alice",
  "rationale": "Stored, exploitable from public user list.",
  "ts": "2026-04-29T05:22:22.123Z"
}
```

3~5개 example finding을 손으로 commit해서 시작.

### Phase 2: GitHub OAuth flow (~2시간)

1. github.com에 OAuth App 등록
   - Application name: `triage-board-dev`
   - Homepage URL: `https://<personal>.github.io/triage-board-dev`
   - Authorization callback URL: `https://<personal>.github.io/triage-board-dev/callback`
   - `Client ID` 받음 (Client Secret은 client-side OAuth라 안 씀, PKCE 사용)

2. `src/auth/oauth.ts`:
   - GitHub OAuth Web Flow + PKCE (Client Secret 없이)
   - 또는 fallback: 사용자가 PAT 직접 입력 (개발 단계 빠른 시작)
   - **개발 단계는 PAT 입력 방식이 가장 단순** — 점검자가 본인 fine-grained PAT 만들어 paste, sessionStorage에 저장

3. `src/auth/token-store.ts`:
   - sessionStorage wrapper
   - 탭 close → 자동 사라짐
   - 토큰 기본 스코프 검증 (repo write 가능한지)

### Phase 3: 데이터 로드 + 렌더 (~3시간)

`src/data/github-api.ts`:
```ts
const BASE = import.meta.env.VITE_GITHUB_API_BASE; // dev: https://api.github.com, prod: https://ghe.company.internal/api/v3
const REPO = import.meta.env.VITE_GITHUB_REPO; // owner/repo

async function getTree() {
  return fetch(`${BASE}/repos/${REPO}/git/trees/main?recursive=1`, {
    headers: { Authorization: `token ${getToken()}` }
  }).then(r => r.json());
}

async function getJson(path) { /* ... */ }
async function putContent(path, content) { /* ... */ }
```

`src/data/loader.ts`:
- getTree로 모든 path 가져옴
- `findings/*.json` 일괄 batch fetch
- `triage/**/*.json` 일괄 fetch
- 합쳐서 finding 객체 배열 + per-finding triage 배열로 만들어 리턴

`src/data/aggregator.ts`:
- consensus 계산 (latest per user → all TP / all FP / mixed=split)

`src/views/FindingsView.tsx` (가장 단순한 형태):
- 행 리스트, 클릭 시 사이드 패널
- TP/FP 버튼 → put + optimistic UI

이 단계까지 마치면 **read 작동**. 이미 schema-review/spa-main.html이 시안 역할 — 거의 동일한 구조로 구현.

### Phase 4: Triage write (~1시간)

`src/components/TriageButton.tsx`:
```ts
async function onClick(verdict: 'tp' | 'fp') {
  setOptimisticVerdict(verdict); // local state 즉시 반영
  try {
    const path = `triage/${findingId}/${user}-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
    await putContent(path, { finding_id: findingId, verdict, reviewer: user, ts: new Date().toISOString() });
    setConfirmedVerdict(verdict);
  } catch (e) {
    rollbackOptimistic();
    showErrorBanner(e);
  }
}
```

### Phase 5: Polling (~30분)

`src/data/poller.ts`:
- 30초마다 `getTree`
- tree hash 비교
- 변경된 path만 fetch
- aggregator 재계산

### Phase 6: GH Pages 배포 (~30분)

`.github/workflows/deploy.yml`:
- on push to main
- Vite build → docs/ 또는 dist/
- actions/deploy-pages

`vite.config.ts`:
- `base: '/triage-board-dev/'` (subpath 배포)
- `build.outDir: 'dist'`

### Phase 7: GHES 이전 (~1시간)

dev에서 작동 확인되면 GHES로:
- 같은 코드, env vars만 swap
  - `VITE_GITHUB_API_BASE=https://ghe.company.internal/api/v3`
  - `VITE_GITHUB_REPO=security/triage-board`
- GHES에 OAuth App 등록 (또는 PAT 방식 유지)
- GHES private repo 생성, 동일 데이터 commit
- Pages enable (admin 필요할 수 있음 — TODO 1)

### Phase 8: 점검자 1~2명에게 dogfood

- 5~10개 example finding을 만들어 commit
- 점검자에게 URL 공유
- 워크플로 작동 확인 + 의견 수집

**총 추정**: 본업과 병행하며 ~1주일.

---

## 작업 시 의도적으로 미룬 것 (혼란 방지)

다음은 **이번 프로토타입 단계에서는 안 함**:

- [ ] strict ajv schema validation
- [ ] 100% test coverage (Vitest unit 70+ / Playwright 6+) — smoke test만
- [ ] virtualized list (preact-virtual)
- [ ] 도메인별 polymorphic renderer (web/android/device 분기 렌더)
- [ ] 4 view 중 Reports/Sites/Products (Findings만)
- [ ] reports/sites/products manifest 자동 집계
- [ ] memoization 최적화
- [ ] CSP header strict 설정 (basic level만)
- [ ] disagreement detection UI
- [ ] re-vote latest-wins 로직 정교화
- [ ] view original report drawer (schema-review에 mock 있음, 구현은 schema 확정 후)

이 항목들은 점검자 dogfood 후 v1 production 단계에서 추가.

---

## 현재 세션 산출물 위치

### 디자인·아키텍처 문서 (~/.gstack/ — 영구 보관)

| 파일 | 역할 |
|---|---|
| `~/.gstack/projects/triage_board/lkh8291-main-design-20260429-112149.md` | **메인 design doc**. office-hours + plan-eng-review 모든 결정사항 포함. |
| `~/.gstack/projects/triage_board/lkh8291-main-eng-review-test-plan-20260429-130000.md` | 테스트 플랜 (production용, 프로토타입은 일부만) |
| `~/.gstack/projects/triage_board/designs/triage-board-20260429/approved.json` | 디자인 시안 B (Linear) 승인 기록 |
| `~/.gstack/projects/triage_board/designs/triage-board-20260429/variant-B-linear.html` | 승인된 SPA 시안 (4 view 포함) |
| `~/.gstack/projects/triage_board/designs/triage-board-20260429/variant-{A,C,D,E}-*.html` | 거절된 시안 (참고용) |
| `~/.gstack/projects/triage_board/designs/triage-board-20260429/index.html` | 5개 시안 비교 인덱스 |

### 작업 디렉토리 (/home/lkh8291/work/ai/triage_board/)

| 파일 | 역할 |
|---|---|
| `HANDOFF.md` | 이 파일 |
| `TODOS.md` | 5개 운영 TODO (GHES checklist, dev→prod 분리, schema docs, sharding, 보안팀 결재) |
| `schema-review/` | 점검자 검토용 자료 (다음 세션의 schema 확정에 사용) |
| `schema-review/spa-main.html` | **multi-domain SPA 메인 페이지 mock** — 구현 시 참고용 |
| `schema-review/{web,android,device}-finding.html` | 도메인별 finding 상세 mock + view original report drawer |
| `schema-review/{web,android,device}-finding.json` | finding JSON 예제 |
| `schema-review/raw-reports/RPT-2026-04-29-{A,B,C}.json` | raw scanner 출력 예제 + curation 흔적 |
| `schema-review/index.html` | 점검자가 한 번에 모든 자료 보는 인덱스 |
| `schema-review/README.md` | 점검자용 검토 가이드 + 9개 검토 질문 |

### 백그라운드 서버 (다음 세션 시작 시 정리)

```bash
# 현재 두 개의 python http.server 가 떠있음:
# port 8765 (designs/triage-board-20260429 — 5개 시안 비교)
# port 8770 (schema-review)

# 다음 세션에서 정리:
pkill -f "python3 -m http.server"
```

---

## 다음 세션 첫 메시지에 붙일 컨텍스트

```
프로젝트: AI Vulnerability Triage Board (사내 GHES + GH Pages 기반).
현재 상태: 디자인·아키텍처 잠금 완료, 프로토타입 구현 시작 단계.
HANDOFF.md를 먼저 읽고, design doc(~/.gstack/projects/triage_board/lkh8291-main-design-20260429-112149.md)으로 컨텍스트 복원.
첫 작업: Vite + Preact 부트스트랩 → 본인 github.com 개인 repo (triage-board-dev) 셋업 → 최소 end-to-end flow.
```

---

## 핵심 인사이트 (프로토타입에서 검증할 가설)

1. **GH Pages + 클라이언트 직접 API 패턴이 사내 보안팀 게이트를 실제로 통과하는가?** ← 가장 큰 미지수. 작동해도 보안팀이 막을 수도 있음. 빠른 dogfood로 확인.
2. **30초 polling이 점검자 협업 워크플로에 충분한 즉시성인가?** ← 너무 느리면 데이터 흐름 모델 변경 필요.
3. **append-only 파일 모델로 git history가 audit log 역할 충분한가?** ← 보안팀이 별도 감사 시스템 요구하는지.
4. **PAT 입력 방식 vs OAuth 가 사용자 마찰 어떻게 다른가?** ← 개발 단계 PAT, 운영 OAuth로 분리할지 판단.
5. **점검자가 평소 워크플로(로컬 분석 → Confluence)를 실제로 이 보드로 옮기는가?** ← 채택 게이트.

이 5개에 대한 답을 가지고 v1 production 설계를 다시 잡으면 됨.

---

## 연락 (혼자 작업 시는 미적용)

이슈/PR/커밋은 `triage-board-dev` repo 안에서. 향후 GHES 이전 시 commit history 유지하려면 dev repo의 git 객체를 GHES repo로 push (origin 변경).

---

**끝.** 다음 세션에서 보자.
