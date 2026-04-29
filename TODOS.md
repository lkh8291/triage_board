# TODOS

상태: v1 plan-eng-review 결과 (2026-04-29).

각 TODO는 **What / Why / Pros / Cons / Context / Depends on** 형식.

---

## TODO 1 — GHES admin pre-deploy checklist

**What**: 운영(GHES) 배포 전 사내 admin에게 확인·요청해야 할 항목 일괄 추적.

**Why**: 이걸 누락하면 데모 직전에 "GH Pages가 작동 안 한다" 또는 "OAuth 등록 권한이 없다" 같은 이슈로 출시 막힘.

**Checklist**:
- [ ] GHES 버전 (`/setup/api/v1` 또는 admin 페이지에서 확인) — 3.10+ 인지 (fine-grained PAT, OAuth PKCE 지원 영향)
- [ ] GitHub Pages on GHES enable 여부 (admin이 인스턴스 차원에서 enable 필요)
- [ ] OAuth App 등록 권한 — 본인이 가능한지, 아니면 admin 요청 필요한지
- [ ] 사내 SSO 결합 방식 (SAML, LDAP, AD) — repo collaborator 자동 동기화 정책
- [ ] OAuth callback URL 정책 — GHES는 보통 `*.{ghes-domain}` 만 허용
- [ ] CSP/CORS 정책 — 사내 정적 사이트가 GHES API 호출 가능한지
- [ ] 사내 보안팀 사전 결재 (취약점 데이터 GHES private repo에 저장)

**Pros**: 데모 직전 차단 위험 회피, 일정 보호.
**Cons**: 본인 외 admin 일정 의존 → 1~2주 lead time 잡아두기.
**Context**: design doc Open Question #1 (P5), Architecture Issue #8 결정.
**Depends on / blocked by**: 사내 admin 회신.

---

## TODO 2 — 개발 환경(public github) → 운영 환경(GHES) 마이그레이션 경로

**What**: 두 환경에서 같은 코드가 동작하도록 환경 분리 + 데이터 안전장치.

**Why**: dev = github.com 공개 repo + 합성 데이터, prod = GHES private repo + 실제 취약점 데이터. 코드가 환경 차이를 흡수해야 함. 실제 데이터가 dev repo에 우연히 들어가는 사고 방지 필요.

**Sub-items**:
- [ ] `VITE_BASE_URL` 환경변수: dev=`https://api.github.com`, prod=`https://ghe.company.internal/api/v3`
- [ ] OAuth Client ID/Secret 환경별 분리 + .env.example 템플릿
- [ ] Repo URL 환경변수: dev=`personal/triage-board-dev`, prod=`security/triage-board`
- [ ] 합성 테스트 데이터 셋 (`fixtures/dev-findings/`) — 실제 취약점 좌표 0
- [ ] dev repo에 prod 데이터 commit 시 자동 차단 (pre-commit hook이 evidence 필드의 사내 도메인 정규식 매칭 → 거부)
- [ ] 환경 분리 README — "어떻게 dev에서 작업하고 prod로 옮기는가"

**Pros**: 사고 차단, dev 단계의 마찰 0 (admin 게이트 없이 작업).
**Cons**: env 추상화 추가, .env 누수 위험은 별도 관리.
**Context**: 사용자 보강 — "개발 시점에서는 내 개인 repo (public github)에서 테스트".
**Depends on / blocked by**: TODO 1 (GHES 정보 알아야 prod env vars 채움).

---

## TODO 3 — JSON Schema 사양 문서 (`/schemas/README.md`) 및 예제

**What**: AI 스캐너 팀이 입력 포맷 맞추기 위한 사양서.

**Why**: AI 스캐너는 별도 팀/시스템. 이 보드 입력 포맷을 명시 안 하면 "리포트가 매번 모양이 다른" 현상 그대로. P3(스키마 표준화 선행) 합의의 실천.

**Deliverables**:
- [ ] `/schemas/finding.schema.json` (JSON Schema draft-2020-12)
- [ ] `/schemas/triage.schema.json`
- [ ] `/schemas/{reports,projects}-manifest.schema.json`
- [ ] `/schemas/README.md` — 각 스키마 의도, 필드 의미, AI 측 책임 vs 보드 측 책임
- [ ] `/schemas/examples/` — 유효 + 의도적 invalid 예제 (validator 테스트용)
- [ ] AI 스캐너 팀에 공유 + 의견 수렴 1회

**Pros**: AI 팀과 인터페이스 잠금 → 통합 사고 회피.
**Cons**: 초기 합의 협상 시간 1~3일.
**Context**: design doc Schema 섹션, Issue #6.
**Depends on / blocked by**: AI 팀 출력 포맷 현황 파악 (office-hours assignment).

---

## TODO 4 — Sharding 전략 문서 (v1.5 트리거)

**What**: finding 수가 2000을 넘을 때 어떻게 client-side rendering이 깨지지 않게 데이터 분할할지 사전 설계.

**Why**: ceiling 닿은 시점에 즉흥 결정하면 큰 리팩터링. 미리 결정해 두면 v1 코드도 분할 친화적으로 작성 가능.

**Approach options**:
- 월별 shard (`findings/2026-04/*.json`, 한 번에 1개월만 fetch)
- 사이트별 shard (`findings/store.example.com/*.json`)
- 프로덕트별 shard
- _aggregations/all.json 형태로 GH Actions가 단일 묶음 생성

**Pros**: 사전 결정 → 깨지는 시점에 panic 회피.
**Cons**: 지금 시간 투자 (당장은 안 깨짐).
**Context**: Issue #5 결정 (2000 ceiling), design doc Open Question.
**Depends on / blocked by**: v1 출시 + 6개월 사용 패턴 데이터.

---

## TODO 5 — 보안팀 결재 + 위험 평가서

**What**: 사내 보안팀에게 정식 위험 평가서 제출, 승인 받기.

**Why**: 취약점 좌표·증거가 GHES private repo에 모이면 자체가 표적. 사내 보안 정책상 표준 절차 있을 것.

**Sub-items**:
- [ ] 데이터 분류: 어느 등급의 민감정보인지 정의
- [ ] 접근제어: GHES collaborator + SSO 외 추가 통제 필요한지
- [ ] 감사: git log = audit log로 충분한지, 별도 감사 시스템 연동 필요한지
- [ ] 사고 대응: repo 노출 시 절차

**Pros**: 데모 후 차단 위험 0.
**Cons**: 일정 lead time 큼 (보안팀 일정).
**Context**: office-hours P5, design doc Open Question #1.
**Depends on / blocked by**: TODO 1.

---

## v2 후속 (참고용, 즉시 작업 아님)

- v2-1: AI 스캐너 자동 업로드 (스크립트가 사람 손 떠나 워크플로 안에서 호출)
- v2-2: 전문성 라우팅 (XSS 전문가에게 XSS만 노출)
- v2-3: AI 학습 데이터 export 자동화
- v2-4: Disagreement 알림 (Slack/Email)
- v2-5: Eval suite (FP rate trend, inter-reviewer agreement)
- v2-6: Mobile 반응형 레이아웃
- v2-7: 멀티 호스트 스캔 (1 리포트 N 사이트) 모델 확장
