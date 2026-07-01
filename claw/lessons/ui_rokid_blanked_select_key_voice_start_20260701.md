# Rokid black-screen select key must preserve chat select semantics

## Symptom

When the Rokid display was blanked, a touchpad tap woke the screen and could start voice input, but select-style key events only woke the screen. On devices or firmware paths that emit `ENTER`, `DPAD_CENTER`, `SPACE`, or `BUTTON_A` instead of touch motion events, the user needed a second click to start speaking.

## Root Cause

The black-screen touch path restored brightness and then forwarded the completed tap into the chat select flow. The black-screen key path restored brightness and returned early for all key events, so select keys never reached the equivalent chat action.

## Fix

The black-screen key handler now recognizes select keys after wake and calls the same blanked chat select entry point used by touch. Non-select keys still only wake the display and are swallowed.

## Avoidance

When adding display-blank interactions, keep touch and key input paths behaviorally equivalent for the same HUD action. Test both `MotionEvent` and key-event input sources on glasses because firmware may route touchpad clicks through either path.
