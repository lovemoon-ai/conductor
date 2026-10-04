# /ws/speech drops `start` sent before token auth finishes

## Symptom
A speech client that sends `{"type":"start"}` right after the socket opens
(the web voice mode does) never gets `ready`; its `finish` is answered with
`speech stream not started`. Seen while building the web voice conversation
mode against a production build (real DB-backed token lookup).

## Root cause
`setupSpeechGateway` registered `socket.on("message")` only after
`await authenticateToken(token)`. `ws` emits frames as they arrive; with no
listener attached yet, every frame received during the auth lookup is lost.
Unit tests with an instantly-resolving auth mock never hit the window.

## Fix
Attach a holding listener synchronously on `connection`, buffer
`(data, isBinary)` pairs, and replay them through the real handler once it is
attached (`web/src/lib/speech/gateway.ts`). Regression test
`gateway-volc.test.ts` uses an auth mock that takes 50 ms.

## Avoid next time
Any `WebSocketServer` connection handler that awaits before attaching
`message` listeners must buffer early frames (or the protocol must make the
client wait for a server hello). Auth mocks in gateway tests should be slow,
not instant, so the race is exercised.
