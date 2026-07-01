# Rokid Voice Interaction Batch ASR Confirmation

## Symptom

Rokid app voice turns felt slow and unreliable: recognition often started with
extra delay, incorrect transcripts were immediately sent into the task, and the
available logs did not show whether latency came from recorder startup, local
VAD, upload, or upstream ASR.

## Root Cause

The app first probed Android `SpeechRecognizer` even on Rokid firmware where
that path is known not to dispatch reliably, then fell back to whole-utterance
`AudioRecord` upload. The direct recorder uploaded audio from the beginning of
capture instead of speech-only audio, used the generic microphone source, and
sent final ASR text directly as a user message without confirmation or local
command routing. The backend accepted a language field from the app but did not
forward it to the ASR provider, and neither side emitted enough latency fields
to diagnose the turn.

## Fix

- Prefer direct recorder-backed STT on Rokid devices and remember platform
  recognizer startup failures.
- Use `VOICE_RECOGNITION`, best-effort audio effects, short pre-roll, speech
  detection gating, and a shorter silence tail before upload.
- Stream speech-only PCM to `/ws/speech` while retaining the same captured PCM
  for `/api/speech/transcribe` REST fallback. The provider call remains final
  batch ASR after the utterance, not partial transcript streaming.
- Forward the device language tag through `/api/speech/transcribe`.
- Require confirmation before sending recognized text, and route common voice
  commands through a local command confirmation path.
- Add privacy-preserving diagnostics for startup, capture, VAD, language,
  upstream ASR status, and timing fields.

## Prevention

Voice-first surfaces should have an explicit confirmation boundary before
mutating task state, local command grammar for high-frequency controls, and
diagnostics that separate device capture time from backend ASR time. When a
client sends provider hints such as language, route tests should prove those
hints reach the upstream call.
