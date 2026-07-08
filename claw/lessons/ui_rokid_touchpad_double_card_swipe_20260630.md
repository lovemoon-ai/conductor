# Rokid Touchpad Double Card Swipe

## Symptom

On Rokid Glasses, one touchpad swipe could advance focus by two cards, making
project, task, and quick-reply navigation feel unstable.

## Root Cause

The gesture path accepted every directional input immediately. On the glasses
touchpad, one physical swipe can surface as more than one navigation event close
together, so the UI state advanced more than the wearer intended.

## Fix

Centralized directional navigation through `dispatchHudAction()` and added a
short debounce window for `NEXT` and `PREVIOUS` actions.

## Prevention

Treat glasses touchpad input as a noisy hardware signal. Keep navigation actions
behind a single dispatcher and require hardware tests for swipe cadence changes.
