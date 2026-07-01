# Rokid TTS should prefer the device service once connected

## Symptom

The HUD could show "正在朗读" while no audible speech played on Rokid glasses. This was most visible after long AI replies where TTS appeared active but the user heard nothing.

## Root Cause

Chunked TTS selected Android `TextToSpeech` before the Rokid TTS service. If Android TTS reported success and fired `onStart` but did not route audible output on the glasses, the watchdog considered playback started and never fell back to Rokid TTS.

## Fix

TTS engine selection now prefers Rokid TTS whenever the Rokid service is connected, with Android TTS retained as fallback. Unit tests lock both the Rokid-first priority and Android fallback behavior.

## Avoidance

For device-specific audio APIs, treat generic Android framework success callbacks as insufficient proof of audible output. Prefer the vendor audio path on the target hardware and make engine priority explicit and unit-tested.
