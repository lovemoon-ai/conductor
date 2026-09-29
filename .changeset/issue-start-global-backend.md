---
"@love-moon/conductor-cli": minor
"@love-moon/conductor-sdk": minor
---

`conductor issue start` can pick the AI for the task it spawns: `--backend <b>`,
or `--global-backend <backend>@<host>` to run the AI on one of your global AI
backends while the code stays on the project's daemon (same as the web "Move
Issue To Doing" dialog). The SDK's `updateIssue` forwards `globalBackend`.

Requires a Conductor web server that ships issue global backends (the same
release): deploy the web server before publishing the CLI/SDK. An older server
ignores `--global-backend` and starts a plain task on the project's daemon; the
CLI then prints a warning instead of failing silently.
