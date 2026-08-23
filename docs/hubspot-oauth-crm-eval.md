# HubSpot workspace-OAuth → CRM 미러: 5겹 갭 eval + 픽스

> `marsnine/agent-native` 포크의 Path C eval 기록 (브랜치 `feat/deepseek-openrouter-effort`).
> upstream `main` = `ca4ed2514` 기준. 로컬 실행/노출 절차는 [deepseek-openrouter-and-local-run.md](deepseek-openrouter-and-local-run.md) 참조.

## 목표

`templates/crm`에서 **HubSpot을 workspace Connection으로 OAuth 연결** → CRM 그리드로 레코드 **미러**("Set up CRM → Configure and sync"). agent-native의 핵심 셀링포인트(HubSpot 미러 CRM)를 Clara 대안 후보로 실증.

## 결론 (한 줄)

이 경로는 **5겹으로 미완성**이었다. **4겹은 소스 수정으로 통과해 "연결"까진 성공**했으나, **5번째(CRM 어댑터가 OAuth 연결을 지원하지 않음)에서 미러가 막힌다.** → "그대로 채택"보다 "레퍼런스 참조 + 필요한 부분 직접 보완"이 타당하다는, OSS 비교 결론과 정합하는 강한 성숙도 신호.

## 5겹 갭 지도

### 1. MCP managed client issuer-binding — ✅ 수정
- `McpOAuthClientProvider.clientInformation()`이 issuer 매칭을 요구 → env managed client(`HUBSPOT_MCP_CLIENT_ID/SECRET`, issuer 없음)를 버림 → SDK가 **동적 클라이언트 등록** 시도 → HubSpot MCP는 `registration_endpoint` 없음 → `Incompatible auth server: does not support dynamic client registration` throw.
- **수정**: issuer 없는(사전 구성) managed client는 서버가 광고하는 issuer에 그대로 사용. `packages/core/src/mcp-client/oauth-client.ts` `clientInformation()`.

### 2. workspace OAuth PKCE 누락 — ✅ 수정
- `buildWorkspaceProviderAuthorizationUrl`이 `code_challenge`를 **figma/sentry에만** 부여(hubspot 누락). token 교환에도 `code_verifier` 없음. HubSpot 앱은 PKCE 필수 → `code challenge parameter is missing`.
- **수정**: hubspot을 PKCE 분기에 추가(authorize `code_challenge`) + hubspot token 교환에 `code_verifier`. `packages/core/src/server/workspace-provider-oauth.ts` (`buildWorkspaceProviderAuthorizationUrl`, `exchangeWorkspaceProviderOAuthCode`).

### 3. 쿠키-스테이징 유실 (진짜 원인) — ✅ 수정
- `/start`가 `setCookie(event, …)`로 flow 쿠키를 **event에 스테이징**만 하는데, 이어서 `Response.redirect(url, 302)`(새 `Response`)를 반환 → 스테이징된 Set-Cookie가 **유실** → 쿠키가 브라우저에 도달조차 안 함 → 콜백에서 `OAuth state is invalid or expired`(=쿠키 없음). (MCP 흐름은 `redirectWithStagedCookies`로 이 문제를 회피 → MCP는 됐던 것.)
- **진단 근거**: `/start` 로그엔 쿠키 set(len 887, host ts.net)인데, 콜백 도착 쿠키 = `[an_ft, an_session_mail, an_aid, an_session_crm]` — flow 쿠키만 없음.
- **수정**: 스테이징된 Set-Cookie를 리다이렉트 Response에 명시적으로 실어 보냄. + flow 쿠키 **SameSite=None(+Secure)** (크로스사이트 복귀 생존, 세션 쿠키와 동일 전략). `workspace-provider-oauth.ts` `handleWorkspaceProviderOAuthStart`.

