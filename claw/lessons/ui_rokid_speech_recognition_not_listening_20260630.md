# Rokid Speech Recognition Not Listening

## Symptom

Voice input on the glasses appeared to start, but recognition often did not
produce useful status or a final transcript.

## Root Cause

The app relied on platform speech recognition first, but Rokid firmware did not
dispatch to the app-local recognition service reliably. The direct recorder path
also reported ready before `AudioRecord` was actually recording, and its fixed
speech-start RMS threshold was higher than real glasses microphone levels seen
during device testing.

## Fix

Added direct `AudioRecord` capture with backend GLM ASR upload, delayed the
ready callback until the recorder enters recording state, and replaced the fixed
speech-start threshold with an adaptive noise-based threshold.

## Prevention

Do not use emulator or phone speech callbacks as the acceptance signal for
glasses STT. Record `maxRms`, recorder state, and backend transcript results
from real device tests before changing the input state machine.
