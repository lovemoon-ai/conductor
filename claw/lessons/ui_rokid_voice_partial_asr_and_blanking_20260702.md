# Rokid Voice Partial ASR And Blanking

Bug type: ui

## Symptom

Rokid voice input required a multi-step confirm flow, did not provide useful
partial recognition while the user was speaking, and blank-screen behavior could
interrupt the expected voice interaction model. Manual blanking also needed to be
restricted to an intentional forward/backward gesture pair within one second.

## Root Cause

The speech WebSocket path only transcribed after capture finished, so partial
text could only appear during final upstream processing. The client state model
also treated every partial as active listening, even after capture had ended and
the UI had moved to recognizing. Display blanking was tied to a simple inactivity
timer and gesture direction tracker without enough separation between continuous
direction gestures and unrelated select/back interactions.

## Fix

The server now emits throttled partial transcript snapshots while PCM is still
arriving, then emits a final event-stream transcription result after finish. ASR
stream parsing treats transcript snapshots as replacements and deltas as appends,
which prevents partial revisions from corrupting the final text. Rokid voice
input now starts with one tap, auto-submits after five seconds of silence, and
manual tap during capture submits immediately. Auto blanking waits twenty seconds
of no relevant activity, pauses during active speech/reply states, and manual
blanking requires an opposite forward/backward direction pair within one second.

## Prevention

When adding partial recognition, test both cumulative transcript snapshots and
delta chunks, including revised partial text. UI state updates should preserve
the current speech phase instead of deriving phase solely from any partial text
event. Gesture recognizers should reset on unrelated interactions so intentional
multi-step gestures cannot be accidentally assembled from normal navigation.