### 4. OAuth state secret ephemeral (dev 워크어라운드, 코드 수정 아님)
- `getStateSigningKey()`는 `OAUTH_STATE_SECRET || BETTER_AUTH_SECRET || A2A유도`가 process.env에 없으면 **부팅마다 랜덤키**로 폴백. 그런데 **app `.env`는 process.env로 로드되지 않음**(resolveSecret은 별도 store 경로로 읽어 OAuth client id/secret은 됐음) → dev에서 state 서명키가 불안정.
- **워크어라운드**: dev 서버를 안정 `OAUTH_STATE_SECRET` **env**로 기동. 배포에서는 env로 주입 전제라 코드 버그는 아님. (쿠키가 도달하기 시작한 뒤에야 드러나는 2차 요인)

### 5. OAuth 연결이 CRM 어댑터에 미연결 — ❌ 미수정 (핵심 갭)
- 연결·grant는 정상 생성: `oauth_tokens`(provider hubspot, account `46375210::…`), `workspace_connections`/`workspace_connection_grants`(config `{"credentialMode":"oauth"}`, `credential_refs_json = []`).
- 그러나 `createHubSpotCrmAdapter`(`templates/crm/server/crm/hubspot-adapter.ts`)는 credential을 `HUBSPOT_ACCESS_TOKEN`/`HUBSPOT_PRIVATE_APP_TOKEN` 키를 **`credential_refs` 기반으로만** 해석(`packages/core/src/workspace-connections/credentials.ts`의 `credentialRefsForConnection`은 OAuth용 ref를 **합성하지 않음**). → OAuth 연결은 매칭 ref 0 → `no scoped credential was resolved for the granted connection` → `configure-crm-connection` 500.
- 즉 **CRM 어댑터는 token-key 기반 연결(Private App Token)만 소비하고, OAuth 연결의 access token(oauth_tokens)을 사용하지 못한다.** provider-api엔 HubSpot OAuth refresh 로직이 있으나 어댑터는 자체 credential 경로라 그걸 안 탄다.
- **제대로 고치려면**: 어댑터가 OAuth 연결일 때 `oauth_tokens`에서 access token을 읽고 **만료 시 refresh**(HUBSPOT_CLIENT_ID/SECRET)까지 하는 경로 추가 = 실기능 구현. 이번 eval 범위에서 미수행.

## 검증된 최종 상태

- ✅ HubSpot **workspace-OAuth 연결 성공** (4겹 픽스 후): oauth_tokens에 토큰, CRM 앱(`creative-context`)에 grant.
- ❌ **"Configure and sync" 500**: 어댑터가 OAuth 연결 credential 미해석(5번째 갭).

## 이 브랜치에 커밋된 실제 픽스

| 픽스 | 파일 |
|---|---|
| issuer-binding(동적등록 폴백 방지) | `packages/core/src/mcp-client/oauth-client.ts` |
| PKCE (authorize `code_challenge` + token `code_verifier`) | `packages/core/src/server/workspace-provider-oauth.ts` |
| 쿠키-스테이징 리다이렉트 전달 + SameSite=None | `packages/core/src/server/workspace-provider-oauth.ts` |

(deepseek 모델·reasoning effort·vite allowedHosts는 이 브랜치의 앞선 커밋 — 별도 문서 참조.)

## 로컬 실행 노트

- crm dev는 안정 **`OAUTH_STATE_SECRET`** env 필요(갭 4):
  ```bash
  OAUTH_STATE_SECRET="$(openssl rand -hex 32)" \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm --dir templates/crm dev
  ```
- **Private App Token** 경로는 어댑터(`HUBSPOT_PRIVATE_APP_TOKEN` credential_ref)와 바로 맞물리므로, OAuth 미연결(갭 5)을 우회해 미러를 보고 싶으면 그 경로가 최단.
- HubSpot 앱 redirect(workspace OAuth): `<origin>/_agent-native/connections/oauth/hubspot/callback`, scopes `oauth` + `crm.objects.{contacts,companies,deals,tickets}.read` + `crm.schemas.*`.
