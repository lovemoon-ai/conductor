# Rokid Conductor — Android phone client

A **phone** app (not a glasses-native app) that uses the **Rokid CXR-M SDK**
(`com.rokid.cxr:client-m`) to drive the Rokid Glasses display, and the
**Conductor** backend REST+WebSocket API, so the user can log in, pick a
project, pick a task, and carry on the task's AI conversation **on the glasses
screen**.

## Verified facts (ground truth)

### CXR-M SDK — `com.rokid.cxr:client-m:1.2.2`
- Maven: `https://maven.rokid.com/repository/maven-public/`  (latest release 1.2.2)
- minSdk 28. Native libs for arm64-v8a / armeabi-v7a. Pulls okhttp/retrofit/gson.
- Entry: `CxrApi.getInstance()`.
- Connect: `initBluetooth(Context, BluetoothDevice, BluetoothStatusCallback)`;
  callbacks `onConnectionInfo(uuid,mac,account,type) / onConnected / onInActiveConnected /
  onDisconnected / onFailed(CxrBluetoothErrorCode)`. `isBluetoothConnected()`, `deinitBluetooth()`.
- **AI_CHAT scene** (the conversation primitive):
  `controlScene(ValueUtil.CxrSceneType.AI_CHAT, true, null)` to open.
  - `setAiEventListener(AiEventListener)` → `onAiKeyDown / onAiKeyUp / onAiExit` (push-to-talk button on glasses).
  - `setAudioStreamListener(AudioStreamListener)` → `onStartAudioStream / onAudioStream(id,pcm,off,len) / onAudioStreamFinish` (glasses-mic PCM to phone).
  - `sendAsrContent(text)` show recognized user text on glasses.
  - `notifyAiStart()`, `sendTtsContent(text)` show AI reply, `notifyTtsAudioFinished()`, `notifyAiError()`.
  - `setCommunicationDevice()` routes glasses mic as phone comm audio device.
- Display config: `configWordTipsText(textSize,lineSpace,mode,x,y,w,h)` (WORD_TIPS scene).

### Conductor backend (REST + raw WS `ws` pkg)
- Base: dev `http://localhost:6152`, prod `https://conductor-ai.top`. WS `/ws/app?token=<bearer>`.
- Auth: phone/email OTP. `POST /api/auth/request-code {phone,countryCode}` →
  `POST /api/auth/login {identifier:"+86...",code}` or `/api/auth/register {phone,countryCode,code}`
  → `{token, user}`. Bearer JWT (7d). `GET /api/auth/me` validates.
- Projects: `GET /api/projects` → `[{id,name,is_default,...}]` (Bearer).
- Tasks: `GET /api/tasks?project_id=<id>` → `[task]`; `GET /api/tasks/{id}`;
  `POST /api/tasks {project_id,title,task_type:"ai_task",initial_content}`. status ∈ init/running/completed/killed.
- Messages: `GET /api/tasks/{id}/messages` → `[{id,role,content,createdAt}]`;
  `POST /api/tasks/{id}/messages {content,role:"user",clientRequestId}` (drives the AI; needs daemon online).
- Realtime WS `/ws/app?token=`: events `task_user_message`, `task_sdk_message`
  (payload = full message + task_id/project_id), `task_status_update {task_id,status}`.

## Architecture (app)
- `net/ConductorClient` — OkHttp REST + `ConductorSocket` (OkHttp WebSocket). org.json parsing.
- `glasses/GlassesManager` — wraps CxrApi: connect bonded device, open AI_CHAT, push user/AI text.
- `speech/SpeechInput` — Android SpeechRecognizer (phone mic; glasses routed via comm device).
- `ui/` Compose: Login → Projects → Tasks → Chat. Single `AppViewModel` (StateFlow), screen enum nav.
- Token+baseUrl persisted in SharedPreferences.

## Conversation flow on glasses
1. Pick task → `controlScene(AI_CHAT,true)`; load history via REST; open `/ws/app`.
2. User turn: text box or mic (phone STT, optionally glasses AI key) → `sendAsrContent` (echo on glasses)
   → `notifyAiStart()` → `POST /messages {role:"user"}`.
3. AI reply arrives over WS (`task_sdk_message`) → `sendTtsContent(reply)` on glasses + render on phone;
   `task_status_update=completed` ends the turn.

## Toolchain
AGP 8.7.3 / Gradle 8.11.1 / Kotlin 2.0.21 / compileSdk 35 / minSdk 28 / targetSdk 34 / JDK 17 / Compose.

## Done
Local build → install on the connected Android device → launch → login → pick project → pick task →
converse with AI shown on the glasses screen.

---

## Progress (2026-06-26)

### Status: implemented, built, installed, end-to-end protocol verified. App is COMPLETE.

