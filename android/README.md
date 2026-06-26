# Rokid Conductor

An Android **phone** app that turns Rokid Glasses into a heads-up display for
[Conductor](https://conductor-ai.top) AI coding tasks. You log in, pick a
project, pick a task, and carry on the task's AI conversation — the dialogue is
shown **on the glasses screen** while the phone acts as controller.

This is intentionally a *phone* app that talks to the glasses over the
**Rokid CXR-M SDK** (`com.rokid.cxr:client-m`), not a glasses-native app.

## Architecture: WebView shell + glasses bridge

The whole UI (login, projects, tasks, chat, realtime) is the **existing
Conductor web frontend**, loaded in a `WebView` — there is only one frontend
codebase to maintain. Native Kotlin is limited to what a browser cannot do:
the Bluetooth glasses + phone speech recognizer, exposed to the page as a
JavaScript bridge.

```
MainActivity.kt            WebView host; loads the Conductor site, registers the bridge
bridge/GlassesBridge.kt    window.RokidGlassesNative — @JavascriptInterface glasses/STT commands,
                           and __rokidOn* event callbacks back into the page
glasses/GlassesManager.kt  CxrApi wrapper: connect, AI_CHAT scene, push text
speech/SpeechInput.kt      Android SpeechRecognizer push-to-talk
```

The web side opts in via `web/src/features/glasses/native-bridge.ts` +
`useGlassesSession.ts` (wired into `ChatView`). When `window.RokidGlassesNative`
is absent (a normal browser) the adapter is a no-op, so the same web build runs
everywhere. The data flow (auth/projects/tasks/messages/`/ws/app`) is the web
app's; the native REST/WebSocket clients were removed.

## What it does

- **UI / data**: served entirely by the Conductor web app inside the WebView.
- **Glasses**: connects to bonded Rokid Glasses over Bluetooth via `CxrApi`, opens the on-glasses **AI_CHAT** scene, echoes input with `sendAsrContent`, signals thinking with `notifyAiStart`, and pushes each AI reply to the lens with `sendTtsContent` — driven by the web adapter through the bridge.
- **Voice**: push-to-talk mic (phone `SpeechRecognizer`; the glasses are set as the communication audio device so the glasses mic is used). The glasses' AI button (`AiEventListener.onAiKeyDown/Up`) triggers capture; the recognized text is sent through the web chat store.

The loaded site defaults to `https://conductor-ai.top`. For a local server,
override it: `adb shell am start -n com.rokid.conductor/.MainActivity --es
start_url http://10.0.2.2:6152` (emulator) or your LAN URL on a device.

## Build & install

Prereqs: Android SDK (compileSdk 35, build-tools 35), JDK 17. The Rokid SDK is
pulled from `https://maven.rokid.com/repository/maven-public/` (configured in
`settings.gradle.kts`).

```bash
./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.rokid.conductor/.MainActivity
```

`minSdk 28`, ABIs `arm64-v8a` / `armeabi-v7a` (matching the SDK's native libs).

## Pairing the glasses

Pair the Rokid Glasses in the phone's system Bluetooth settings first, then in
the app tap the **眼镜** chip (top bar) → pick the device → connect. The chip
turns green when connected; opening a task then activates the AI_CHAT scene.

## Verified

- Builds, installs, and launches on an Android 16 device.
- Live against production `conductor-ai.top`: login/session, project list, task
  list, task history, realtime WebSocket, task creation, and sending a user
  message (task advances; app awaits the reply).
- Full reply round-trip verified against a local Conductor server + `debug`
  daemon: a user message drove the `claude` backend to a real assistant reply,
  delivered over the same REST/WS protocol the app consumes.

### External prerequisites for the live AI loop

- An **online Conductor daemon** (`conductor daemon`) bound to your account
  must be running for tasks to actually produce AI replies — the app sends the
  message and listens; the agent runs on your machine.
- **Physical Rokid Glasses paired** over Bluetooth are required to see the
  conversation rendered on the lens (the app drives the verified CXR-M AI_CHAT
  display API).

## CXR-M SDK notes (ground truth from `client-m` 1.2.2)

- Connect: `CxrApi.getInstance().initBluetooth(ctx, BluetoothDevice, BluetoothStatusCallback)`.
- Scene: `controlScene(ValueUtil.CxrSceneType.AI_CHAT, true, null)`.
- Show user text: `sendAsrContent(text)`; thinking: `notifyAiStart()`;
  AI reply: `sendTtsContent(text)` + `notifyTtsAudioFinished()`.
- Glasses mic: `setAudioStreamListener(AudioStreamListener)` (PCM) and/or
  `setCommunicationDevice()` to route the glasses mic to the phone recognizer.
- Push-to-talk button events: `setAiEventListener(AiEventListener)`.
