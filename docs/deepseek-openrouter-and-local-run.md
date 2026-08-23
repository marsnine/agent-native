# DeepSeek(OpenRouter) 모델 추가 + 로컬 실행 / 외부 노출 기록

> `marsnine/agent-native` 포크의 로컬 평가(Path C) 기록.
> upstream(`BuilderIO/agent-native`) `main` = `ca4ed2514` (2026-08-22) 기준.

## 목적

차세대 "에이전트 네이티브 · monday형 자율 PM 에이전트" 기반 후보로 `agent-native`를 로컬에서 실행·평가. `templates/crm` 앱을 띄우고, OpenRouter provider에 **DeepSeek V4 모델**을 추가해 목록에서 선택·사용하고 **reasoning effort**까지 조절 가능하게 함.

## 변경 3건

### 1. `templates/crm/vite.config.ts` — Tailscale funnel 접근 허용

- Vite dev의 `server.allowedHosts` 기본값이 비-localhost Host를 차단 → funnel 도메인 접근 시 `403 Blocked request. This host ... is not allowed`.
- 해당 호스트를 `server.allowedHosts`에 추가.
- ⚠️ **머신 특정**: 현재 `hellos-macbook-pro.tail6d8e8c.ts.net` 하드코딩. 다른 기기/테일넷에서 쓰려면 그 기기의 ts.net 호스트로 교체하거나, `.ts.net` 와일드카드 / 환경변수로 일반화할 것. (로컬 개발 편의용 변경)

### 2. `packages/core/src/agent/model-config.ts` — DeepSeek V4 2모델 추가

- OpenRouter `supportedModels` allowlist에 없어 입력해도 저장/선택 불가였음.
- 추가 모델(OpenRouter 실제 카탈로그 기준):
  - `deepseek/deepseek-v4-flash-0731` — ctx 1,310,720 · out 384,000
  - `deepseek/deepseek-v4-pro-0813` — ctx 1,048,576 · out 128,000\* (\*OpenRouter가 max_completion_tokens 미기재 → 보수적 설정)
- 3곳 반영: `aiSdk.openrouter.supportedModels`(선택 목록) + `MODEL_CONTEXT_WINDOWS` + `MODEL_MAX_OUTPUT_TOKENS`.

### 3. `packages/core/src/shared/reasoning-effort.ts` — DeepSeek effort 옵션

- `getReasoningEffortOptionsForModel`이 GPT/Claude/Gemini 계열만 effort 옵션을 주고 deepseek은 `[]` → effort 선택기가 안 뜸.
- `isDeepSeekReasoningModel` 헬퍼 추가 + 분기로 **Low / Medium / High**(Gemini와 동일 세트) 부여.
- **엔진은 무수정**: `agent/engine/ai-sdk-engine.ts`의 `provider === "openrouter"` 분기가 이미 `reasoning: { effort }`를 OpenRouter로 전달 → effort 옵션만 열어주면 **UI 선택 + 실제 추론 전달**이 동시에 동작.

## 핵심 함정 — dev 서버 "재시작 필요"

`Default model` / 새 대화 모델 픽커 / 저장 검증은 **서버의 엔진 카탈로그**(`manage-agent-engine` list → `entry.supportedModels`)를 읽는다. 그 `supportedModels`(및 effort를 계산하는 로직이 물린 엔진 인스턴스)는 **엔진 등록 시점(서버 시작)에 확정**된다 — `ai-sdk-engine.ts`의 `PROVIDER_SUPPORTED_MODELS`, 그리고 리로드 시 로그 `"[agent-engine] Engine 'ai-sdk:openrouter' is already registered. Skipping"`.

→ 따라서 소스 편집 후 **Vite HMR만으로는 반영되지 않고, dev 서버를 재시작**해야 세 곳(provider Model · Default model · 새 대화 픽커)에 모두 반영된다.

## 로컬 실행 & 외부 노출 절차

```bash
# 0) 전제: Node >= 22.22, corepack (pnpm@10.29.1 자동 프로비저닝)

# 1) upstream 최신을 별도 worktree로 (기존 작업 브랜치 무손상)
git -C <agent-native-repo> fetch upstream
git -C <agent-native-repo> worktree add ../agent-native-main upstream/main

# 2) 설치
cd agent-native-main
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm install

# 3) crm .env (Native SQL 모드 — 외부 크레덴셜 불필요)
#    templates/crm/.env:
#      DATABASE_URL=file:./data/app.db
#      BETTER_AUTH_SECRET=<openssl rand -hex 32>
#    ※ .env 는 커밋 금지 (gitignore). BETTER_AUTH_SECRET 은 세션 서명용.

# 4) crm 실행 (기본 포트 8080)
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm --dir templates/crm dev

# 5) Tailscale funnel 로 공개 노출 (App Store 버전은 번들 내 CLI 사용)
/Applications/Tailscale.app/Contents/MacOS/Tailscale funnel --bg 8080
#    → https://<machine>.<tailnet>.ts.net/   (예: hellos-macbook-pro.tail6d8e8c.ts.net)
#    끄기: tailscale funnel --https=443 off
```

- **인증**: Better Auth 기본(방문자가 첫 방문에 계정 생성). 공개 funnel URL이어도 회원가입 게이트가 있어 완전 무인증 개방은 아님.
- **LLM 키**: crm `.env`엔 불필요. provider(OpenRouter 등)는 앱 UI(설정 → AI provider)에서 키 연결.
- **소스 편집 후엔 4) dev 서버 재시작** (위 함정 참조).

## 검증 방법

```bash
# 로컬/공개 응답
curl -sS -o /dev/null -w "%{http_code}\n" http://localhost:8080/
curl -sS -o /dev/null -w "%{http_code}\n" https://<machine>.<tailnet>.ts.net/

# 실행 중 서버가 실제로 편집된 코드를 서빙하는지 (Vite 변환 모듈)
curl -s "http://localhost:8080/@fs/<abs>/packages/core/src/agent/model-config.ts" | grep deepseek
```

## Caveat

- **라이선스 모호**: upstream 루트 `package.json` = `ISC` + 루트 `LICENSE` 파일 없음(README/`packages/core`는 MIT). 상용 의존 전 반드시 해소.
- 이 브랜치는 **upstream/main(`ca4ed2514`) 기준**이라 marsnine `main`보다 앞섬(포크 main은 upstream 대비 뒤처져 있음).
- `vite.config.ts` allowedHosts는 위와 같이 **머신 특정**.
