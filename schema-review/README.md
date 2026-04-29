# Schema Review — Vulnerability Finding 스키마 (도메인별)

이 디렉토리는 **점검자 검토용** 자료입니다. AI 에이전트가 뱉을 finding JSON의 모양과, 그게 트리아지 보드에서 어떻게 보일지를 도메인별(web / android / device)로 보여줍니다.

## 목적

코드 작성 전에 다음을 점검자들이 함께 결정:
- 어느 필드가 빠져있어야 하는가? (있으면 좋겠는 것)
- 어느 필드가 과한가? (제거 후보)
- 필드 이름이 적절한가? (명명 합의)
- AI 에이전트가 이 정보를 출력할 수 있는가? (실현 가능성)
- 도메인 간 공통 vs 도메인별 분기를 어디서 자르는가?

## 스키마 구조 (polymorphic by domain)

모든 finding은 **공통 골격**을 가지고, `domain` discriminator에 따라 `target.*`와 `evidence.*` 모양이 달라집니다.

### Project 모델 (단일 그룹핑 단위)

이전 `site` (스캔 대상) + `product` (제품 그룹) 2단 구조는 **`project` 단일 필드**로 통합되었습니다. 보드의 4 view (Findings / Reports / Sites / Products) → **3 view (Findings / Reports / Projects)**.

업로드 의미론:
- raw-report JSON에 `project` 필드 명시 (예: `"project": "ecom"`)
- `scripts/upload_report.py`가 입력값을 **`normalizeProject()`로 정규화**한 뒤 finding으로 상속 — `"Ecom"`, `" ECOM "`, `"e-com"` 같은 이형 입력을 같은 slug로 수렴
- 같은 정규화된 `project` slug가 이미 존재하면 → 기존 project에 finding append
- 존재하지 않으면 → 신규 project로 자동 생성 (별도 manifest 등록 불필요, 첫 등장이 곧 생성)
- 한 project는 여러 도메인·여러 스캔 대상(host/package/fleet)을 포함 가능 (예: `ecom`이 `store.example.com` + `checkout.example.com` 둘 다 커버)

### Project 이름 정규화 규칙

`scripts/upload_report.py`의 `normalize_project(name)` (브라우저 SPA `src/util.js`의 `normalizeProject`와 byte-for-byte 동일):

1. NFKC 유니코드 정규화 (전각/반각·합자 통합)
2. lowercase + trim
3. 공백·`_`·`.`·`/`·`:`·`,` 의 연속 → 단일 `-`
4. `[유니코드 letter, 유니코드 digit, -]` 외 문자 제거 (한글/일본어 등 비-ASCII 문자는 보존)
5. 연속 `-` → 단일 `-`
6. 양 끝 `-` 제거

예시:
| input | normalized |
|---|---|
| `"ecom"` | `ecom` |
| `"ECOM"` | `ecom` |
| `"  ecom  "` | `ecom` |
| `"E-commerce Storefront"` | `e-commerce-storefront` |
| `"Mobile App!"` | `mobile-app` |
| `"프로젝트 A"` | `프로젝트-a` |
| `"foo___bar...baz"` | `foo-bar-baz` |


### 공통 필드 (3 도메인 모두)

| field | 의미 |
|---|---|
| `schema_version` | 스키마 버전 (현재 1) |
| `id` | finding 안정 ID, `FND-YYYY-MM-DD-{domain}{seq}` |
| `report_id` | 어느 스캔 리포트에서 왔는지 |
| `domain` | `"web"` \| `"android"` \| `"device"` |
| `category` | 도메인 내 세부 분류 (예: `xss-reflected`, `exposed-component`, `default-credential-telnet`) |
| `severity` | `low` \| `medium` \| `high` \| `critical` |
| `project` | 어느 프로젝트(점검 단위)인지. report 업로드 시 명시. 기존 project가 있으면 finding이 합쳐지고, 없으면 신규 project 생성. (예: `ecom`, `mobile-app`, `iot-camera`) |
| `agent` | 발견 도구 (예: `ai-scanner-v0.3`) |
| `discovered_at` | ISO 8601 |
| `ai_confidence` | 0.00~1.00 |
| `ai_rationale` | AI의 분석 글 |
| `cwe` / `cve` | 표준 분류 (있을 때) |
| `remediation_hint` | 권장 조치 |

### 도메인별로 달라지는 부분

#### web — `target.*`
- `url, method, endpoint, parameter, parameter_location, auth_required, user_role_when_found`

#### web — `evidence.*`
- `request_raw, response_status, response_headers, response_excerpt, payload, injection_point, reproducer_curl, screenshot`

#### android — `target.*`
- `package, version_name, version_code, build_type, min_sdk, target_sdk`
- `component_type, component_class, exported, permission_required`
- `intent_filter.{actions, categories, data_scheme, data_host}`
- `deeplink_example, apk_sha256`

