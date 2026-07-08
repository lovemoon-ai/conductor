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
- **Speech input / output**: prefers direct `AudioRecord` capture on Rokid
  hardware, and remembers platform `SpeechRecognizer` startup failures so later
  turns skip the slow fallback probe. Direct capture prefers the generic mic
  source on Rokid firmware because the tested `VOICE_RECOGNITION` source can
  return silent PCM; processed sources remain fallback options. It uses
  best-effort audio effects, local VAD, and backend STT through
  `/ws/speech` streaming PCM upload with `/api/speech/transcribe` REST fallback.
  The WebSocket path sends throttled partial transcript snapshots while PCM is
  still arriving, then sends one final transcript after the utterance is
  captured. Recognized text is auto-sent after 5 seconds of silence, or
  immediately when the user taps during capture. Common phrases such
  as `继续`, `总结进展`, `下一步`, `朗读最新`,
  and `停止朗读` are routed through local command handling. Voice output uses
  Android `TextToSpeech`, with a Rokid TTS Binder fallback when no standard
  Android TTS engine is exposed. AI replies are auto-read when they arrive; the
  quick-reply strip can also read or stop the latest AI reply.
- **Rokid touchpad**: tap selects or starts voice capture, tap during capture
  sends immediately, double-tap goes back/exits, swipe forward moves next/newer,
  swipe backward moves previous/older, and an opposite forward/backward swipe
  pair within one second blanks the display without stopping speech input or
  output.
- **Quick replies**: in chat, swipe cycles `hi` / `继续` / `总结进展` /
  `下一步` / `语音输入` / `朗读最新` / `停止朗读`; tap sends the selected reply,
  starts voice input, reads the latest AI reply, or stops speech output.

## Architecture

```text
MainActivity.kt             Full-screen glasses Activity; maps touchpad keys.
AppViewModel.kt             Device auth, project/task focus, chat, voice turns.
ui/RokidConductorApp.kt     3:4 HUD Compose UI for login/lists/chat.
net/ConductorClient.kt      OkHttp REST client plus speech WebSocket stream.
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
needed, backend partial snapshot cadence can be tuned with
`SPEECH_PARTIAL_TRANSCRIBE_INTERVAL_MS` and
`SPEECH_PARTIAL_TRANSCRIBE_MAX_REQUESTS`. If
the HUD reports that the speech backend is not published, deploy the web app
version that includes `/ws/speech` and `/api/speech/transcribe`.

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
- Voice input prefers direct `AudioRecord` capture on Rokid hardware. On other
  Android devices it can still try `SpeechRecognizer`, but remembers startup
  fallback and then records with `MIC` first, because `VOICE_RECOGNITION` can be
  silent on the tested RG glasses firmware. Speech-only PCM uploads to
  `/ws/speech`; if the stream cannot be opened or completed, the same captured
  PCM is wrapped as WAV and sent to `/api/speech/transcribe`. The backend
  forwards the device language tag to the ASR provider when present.
  Final recognition results are sent automatically. Local command matches still
  route through the corresponding app action instead of blindly sending arbitrary
  dictated text.
- Speech diagnostics are emitted through logcat (`ConductorSpeechInput` /
  `ConductorSpeechTranscriber`) and web server logs. They include direct/fallback
  startup latency, recorder source, noise suppression availability, captured
  bytes, speech duration, stream availability, language, transcript character
  count, and upstream ASR latency, without logging the transcript or audio
  payload.
- Voice output first uses Android `TextToSpeech`. On Rokid firmware without a
  standard `android.intent.action.TTS_SERVICE`, it binds the system
  `com.rokid.os.sprite.tts.TtsService` Binder fallback. If both engines are
  unavailable, the HUD marks readout unavailable and text chat remains usable.
