# AI Vulnerability Triage Board

사내 보안 점검자들이 AI 에이전트가 발견한 취약점을 공동으로 TP/FP 트리아지하는 정적 웹앱. 데이터·인프라·인증을 모두 GitHub (Enterprise) 에 위임 — 외부 SaaS 의존 0.

## 빠른 시작

```bash
python3 -m http.server 8080
# http://127.0.0.1:8080 → PAT 입력 → 진입
```

상세 셋업: [SETUP.md](SETUP.md).

## 디렉토리

| 경로 | 역할 |
|---|---|
| `index.html`, `assets/`, `src/` | 정적 SPA (vanilla JS + ES modules, 빌드 단계 없음) |
| `config.js` | apiBase / repo / branch 설정. PAT는 여기 두지 않음 |
| `scripts/upload-report.mjs` | raw-report → findings + reports 분해, project 정규화 |
| `scripts/normalize.mjs` | project 이름 정규화 함수 (브라우저 SPA와 byte-for-byte 동일) |
| `findings/FND-*.json` | 큐레이션 통과한 개별 finding (immutable) |
| `triage/{fid}/{user}-{ts}.json` | TP/FP 판정 + rationale (append-only, 충돌 0) |
| `reports/RPT-*.json` | 업로드된 raw scanner 리포트 (audit trail) |
| `schema-review/` | 스키마 검토용 mock + 점검자 가이드 |
| `HANDOFF.md`, `TODOS.md` | 설계 결정·운영 작업 |

## 디자인 원칙

- **서버 0**: 브라우저가 GitHub Contents API를 직접 호출
- **append-only**: triage 파일은 추가만, 충돌 없음, latest-wins로 집계
- **세션 토큰**: PAT는 sessionStorage에만, 탭 close 시 자동 폐기
- **client-side rendering**: tree fetch + batch fetch + 수동 새로고침
- **GitHub native audit log**: git log = "누가 언제 어떻게 판정"
