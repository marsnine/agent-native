# Computer Use (desktop control) — root-cause fixes & follow-up record

작성일: 2026-07-29. Agent Native 데스크탑앱이 **자기 에이전트로 macOS 데스크탑을 직접 제어**(계산기 열어 7×8=56을 AX로 읽기)하도록 만드는 과정에서 발견한 버그 2건 + 그 수정 기록. 아래 **1) 커밋 · 2) 정식 재빌드 · 3) 업스트림 기여**는 아직 실행하지 않은 계획이며 이 문서로 기록만 해둔다. **4) 키 입력 로버스트니스**는 별도 진행.

## 0. 최종 결과 (달성)

에이전트(Opus 4.8, 네이티브 헬퍼 MCP `agent-native-desktop-computer` 18 tools) 최종 답변:
> "Done. I opened Calculator, entered 7 × 8, and read the display back via the accessibility API. … result: **56**"

계산기 실제 화면 `7×8 = 56`. `computer_observe`(AX 스냅샷)가 디스플레이를 정상 판독.

## 1. 근본 원인 (진단 3단계 반전)

| 가설 | 검증 방법 | 결과 |
|---|---|---|
| 헬퍼 바이너리가 TCC 미신뢰 | 에러에 `AXIsProcessTrusted()` 실측값 삽입 | ❌ **`axProcessTrusted=true`** — 신뢰 문제 아님 |
| Claude Code CU 세션 동시 점유 간섭 | 조사자 CU 놓고 무간섭 실행 후 디스크 트랜스크립트 판독 | ❌ 무간섭에서도 동일 실패 — 간섭 아님 |
| **AX 조회 API 결함** | system-wide `kAXFocusedApplicationAttribute` → `NSWorkspace.frontmostApplication` + `AXUIElementCreateApplication(pid)` 로 교체 | ✅ **관측 성공** |

진짜 버그: **TCC-신뢰된 프로세스에서도 `AXUIElementCreateSystemWide()` + `kAXFocusedApplicationAttribute` 가 nil**(앱이 최전면인데도)을 반환하는 macOS 함정. frontmost PID 로 앱 AX 요소를 직접 만들면 우회됨.

