# Issue CLI: wrong `--priority` choices, and invalid args still sent

## Symptom
`conductor issue create/update --priority` offered `P1|P2|P3`; the server
accepts `P0|P1|P2`, so P0 was impossible and P3 failed server-side. An invalid
choice printed a yargs error but the request was still sent.

## Root cause
The choices were hand-copied and drifted from `web/src/lib/issues/config.ts`.
The yargs `.fail()` handler wrote the message and returned, so parsing went on
and the command handler still ran.

## Fix
The choices are now `P0|P1|P2`. `.fail()` throws an ARGS error, so bad args
exit 2 without sending a request.

## How to avoid next time
Keep CLI enums next to a test that pins them to the server's values, and test
that an invalid choice makes no request.
