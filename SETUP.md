# Setup — AI Triage Board

End-to-end 테스트 절차. 로컬 → github.com 개발 → GHES 운영 순.

---

## 0. 사전 요구 사항

- Node.js 18+ (script용; SPA는 빌드 단계 없음)
- Python 3 (로컬 정적 서버용)
- GitHub 계정 (개발용) 또는 GHES 접근 권한 (운영용)
- 본인 GitHub 계정에서 생성한 **fine-grained Personal Access Token (PAT)**
  - Repository access: 본 repo 한정
  - Permissions: `Contents` Read and write

> **PAT를 절대 commit하지 말 것.** `config.js`는 토큰을 보관하지 않으며, 토큰은 브라우저 sessionStorage에만 저장됩니다 (탭 close 시 자동 삭제).

---

## 1. 로컬 미리보기 (정적 서버)

```bash
git clone <this-repo>
cd triage-board
python3 -m http.server 8080  # or: bun run serve
# 브라우저에서 http://127.0.0.1:8080 열기
```

PAT 입력 모달 → 본인 PAT 붙여넣기 → 정상 진입.

> 로컬 정적 서버에서도 GitHub Contents API가 호출되므로 `config.js`의 repo는 실제 존재하는 repo여야 합니다 (네트워크 연결 필요).

---

## 2. github.com 개발 repo 셋업

### 2a. 신규 public repo 생성

```bash
# 본인 github.com 계정에 신규 repo 생성: triage-board-dev (public)
git init
git add .
git commit -m "init"
git branch -M main
git remote add origin https://github.com/<YOUR_USER>/triage-board-dev.git
git push -u origin main
```

### 2b. config.js 편집

```js
window.CONFIG = {
  apiBase: 'https://api.github.com',
  repo:    '<YOUR_USER>/triage-board-dev',
  branch:  'main',
};
```

commit + push.

### 2c. GitHub Pages 활성화

repo Settings → Pages → Source: **Deploy from a branch** → Branch: `main` / `/` (root) → Save.

수 분 후 `https://<YOUR_USER>.github.io/triage-board-dev/` 에서 보드가 뜸.

### 2d. PAT 생성

GitHub 우측 상단 → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token

- Repository access: Only `<YOUR_USER>/triage-board-dev`
- Permissions:
  - `Contents`: Read and write
- Generate → 토큰 복사 (한 번만 보임)

### 2e. 워크플로 시연

```bash
# (1) raw-report 등록
node scripts/upload-report.mjs schema-review/raw-reports/RPT-2026-04-29-A.json
git add findings/ reports/
git commit -m "report: RPT-2026-04-29-A (ecom)"
git push

# (2) 보드 새로고침 → finding 카드 보임
# (3) finding 행 클릭 → 상세 진입 → rationale 적고 [Mark TP] / [Mark FP]
# (4) 우측 사이드바 ↻ Refresh → 다른 점검자도 같은 결과를 봄
```

git log로 audit log 확인:

```bash
git log --oneline triage/
```

---

## 3. 같은 finding을 여러 명이 트리아지

분기 시연:

```bash
# alice 계정으로 PAT 발급 → 보드에서 TP 클릭 → push
# bob 계정으로 PAT 발급 → 같은 보드에서 FP 클릭 → push
# 두 commit 모두 triage/{fid}/ 하위에 별도 파일로 저장 (충돌 0)
# 보드에서 status가 `split`로 표시됨 → "의견 보기" 클릭 → drawer로 두 의견 동시 확인
```

---

## 4. GHES 이전

dev 환경에서 워크플로 채택 게이트 (HANDOFF "프로토타입 채택 게이트") 4개 통과한 뒤 운영 GHES로 옮기기:

### 4a. GHES private repo 생성

내부 GHES에 `security/triage-board` (또는 부서 컨벤션) private repo 생성.

### 4b. dev → GHES push

```bash
# 동일 코드, origin만 추가
git remote add ghes https://ghe.company.internal/security/triage-board.git
git push ghes main
```

### 4c. config.js (또는 별도 브랜치/환경) 변경

```js
window.CONFIG = {
  apiBase: 'https://ghe.company.internal/api/v3',
  repo:    'security/triage-board',
  branch:  'main',
};
```

### 4d. GHES Pages 활성화

GHES admin이 Pages 기능 활성화되어 있는지 확인 (TODO 1 참조 — 미리 보안팀에 컨펌 필요할 수 있음). 활성화 시 `https://<org>.pages.ghe.company.internal/triage-board/` 형태 URL.

### 4e. PAT 재발급

GHES 본인 계정으로 PAT 재발급 (github.com PAT는 GHES에서 동작 안 함). 권한은 동일 (Contents R/W).

### 4f. 점검자 1~2명 dogfood

URL 공유 → 일상 트리아지 워크플로에 적용 → 1~2주 사용 후 의견 수집.

---

## 5. 자주 막히는 곳

| 증상 | 원인 / 해결 |
|---|---|
| 보드는 뜨는데 401 떠서 데이터 안 보임 | PAT 만료 또는 권한 부족. Settings에서 Contents R/W 확인 후 새 토큰 발급. |
| TP 클릭하면 422 (sha mismatch) | 동일 (finding, reviewer, ts) 충돌 — `tsForPath()`가 ms 단위라 거의 발생 안 함. 발생 시 다음 클릭에서 새 ts로 자동 회피. |
| "git/trees truncated" 콘솔 경고 | repo가 100k 항목 초과. v1.5 sharding (TODO 4) 도입 시점. |
| GHES에서 CORS 에러 | GHES Pages 도메인과 API 도메인이 다른 origin이라 발생할 수 있음. 운영 GHES admin과 협의해 CORS 허용 또는 같은 origin 배포. |
| 점검자가 PAT 다루기 부담스러워함 | v1에서 OAuth Web Flow + PKCE 도입 (HANDOFF Phase 2 참조). |

---

## 6. 다음 단계

- 30초 폴링 (HANDOFF Phase 5)
- OAuth + PKCE (HANDOFF Phase 2)
- strict ajv schema 검증 (TODO 3)
- 100% test coverage (HANDOFF eng-review test plan 참조)
