# 인수인계: 사무실 브라우저 비서

다음 Claude Code 세션이 이 문서만 읽고 바로 이어서 작업할 수 있게 정리했습니다. 설치·사용법은 `README.md`에 있고, 이 문서는 배경과 현재 상태, 다음 할 일을 다룹니다.

## 1. 배경: 왜 만들었나

- **출발점:** 사용자가 유튜브 영상(https://youtu.be/BiIpELQp8Xc)을 보고, 그 내용만으로 "피클 같은 에이전트"를 만들 수 있는지 물었습니다. 피클은 한국 앱스토어 무료 2위까지 오른 AI 에이전트 서비스입니다.
- **영상 내용:** 피클 같은 에이전트에서 꼭 정해야 하는 결정 다섯 가지와, 그걸 맞춰도 터지는 함정 다섯 가지를 이름만 소개합니다. 구체적인 숫자와 구현은 유료 설계도와 인프런 강의로 넘겼어요.
  - **결정 다섯:** ① 고객마다 셀 ② 비밀은 에이전트 밖 금고에 ③ 게시는 AI가 아니라 코드가 ④ 기억은 사장님 말로만 ⑤ 잠과 비용 상한
  - **함정 다섯:** 문자 순서가 뒤집힘, 같은 문자가 두 번 옴, 일이 조용히 멈춤, 에이전트가 끝나지 않음, 실패한 문자가 무시됨
- **사용자가 고른 방향:**
  - 클라우드(Cloudflare Durable Objects) 대신 **Tailscale 기반**으로, **사무실 맥미니에서 직접** 돌립니다.
  - 쓰는 사람은 **사용자 본인(사장님, owner)과 직원 2명**, 총 3명입니다.
  - 할 일은 **"브라우저로 할 수 있는 모든 것"**입니다. 맥미니에 실제 Chrome 창을 띄우고, 사람이 하듯 클릭하고 입력합니다.
  - 대화 창구는 **자체 웹 채팅**이고, tailnet 안에서만 열립니다.
- **사용자 소통:** 한국어로 대화합니다. 비개발자에 가까우니 쉬운 말로 설명해 주세요. 영어 자판으로 한글을 칠 때가 있어요(예: `dusrufgksemt` = "연결한듯").

## 2. 현재 상태

- **브랜치:** 최신 작업은 `claude/trusting-pascal-ubve0u`에 있습니다(두 번째 세션). 처음 브랜치 `claude/fable-5-2-pickle-creation-s7bna2`의 커밋을 그대로 포함하고, 그 위에 iframe·shadow DOM 지원과 파일 올리기·내려받기를 얹었어요. PR은 아직 없습니다. 사용자가 원하면 만들면 됩니다.
- **위치:** 저장소 루트는 Swift 프로젝트(qjc-system-status)이고, 에이전트는 그와 별개로 `browser-agent/` 폴더에 있습니다.
- **런타임:** Node 22.18 이상에서 TypeScript를 빌드 없이 바로 실행합니다(type stripping). 그래서 import에는 `.ts` 확장자를 붙이고, enum 같은 문법은 쓰지 않습니다.
- **의존성:** `@anthropic-ai/sdk`, `playwright@1.63.0`, `zod`. DB는 Node 내장 `node:sqlite`를 써서 네이티브 빌드가 필요 없습니다.
- **검증 결과:**
  - `npm run typecheck`가 통과합니다.
  - `npm test`는 17개 모두 통과합니다. 끝-끝 테스트는 가짜 Claude API(SSE를 흉내 내는 서버), 테스트용 게시판, 실제 headless Chromium으로 돌립니다. `test/browser.test.ts`는 AI 없이 브라우저 기능(프레임, shadow DOM, 올리기, 내려받기)만 확인해요.
  - 두 번째 세션에서 `agent.ts`의 요청 파라미터(`fallbacks: "default"`, `thinking.display: "updates"`, `context_management`, top-level `cache_control`, beta 헤더 세 개)를 API 참고 문서와 대조했고, 문서와 어긋나는 곳은 찾지 못했습니다. 그래도 실제 호출로 확인한 것은 아니에요.
  - **진짜 Claude API로는 한 번도 돌려 보지 않았습니다.** 세션에 API 키가 없었어요. 맥미니에서 처음 돌릴 때 요청 파라미터에서 400 오류가 날 수 있습니다(5장 참고).
  - 채팅 화면은 폰 크기(390px)로 띄워서 확인했습니다. 비밀번호 가림과 오류 알림이 제대로 표시됩니다.

## 3. 파일 구성

| 파일 | 역할 |
|---|---|
| `src/server.ts` | HTTP 서버를 `127.0.0.1`에서만 엽니다. `Tailscale-User-Login` 헤더로 사용자를 알아보고(localhost에서 온 요청만 믿음), CSRF를 막습니다(JSON + `x-agent-client: 1` 헤더 + 같은 출처만). 사람별 대기열은 순번으로 정렬하고 1.2초 모아서 한 작업으로 묶습니다. SSE 이벤트, 승인 API, 스크린샷 API, 멈춤 API도 여기 있어요 |
| `src/agent.ts` | Messages API를 직접 도는 루프입니다(beta 네임스페이스, 스트리밍 + `finalMessage`). 도구 정의는 zod 스키마에서 JSON Schema로 만들고, `eager_input_streaming`을 켜 둡니다. 승인 관문, 비용 상한 3단계, 최대 단계 수, 반복 감지, 시간 제한, 오류 알림도 담당해요 |
| `src/browser.ts` | 사람별로 Playwright persistent context를 띄웁니다. 스냅샷은 요소마다 `data-agent-ref`를 붙이고 페이지 글은 6000자까지만 읽어요. 위험 분류(`classifyClick`, `classifyEnter`)를 하고, POST 페이지 이동은 route에서 막습니다(`withSubmit`으로 허용한 동작을 실행하는 동안만 통과). 확인창은 기본으로 취소하고, `fillLogin`은 페이지 주소가 저장된 주소와 같을 때만 입력합니다 |
| `src/approvals.ts` | 승인 요청에 번호와 만료 시간(15분)을 붙입니다. owner만 승인할 수 있고, 여러 개가 열려 있으면 번호가 필요해요. 채팅 명령은 `승인 3`, `거절 3` 같은 정해진 형태만 받습니다 |
| `src/memory.ts` | 웹을 읽은 작업(tainted)에서는 기억을 쓸 수 없게 막습니다. 근거 메시지 id를 검증하고, 공용 기억은 owner만 바꿀 수 있어요. 개수 상한은 40개입니다 |
| `src/files.ts` | 파일 보관함입니다. 채팅 첨부(`POST /api/files`)와 브라우저가 내려받은 파일을 `data/files/<사람>/<id>/<이름>`에 두고 `files` 테이블에 기록해요. `uploadNeedsApproval`이 "이번 요청에 첨부한 파일인가"를 판단합니다 |
| `src/vault.ts`, `src/vault-cli.ts` | 사이트 로그인 정보를 AES-256-GCM으로 암호화해 보관합니다. 마스터 키는 `~/.browser-agent/master.key`에 있어요. AI에게는 id, 이름, 주소만 보여 줍니다 |
| `src/redact.ts` | 채팅 메시지를 저장하기 전에 카드번호(Luhn 검사), 주민번호, 비밀번호 패턴을 가립니다 |
| `src/db.ts` | SQLite 테이블(`messages`, `tasks`, `approvals`, `memories`, `usage`)을 만듭니다. 서버가 재시작되면 중단된 작업을 표시합니다 |
| `src/config.ts` | `.env`, `users.json`, 한도 값, 모델 가격표를 읽습니다 |
| `public/index.html` | 채팅 화면입니다(단일 파일). 승인 카드, 진행 메모, 화면 보기, 멈춤 버튼이 있고 다크 모드를 지원해요 |
| `test/unit.test.ts`, `test/browser.test.ts`, `test/e2e.test.ts` | 단위 테스트, 브라우저 기능 테스트, 끝-끝 테스트 |
| `deploy/com.office.browser-agent.plist` | 맥미니 launchd 자동 시작 템플릿 |

## 4. 설계 결정과 이유

- **Messages API 직접 루프:** Managed Agents가 아닌 Messages API를 직접 돌리는 이유는, 브라우저가 반드시 맥미니에서 돌아야 하고 tailnet 안에서만 동작해야 하기 때문입니다. 승인 대기, 비용 상한, 반복 감지 같은 흐름 제어도 직접 해야 했어요.
- **브라우저 도구:** Anthropic이 정의한 `browser_toolset_20260801`도 있지만, 문서를 확인하지 못해서 직접 만든 Playwright 도구를 썼습니다. 직접 만든 도구라서 위험 동작을 코드로 막기도 쉬워요.
- **모델 설정:**
  - 기본값은 `claude-opus-5-5`, effort는 `high`이고 `.env`에서 바꿀 수 있습니다. `claude-fable-5-2`는 가격이 2배예요.
  - 지원하는 모델에서는 세 가지를 켭니다.
    - `fallbacks: "default"`: 거절되면 다른 모델로 다시 시도합니다. beta 헤더는 `server-side-fallback-2026-07-01`.
    - `thinking.display: "updates"`: 도구 호출 사이의 진행 메모를 받아 화면에 보여 줍니다. beta 헤더는 `thinking-display-updates-2026-08-18`.
    - 서버 쪽 `clear_tool_uses_20250919` context editing: 오래된 스냅샷을 서버에서 지웁니다. beta 헤더는 `context-management-2025-06-27`.
  - 대화 기록은 덧붙이기만 합니다(append-only). preserved thinking의 기록 수정 검사를 통과하려면 이전 기록을 고치면 안 돼서요.
- **작업마다 새 대화:** 작업마다 새 대화를 시작합니다. 첫 사람 메시지에 기억과 최근 대화 14개를 넣고, 시스템 프롬프트와 도구 목록은 고정해서 프롬프트 캐시가 잘 맞게 했습니다.
- **사람 메시지 id:** 사람 메시지는 `[메시지 id: ...]` 형태로 넣습니다. `remember`의 근거 id로 쓰고, 남이 쓴 글과 사람의 요청을 구분하는 표시도 됩니다.
- **셀은 생략:** 3명 규모라 셀(결정 ①)은 뺐습니다. 대신 사람마다 브라우저 프로필, 대화, 개인 기억을 나눴어요.
- **비용 상한:** 작업 $3, 사람별 하루 $15, 전체 하루 $30입니다. 제가 임의로 정한 값이니 사용자와 조정이 필요할 수 있어요.
- **이번 세션에서 잡은 버그:** 승인 뒤 8초 동안 양식 제출이 열려 있어서, 그 사이 다른 버튼이 몰래 POST를 보내면 통과됐습니다. `withSubmit`으로 "그 동작 하나를 실행하는 동안에만" 허용하도록 고쳤고, 회귀 테스트(e2e 5번)도 넣었어요.

- **스냅샷과 프레임(두 번째 세션):** 스냅샷은 메인 문서와 화면에 보이는 안쪽 프레임(최대 10개, 50×30px 이상)을 차례로 읽고, 열린 shadow DOM 안까지 들어갑니다. ref 번호는 세션이 매기고(`스냅샷번호-요소번호`), 어느 프레임의 요소인지는 `BrowserSession.refFrames`에 적어 둡니다. 그래서 지난 스냅샷의 ref는 쓸 수 없어요.
- **파일 올리기 승인 규칙(두 번째 세션):** `browser_upload`는 올리는 파일이 전부 이 작업을 시킨 메시지에 첨부된 것일 때만 승인 없이 실행합니다. 예전 첨부나 내려받은 파일은 밖으로 내보내는 일이라 승인을 받아요. 파일 선택 창을 여는 버튼이 다른 위험한 버튼(POST 제출 등)이면 그것도 승인 대상입니다(`classifyUploadTarget`).
- **파일은 내용으로 넘김:** Playwright에 경로를 넘기면 시스템 언어 설정이 없는 환경(이 클라우드 컨테이너, 아마 launchd도)에서 한글 이름 파일이 오류 없이 빠졌습니다. 그래서 합계 40MB까지는 파일 내용을 직접 넘겨요(`uploadPayload`).

## 5. 다음 할 일 (우선순위 순)

1. **맥미니에서 진짜 API로 첫 실행.** `README.md`의 설치 순서대로 하고, 첫 요청이 400이면 오류 메시지를 보고 빼야 할 파라미터를 찾습니다. 의심 후보는 `agent.ts`의 `client.beta.messages.stream(...)` 안에 있는 `fallbacks`, `thinking.display: "updates"`, `context_management`, top-level `cache_control`입니다. 그다음 `usage.cache_read_input_tokens`가 0보다 큰지 보고 캐시가 맞는지 확인합니다.
2. **실제 사이트로 시험.** 네이버, 쿠팡 윙, 스마트스토어 같은 사이트에서 위험 분류가 너무 자주 걸리는지, 반대로 빠지는 곳은 없는지 봅니다. 기준은 `browser.ts`의 `RISKY_WORDS`와 `classifyEnter`이고, 오탐과 미탐을 보면서 조정하면 됩니다.
3. **먼저 말 거는 기능(영상 9장).** 아직 넣지 않았습니다. 영상의 방향은 "매시간 깨어나서, 제안할 거리는 코드가 고르고, AI는 문장만 쓴다"입니다. 하루 횟수, 밤 시간대, 사장님이 거절했을 때 얼마나 참을지를 규칙으로 정해야 해요.
4. **파일 기능을 실제 사이트에서 확인.** 올리기·내려받기는 테스트 페이지에서만 확인했습니다. 스마트스토어 상품 사진 등록처럼 끌어다 놓기(drag and drop)만 받는 화면이 있으면 따로 손봐야 해요. 비서가 파일 내용을 읽는 기능(엑셀 주문 목록 요약 등)도 아직 없습니다.
5. **(선택) 승인 알림.** 사장님 폰으로 푸시가 가게 하면 좋습니다. 지금은 채팅 화면을 열어 둬야 승인 카드가 보여요.

## 6. 알려진 한계

- **위험 판단의 범위:** 위험 판단은 버튼 글자, POST 양식, Enter 위치로 합니다. 페이지 안에서 보내는 fetch/XHR 요청은 막지 못해요.
- **주소 이동으로 새는 정보:** 남이 쓴 글에 숨은 지시문 때문에 AI가 GET 주소를 열어서, 페이지에서 본 정보를 밖으로 보낼 가능성은 남아 있습니다. 비밀번호와 카드번호는 AI 대화에 들어가지 않으니 새지 않아요.
- **비밀번호 가림의 한계:** 정규식이라 놓치거나 지나치게 가릴 수 있습니다. 예를 들어 "pw 바꿔줘"는 "바꿔줘"까지 가려요.
- **파일 보관함:** 자동으로 지우지 않습니다. 내려받기는 한 개 200MB에서 끊지만 개수 제한은 없어요.
- **확인하지 못한 동작:** Tailscale 접근 규칙(ACL)에서 맥미니에 태그를 붙였을 때 `Tailscale-User-Login` 헤더가 제대로 오는지는 확인하지 못했습니다. 그래서 README에서도 태그 예시를 뺐어요.

## 7. 개발 명령

```bash
cd browser-agent
npm install
npm run typecheck
npm test                  # 1~2분. 이 클라우드 환경에서는 Chromium이 /opt/pw-browsers에 이미 설치돼 있음
# 화면 확인용 로컬 실행 (API 없이):
DEV_LOGIN=boss@x.com USERS_FILE=... DATA_DIR=... HEADLESS=1 ANTHROPIC_API_KEY=x npm start
```
`DEV_LOGIN`은 헤더 없이 개발할 때만 쓰는 우회 변수입니다. 맥미니 `.env`에는 넣지 마세요.
