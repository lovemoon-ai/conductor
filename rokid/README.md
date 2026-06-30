# Rokid Conductor

A glasses-native Android app for Rokid Glasses. Install the APK directly on the
glasses, sign in to Conductor with the device authorization flow, choose a
project, choose a task, and continue the task's AI conversation from the HUD.

This app follows the GlassKit-style direct-on-device model: black HUD
background, high-contrast foreground text, portrait 3:4 layout, and touchpad
navigation. It does not use the phone-side CXR-M Bluetooth companion SDK.

## What It Does

- **Device login**: starts `/api/auth/device/start`, shows the short user code
  and `/activate` URL, polls `/api/auth/device/poll`, and stores the returned
  API token locally.
- **Projects / Tasks**: lists projects (`/api/projects`) and project tasks
  (`/api/tasks?project_id=...`).
- **Conversation**: loads task history (`/api/tasks/{id}/messages`), opens the
  realtime app WebSocket (`/ws/app?token=...`), sends voice-recognized user
  messages (`POST /api/tasks/{id}/messages`), and renders AI replies from
  `task_sdk_message` / `task_user_message` events.
- **Speech input / output**: uses Android `SpeechRecognizer` with an app-local
  `RecognitionService` for hands-free message entry. If Rokid firmware does not
  dispatch to that service, the app falls back to direct `AudioRecord` capture
  and backend STT through `/api/speech/transcribe`. Voice output uses Android
  `TextToSpeech`, with a Rokid TTS Binder fallback when no standard Android TTS
  engine is exposed. AI replies are auto-read when they arrive; the quick-reply
  strip can also read or stop the latest AI reply.
- **Rokid touchpad**: tap selects or toggles voice capture, double-tap goes
  back/exits, swipe forward moves next/newer, swipe backward moves
  previous/older.
- **Quick replies**: in chat, swipe cycles `hi` / `继续` / `总结进展` /
  `下一步` / `语音输入` / `朗读最新` / `停止朗读`; tap sends the selected reply,
  starts voice input, reads the latest AI reply, or stops speech output.

## Architecture

```text
MainActivity.kt             Full-screen glasses Activity; maps touchpad keys.
AppViewModel.kt             Device auth, project/task focus, chat, voice turns.
ui/RokidConductorApp.kt     3:4 HUD Compose UI for login/lists/chat.
net/ConductorClient.kt      OkHttp REST client.
net/ConductorSocket.kt      OkHttp WebSocket client.
speech/SpeechInput.kt       SpeechRecognizer plus direct-recorder fallback.
speech/ConductorRecognitionService.kt
                           App-local RecognitionService for voice chat.
speech/ConductorSpeechTranscriber.kt
                           AudioRecord to backend STT helper.
speech/SpeechOutput.kt      Android TextToSpeech plus Rokid TTS fallback.
```

## Build And Install

Prereqs: Android SDK (compileSdk 35, build-tools 35), JDK 17, and `adb`.

```bash
cd android
./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.rokid.conductor/.MainActivity
```

The production backend is `https://conductor.conductor-ai.top`; the login HUD
shows `https://conductor.conductor-ai.top/activate` with a short device code.

## Speech Smoke Test

The debug build exposes ADB-only speech smoke tests. Start the app first so the
Rokid firmware allows the debug receiver to run.

Voice output:

```bash
adb shell am start -W -n com.rokid.conductor/.MainActivity
adb shell "am broadcast -n com.rokid.conductor/.debug.SpeechDebugReceiver -a com.rokid.conductor.DEBUG_SPEAK --es text 'Conductor_speech_output_test'"
adb logcat -d -t 3000 | rg -i 'ConductorSpeechDebug|TtsService -> binder playTtsMsg|TtsService -> onPlayStatus'
```

Voice input:

```bash
adb shell am start -W -n com.rokid.conductor/.MainActivity
adb shell "am broadcast -n com.rokid.conductor/.debug.SpeechDebugReceiver -a com.rokid.conductor.DEBUG_RECOGNIZE --el duration_ms 2500"
adb logcat -d -t 8000 | rg -i 'ConductorSpeechDebug|ConductorSpeechInput|ConductorRecognitionService'
```

On RG-glasses firmware tested here, Android does not expose a standard TTS
service, and platform `SpeechRecognizer` does not call back into the app-local
recognition service. The app therefore times out the platform recognizer after
1.5 seconds and starts direct recorder-backed STT instead:

```bash
adb shell cmd package query-services -a android.speech.RecognitionService
adb shell cmd package query-services -a android.intent.action.TTS_SERVICE
```

TTS still works through the Rokid Binder fallback. STT requires the user to be
logged in and the backend to have `GLM_API_KEY` configured. The model can be
overridden with `GLM_ASR_MODEL`; otherwise the server uses `glm-asr-2512`. If
the HUD reports that the speech backend is not published, deploy the web app
version that includes `/api/speech/transcribe`.

## Controls

| Intent | Rokid Glasses touchpad | Android key |
| --- | --- | --- |
| Select / send selected chat reply | Tap | `KEYCODE_ENTER` |
| Back / exit root screen | Double tap | `KEYCODE_BACK` |
| Next / newer message | Swipe forward | `KEYCODE_DPAD_DOWN` |
| Previous / older message | Swipe backward | `KEYCODE_DPAD_UP` |

Phone/emulator touch fallback is also available for quick checks: tap,
double-tap, swipe right, and swipe left map to the same actions. Directional
navigation is debounced so a single Rokid swipe that emits both touch and DPAD
events only moves one item.

## Runtime Notes

- The glasses need network access to the Conductor backend.
- Task replies still require an online Conductor daemon bound to the signed-in
  account; the glasses app sends the user turn and listens for app-gateway
  events.
- Voice input first tries Android `SpeechRecognizer` with the app-local
  `ConductorRecognitionService`. On firmware that does not dispatch the service
  callback, `SpeechInput` falls back to direct `AudioRecord` capture and uploads
  WAV audio to `/api/speech/transcribe`.
- Voice output first uses Android `TextToSpeech`. On Rokid firmware without a
  standard `android.intent.action.TTS_SERVICE`, it binds the system
  `com.rokid.os.sprite.tts.TtsService` Binder fallback. If both engines are
  unavailable, the HUD marks readout unavailable and text chat remains usable.
