# Rokid Voice Confirmation Duplicate Select

## Symptom

After voice recognition produced a candidate, the HUD asked the user to confirm.
The next physical tap briefly confirmed the candidate, but immediately returned
to "开始说话" / voice input instead of staying in chat.

## Root Cause

On Rokid hardware, one physical tap can surface as both a touch gesture and an
ENTER / DPAD_CENTER style key event. The first SELECT consumed the voice
candidate and reset `focusedQuickReplyIndex` to `0`; the second SELECT arrived
within the same physical tap and selected quick reply index `0`, which is
`语音输入`, starting a new recognition turn.

## Fix

- Route touch tap and key select through the same HUD action dispatcher.
- Add SELECT debounce so duplicate touch/key events within the same physical
  tap are ignored.

## Prevention

For glasses touchpads, debounce SELECT as well as directional navigation. Voice
confirmation flows are especially sensitive because confirming a candidate
mutates the action list before duplicate input events finish arriving.
