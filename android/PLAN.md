# Rokid Conductor — Glasses-Native Plan

## Target

Build a Rokid Glasses Android app that is installed directly on the glasses,
not a phone companion app. The app should let the wearer authenticate to
Conductor, choose a project, choose a task, enter the task, and have normal AI
chat using the glasses microphone and touchpad gestures.

## Current Implementation

- Direct Android APK under `android/`, package `com.rokid.conductor`.
- No CXR-M Bluetooth companion dependency.
- `MainActivity` is portrait, full-screen, keep-screen-on, and maps Rokid
  touchpad input:
  - `KEYCODE_ENTER` -> select / voice toggle
  - `KEYCODE_BACK` -> back / exit
  - `KEYCODE_DPAD_DOWN` -> next / newer
  - `KEYCODE_DPAD_UP` -> previous / older
- Login uses the production backend `https://conductor.conductor-ai.top` and
  shows `https://conductor.conductor-ai.top/activate` for browser approval.
- `RokidConductorApp` renders a black 3:4 HUD with focused lists and chat.
- `AppViewModel` handles device auth, project/task focus, task history,
  realtime WebSocket updates, voice input, and AI reply readout.
- Chat has a touchpad-only quick-reply strip (`hi`, `继续`, `总结进展`,
  `下一步`, `语音输入`, `朗读最新`, `停止朗读`) so AI dialogue does not depend
  entirely on STT.
- Speech input uses Android `SpeechRecognizer` with an app-local
  `ConductorRecognitionService`. On tested RG-glasses firmware, the platform
  recognizer does not call that service, so `SpeechInput` falls back after 1.5s
  to direct `AudioRecord` capture and backend STT via `/api/speech/transcribe`.
  The HUD still gets ready/end/error/final callbacks, and tap again explicitly
  stops capture for finalization.
- Speech output uses Android `TextToSpeech`, falls back to Rokid's system
  `com.rokid.os.sprite.tts.TtsService` Binder service when standard TTS is
  unavailable, auto-reads substantive AI replies, supports manual read-latest
  and stop actions, and shuts down with the ViewModel lifecycle.
- `ConductorClient` consumes:
  - `POST /api/auth/device/start`
  - `POST /api/auth/device/poll`
  - `GET /api/auth/me`
  - `GET /api/projects`
  - `GET /api/tasks?project_id=...`
  - `GET/POST /api/tasks/{id}/messages`
  - `POST /api/speech/transcribe`
- `ConductorSocket` consumes `/ws/app?token=...` events:
  `task_user_message`, `task_sdk_message`, and `task_status_update`.

## User Flow

1. Launch app on Rokid Glasses.
2. HUD shows a short device code and activation URL.
3. User approves the code from a signed-in browser.
4. App stores the returned API token and opens the project list.
5. Swipe to a project, tap to enter.
6. Swipe to a task, tap to enter.
7. In chat, swipe to a quick reply and tap to send, or choose `语音输入` for STT.
8. AI replies arrive over realtime WebSocket and are shown in the HUD.

## Verification Needed On Hardware

- Install and launch on physical Rokid Glasses.
- Confirm the touchpad emits the expected Android key codes.
- Confirm speech input on a logged-in device with backend `GLM_API_KEY`
  configured. On the tested RG-glasses unit, the app-local
  `ConductorRecognitionService` is registered, but platform `SpeechRecognizer`
  does not invoke it; the direct `AudioRecord` fallback starts and reports the
  expected pre-login error when no token is present. The production backend also
  needs the web version that includes `/api/speech/transcribe`; otherwise the
  HUD reports that the speech backend is not published.
- TTS has been verified on RG-glasses through the Rokid system fallback:
  `SpeechOutput` binds `com.rokid.os.sprite.tts.TtsService`, `playTtsMsg`
  is accepted, and `onPlayStatus:true/false` produces app speaking callbacks.
- Run a full live chat against a Conductor account with an online daemon.
