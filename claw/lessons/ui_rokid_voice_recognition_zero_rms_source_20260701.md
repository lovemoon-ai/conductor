# Rokid Voice Recognition Zero RMS Source

## Symptom

Rokid voice input repeatedly showed "没有检测到语音" even when the user spoke
normally. Recognition never reached backend ASR because local VAD did not see
speech.

## Root Cause

Device logcat showed direct recorder startup succeeded with
`source=VOICE_RECOGNITION`, but every failed turn ended with `maxRms=0`. On the
tested RG glasses firmware, `MediaRecorder.AudioSource.VOICE_RECOGNITION`
returns silent PCM for this app path. The VAD logic was therefore acting on
valid reads that contained no signal.

## Fix

- Prefer `MediaRecorder.AudioSource.MIC` for direct recorder STT on Rokid.
- Keep `VOICE_RECOGNITION` and `DEFAULT` as fallback sources when `MIC` cannot
  initialize.
- Slightly relax VAD thresholds for natural glasses-mic speech while retaining
  speech-only upload.

## Prevention

On embedded Android devices, do not assume a semantically better audio source is
usable until hardware logs prove non-zero PCM. Speech diagnostics should always
include recorder source and max RMS so source-level silence can be separated
from ASR failure or VAD threshold issues.