#### android — `evidence.*`
- `manifest_excerpt, code_excerpt, logcat_excerpt, intent_reproducer, screenshot, video`

#### device — `target.*`
- `device_model, vendor, firmware_version, firmware_sha256, hardware_revision, serial_number_pattern`
- `interface_type, ip, mac, port, protocol, service`
- `physical_location, deployment_scope`

#### device — `evidence.*`
- `scan_output, banner, credential_test.{...}, session_excerpt, reproducer_command`
- `firmware_artifact, wireshark_pcap, photo_jtag`

## 파일 매핑

| 도메인 | JSON 예제 | HTML 렌더 | Raw 원본 |
|---|---|---|---|
| web | `web-finding.json` | `web-finding.html` | `raw-reports/RPT-2026-04-29-A.json` |
| android | `android-finding.json` | `android-finding.html` | `raw-reports/RPT-2026-04-29-B.json` |
| device | `device-finding.json` | `device-finding.html` | `raw-reports/RPT-2026-04-29-C.json` |

각 HTML은 해당 JSON을 **트리아지 보드에서 점검자가 보게 될 화면**으로 렌더한 mock입니다.

## Raw report 보관과 "View original report" drawer

스키마에 **AI 스캐너의 raw 원본**을 보관할 자리(`/raw-reports/{report_id}.json`)를 추가했습니다.

### 왜 필요한가
점검자가 finding 하나만 보고 TP/FP 판정이 어려울 때 다음을 알면 정확도가 올라감:
1. 같은 스캔에서 어떤 다른 finding이 나왔는가? (관련 패턴 공유)
2. 사람이 큐레이션 단계에서 무엇을 **버렸는가**, 왜 버렸는가? (이전 운영자 판단 신뢰)
3. AI가 raw로 적은 ai_notes는 어떤 모양이었나? (정규화 후 잃어버린 컨텍스트)

### 데이터 흐름
```
AI scanner raw output (full)
       │
       ▼ 사람 선별 (curation_decision: accepted | rejected | deferred)
       │
       ▼ scripts/upload_report.py
       │
       ├─ findings/FND-*.json  ← accepted only
       └─ raw-reports/RPT-*.json ← 전체 raw (rejected/deferred 포함)
                                   + curation_decision 사유
                                   + human_curation_notes
```

### 점검자가 볼 때
finding 상세 페이지의 상단 "📄 View original report" 버튼 클릭 → 우측에서 drawer 슬라이드인 → report metadata + human curation notes + raw findings 전체 (color-coded by decision) + raw JSON 파일 직접 링크.

### 보안 고려사항
- raw에는 **rejected**된 finding의 실제 evidence도 포함됨 → 같은 repo 접근 권한 가진 사용자만 볼 수 있어야 함 (이미 GHES private repo로 보호)
- raw 파일도 finding과 동일하게 immutable (재업로드 시 새 RPT id로)
- `curation_decision` 필드 자체는 사람이 입력 → schema validate 시 enum 강제 (accepted | rejected | deferred), prefix 매칭으로 분류

## 검토 가이드 (점검자용)

각 도메인에 대해 다음 질문에 의견 부탁드립니다:

1. **이 finding 하나를 보고 TP/FP 판정할 수 있겠나요?** — 정보 충분/부족 여부
2. **본인 평소 점검에서 이 외에 꼭 같이 보는 정보가 있나요?** — 추가 필드 후보
3. **여기 있는 필드 중 안 쓸 것 같은 게 있나요?** — 제거 후보
4. **evidence의 raw 데이터(예: response_excerpt에 진짜 XSS payload)가 보드에 그대로 보여도 안전한가요?** — 렌더 정책 검증
5. **AI 스캐너가 이 모든 필드를 자동으로 채울 수 있을까요?** — 실현 가능성
6. **도메인 분류 자체가 적절한가요?** — web/android/device 외 추가 도메인 (network, cloud, ai-system 등)
7. **`category` enum 값**의 단어가 자연스러운가요? — `xss-reflected` vs `reflected-xss`, `exposed-component-payment-bypass` vs 더 짧은 이름
8. **"View original report" drawer**가 보여주는 정보(report metadata + human curation notes + raw findings 전체)가 트리아지 정확도에 도움이 될까요? 추가로 보고 싶은 것이 있나요? (예: 같은 사이트의 이전 회차 비교, AI 스캐너 버전별 FP 추세 등)
9. **rejected된 finding의 evidence 노출 정책**이 적절한가요? 또는 rejected는 ai_notes만 보이고 raw evidence는 숨겨야 하나요?

피드백 → 코멘트로 회신, 또는 PR에 직접 수정.

## 다음 단계

- 점검자 N명 검토 → 의견 합치
- 합의된 스키마를 `/schemas/{web,android,device}-finding.schema.json`으로 JSON Schema 문법으로 작성
- ajv로 양 끝(브라우저 SPA, upload-report.mjs CLI)에서 검증
- AI 스캐너 팀에 사양 공유