**부차 발견 (프로바이더 게이트 버그):** Finder 실행 + 인앱 Settings 키 저장 조합에서 coding chat 이 영원히 "Set ANTHROPIC_API_KEY…" 토스트. 원인 = `applyCodeAgentProviderCredentialsToEnv()` 가 이름과 달리 `process.env` 를 실제로 세팅하지 않고 `appliedKeys` push 만 함 + 게이트가 apply 후 재검사 없이 무조건 실패 낙하. **최신 업스트림(BuilderIO f3e9ee976, #2494)에도 동일하게 존재** (우리 포크 도입 아님). 관련 이슈/PR 미발견.

## 2. 소스 수정 (포크 워킹트리에 이미 반영, 미커밋)

### 2-1. 프로바이더 게이트 — `packages/desktop-app/src/main/app-store.ts`
```diff
   for (const key of CODE_AGENT_PROVIDER_KEYS) {
-    if (credentials[key]) {
+    const value = credentials[key];
+    if (value) {
+      // Actually inject the decrypted secret into the running process env so the
+      // provider gate (which reads process.env) sees a Settings-saved key.
+      process.env[key] = value;
       appliedKeys.push(key);
     } else if (hasStoredProviderSecretBlob(store.credentials[key])) {
```

### 2-2. 프로바이더 게이트 재검사 — `packages/desktop-app/src/main/index.ts` (`ensureCodeAgentLlmProvider`)
```diff
   if (hasRuntimeCodeAgentLlmProvider()) return { ok: true };
-
-  if (hasRuntimeCodeAgentLlmProvider()) return { ok: true };   // 중복 라인 제거
   const applyResult = AppStore.applyCodeAgentProviderCredentialsToEnv();
   if (applyResult.failedKeys.length > 0) { … }
+  // Saved provider keys were just applied to process.env; re-check so a key
+  // connected via Settings is honored immediately, without a relaunch.
+  if (hasRuntimeCodeAgentLlmProvider()) return { ok: true };
   return { ok: false, error: "Set ANTHROPIC_API_KEY, …" };
```

### 2-3. AX focusedContext (결정타) — `packages/desktop-app/native/macos/AgentNativeComputerHelper.swift`
```diff
   private func focusedContext() throws -> (…) {
+    // Prefer NSWorkspace frontmost app; build its AX element from the PID.
+    // system-wide kAXFocusedApplicationAttribute can return nil even for a
+    // TCC-trusted process while an app is genuinely frontmost.
+    if let running = NSWorkspace.shared.frontmostApplication,
+       let bundleId = running.bundleIdentifier {
+        let application = AXUIElementCreateApplication(running.processIdentifier)
+        return (application, bundleId, running.localizedName, originForApplication(application))
+    }
+    // Fallback: system-wide focused application.
     let system = AXUIElementCreateSystemWide()
     guard let application = copyElement(system, kAXFocusedApplicationAttribute as CFString) else {
-        throw HelperFailure(description: "No focused application is available.")
+        let trusted = AXIsProcessTrusted()
+        throw HelperFailure(description: "No focused application is available. (axProcessTrusted=\(trusted))")
     }
```
추가로 진단용 `diagnose` 커맨드(= `AXIsProcessTrusted` + frontmost + focused-nil 여부 리턴). 정식 커밋 시 유지/제거 판단 필요(진단 가치 있음).

### 2-4. 테스트
- `app-store.privacy.test.ts` — apply 가 실제로 `process.env` 세팅하는지 런타임 검증(신규 case, safeStorage mock).
- `privacy-regressions.test.ts` — 게이트가 apply 후 `hasRuntimeCodeAgentLlmProvider()` 재검사하는지 소스레벨 핀(신규 case).
- 결과: 두 신규 case 통과, 타입체크 클린(tsc exit 0). (기존 실패 1건 `detects credential-gap transcript events` 는 본 변경과 무관 — stash 후에도 동일 실패로 확인.)

## 3. 미실행 계획 (기록만)

### 1) 포크 커밋 계획
- 대상 파일: 위 2-1~2-4 의 5개 (`app-store.ts`, `index.ts`, `AgentNativeComputerHelper.swift`, `app-store.privacy.test.ts`, `privacy-regressions.test.ts`).
- 진단용 `diagnose` 커맨드 + 에러 trust 마커: 커밋 포함 여부 결정 필요.
- 워킹트리에 무관한 선변경(`templates/clips/desktop/src-tauri/` 아이콘류)은 커밋에서 제외.
- 커밋 분리 제안: (a) provider-gate fix + tests, (b) AX focusedContext fix (+ diagnose).

### 2) 정식 재빌드 절차
현재 실행 앱은 **손수 패치한 헬퍼 + 재서명 + 더미 env 우회** 상태. 클린화:
```bash
cd packages/desktop-app
pnpm build:native:mac      # 헬퍼 유니버설 빌드
pnpm build                 # electron-vite + code-agent-runner 번들
# 배포 패키징(서명 포함)은 프로젝트 build:mac 파이프라인 사용
launchctl unsetenv ANTHROPIC_API_KEY   # 게이트 소스픽스 반영 후 더미 env 제거
```
재빌드 후에는 Settings 에 저장한 Anthropic 키가 네이티브로 게이트를 통과하므로 더미 env 불필요.

### 3) 업스트림 기여 초안 (BuilderIO/agent-native, 미게시 — 승인 후)

**Issue A — Provider gate never honors Settings-saved keys (Finder launch)**
> `applyCodeAgentProviderCredentialsToEnv()` builds `appliedKeys` but never assigns `process.env[key]`, and `ensureCodeAgentLlmProvider()` returns failure without re-checking after apply (plus a duplicated `hasRuntimeCodeAgentLlmProvider()` line). Result: an app launched from Finder (no inherited env) with a provider key saved in Settings is permanently blocked from starting a coding chat with the generic "Set ANTHROPIC_API_KEY…" toast. Codex-login and terminal-launch paths mask it. Repro: launch the packaged .app via Finder, save an Anthropic key in Settings, start an Agent chat.

**Issue B — computer_observe fails ("No focused application") even when Accessibility is granted**
> The native helper's `focusedContext()` uses `AXUIElementCreateSystemWide()` + `kAXFocusedApplicationAttribute`, which returns nil for a TCC-trusted helper process even when an app is frontmost (confirmed `AXIsProcessTrusted()==true`, `NSWorkspace.frontmostApplication==<the app>`). Fix: derive the app element from `NSWorkspace.frontmostApplication.processIdentifier` via `AXUIElementCreateApplication(pid)`; keep system-wide as fallback.

PR: 위 2-1~2-3 패치 + 테스트를 그대로 제출.

## 4. 남은 항목 — 키 입력(mutate) 로버스트니스 (진행 중)

관측(AX 읽기)은 픽스로 안정화됐으나, 조사자 CU 점유 상태의 실행에서 **키 입력이 일부만 등록**("display shows 7")되어 에이전트가 AppleScript 폴백으로 56 완성. 가설: CU 동시 점유가 헬퍼 CGEvent 주입과 충돌. **무간섭(조사자 CU 미점유) 실행으로 재확인** 예정 — 결과는 본 문서 갱신.
