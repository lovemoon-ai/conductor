# Voice mode: after more than ~40 s of silence, Send fails with "volc asr final result timed out"

- Severity: P2 (edge case; the text is not lost, it goes back into the input box)
- Layer: websocket (`/ws/speech` → Doubao streaming ASR)
- Found by: release QA round 3, build `25dd30b`, 2026-10-04

## Reproduction
1. Web @25dd30b with `VOLC_SPEECH_API_KEY` set. Open a task, tap **Voice conversation**, then **Talk**.
2. Speak one short sentence (~4 s), then stay silent with the mic open.
3. Tap **Send** after the timer passes ~45 s.

(QA fed the microphone from a WebAudio stream playing a recorded sentence, because this macOS session cannot capture audio. The product's own capture/ASR/TTS path ran unchanged.)

## Observed
| Time before Send | Result |
|---|---|
| 6 s, 12 s, 20 s, 30 s | `result` in ~0.55 s, message sent, reply read aloud |
| 45 s, ~80 s | ~10 s wait, then `error: speech transcription failed — volc asr final result timed out`; UI: "Speech recognition failed — what was heard is in the input box"; nothing sent |

The live transcript (`partial … endpoint:true`) was already final in every run.

## Expected
Send still delivers what was heard (the final partial already has `endpoint: true`). Or keep the ASR session alive across long silence. A user who pauses before tapping Send should not get an error.

## Evidence
`claw/issues/tmp_release-0.17-qa-20261004/tmp_evidence/v2_long_recording.*`, `v2_sent_reply.*`, `v2_sent_reply2.*`.