### Code (all written, builds clean)
- `settings.gradle.kts` / `build.gradle.kts` / `gradle/libs.versions.toml` / `app/build.gradle.kts` —
  Gradle scaffold; Rokid maven repo + `com.rokid.cxr:client-m:1.2.2` wired in. Gradle wrapper 8.11.1.
- `app/src/main/AndroidManifest.xml` — INTERNET, RECORD_AUDIO, BLUETOOTH_CONNECT/SCAN, cleartext on.
- `net/ConductorClient.kt` — OkHttp REST: request-code, login/register, me, projects, tasks (list/create),
  messages (list/send). org.json parsing.
- `net/ConductorSocket.kt` — OkHttp WebSocket to `/ws/app?token=`, parses `task_user_message` /
  `task_sdk_message` / `task_status_update`, auto-reconnect.
- `glasses/GlassesManager.kt` — CxrApi wrapper: bonded-device scan, initBluetooth, AI_CHAT scene,
  sendAsrContent / notifyAiStart / sendTtsContent, AiEventListener push-to-talk, AudioStreamListener stub.
- `speech/SpeechInput.kt` — phone SpeechRecognizer push-to-talk.
- `AppViewModel.kt` — StateFlow orchestration; screen nav LOGIN→PROJECTS→TASKS→CHAT; session persist.
  NOTE: agent replies arrive with role `sdk` (not `assistant`); `isAiReply()` treats sdk/assistant as AI
  and filters "session started/ready" noise from the glasses.
- `ui/RokidConductorApp.kt` — Compose UI for all four screens + glasses-connect dialog + create-task dialog.
- `README.md` — full usage/build/verification doc.

### Toolchain reality (this machine)
- adb + Android SDK present; device `EP0110MZ0BB300900W` = P0110/pacific, **Android 16**, connected over USB.
- compileSdk 35, build-tools 35.0.0, JDK 17. APK builds to `app/build/outputs/apk/debug/app-debug.apk` (~58 MB).
- USB install is slow/flaky (multi-minute; sometimes hangs) — use a long timeout.

### Verified (with on-device screenshots + live API tests)
- Builds, installs, launches on the device; no crash. Login screen renders.
- LIVE against production `conductor-ai.top` (app auto-restored a real session):
  real project list, real task list w/ status, a task's chat history, **realtime WS connected**,
  **task creation**, **sending a user message** (user bubble + "AI 正在思考…", task advancing).
- FULL AI reply round-trip via the exact REST+WS protocol the app uses, against a LOCAL server +
  `debug` daemon + `claude` backend: user msg → real agent replies `pong` and `pong-2`, delivered as
  `task_sdk_message role=sdk` over `/ws/app`. This is precisely what the app renders + pushes to glasses.
- Cleaned up the production test task I created (DELETE → 204).

### Conductor backend (consumed by the app) — see also memory `conductor-backend-api`
- Dev OTP `AUTH_DEV_CODE=000000` only works in dev mode; a production `pnpm start` rejects it.
  For local testing, the daemon's `agent_token` (in `~/.conductor/config-dev.yaml`) also works as a user Bearer.
- Task→daemon routing key: `agent_host` == daemon_name (e.g. "debug"). To trigger a reply, POST
  `/api/tasks {project_id, task_type:"ai_task", agent_host:"debug", backend_type:"claude", initial_content}`.

### Blocked / needs the user (physical, not code)
1. Phone is PIN-locked and auto-locked mid-test; adb can't enter the PIN. App is pre-seeded with local
   server URL + valid token, so on unlock the app shows projects and the `rokid-glasses-reply-test`
   task with the `pong`/`pong-2` exchange. (To repoint/seed: push an xml to /data/local/tmp then
   `run-as com.rokid.conductor cp ... shared_prefs/rokid_conductor.xml`.)
2. No physical Rokid Glasses paired to this phone → on-lens rendering itself not demonstrable here.
   Pair in system Bluetooth, then tap the 眼镜 chip → pick device → connect.

### Pending cosmetic-only repolish (non-blocking)
- Source already updated: role `sdk`→ label "AI", and filter agent "session started" noise from the lens.
  The reinstall of this v2 kept hanging on the flaky USB/locked device. Rebuild + install once unlocked:
  `./gradlew :app:assembleDebug && adb install -r app/build/outputs/apk/debug/app-debug.apk`.
  Running v1 on the device is fully functional and already verified.

### Background processes left running (for the on-unlock demo) — stop when done
- Local Conductor server `pnpm start` (web/, port 6152) + `debug` daemon (`./bin/conductor-dev daemon
  --config-file ~/.conductor/config-dev.yaml`). `adb reverse tcp:6152 tcp:6152` is set.
- Stop with: `kill <server-pid> <daemon-pid>` and `adb reverse --remove-all`.
