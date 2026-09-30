# Issue: `conductor issue start` could not pick a daemon

## Symptom
In a merged cross-daemon project group (and the default project), the web start
dialog lets the user pick the daemon. The CLI always ran the task on the issue's
current project daemon.

## Root cause
The CLI had no option for what the dialog sends: the chosen sibling project's
`projectId` plus `metadata.daemonHost`. The SDK's `updateIssue` also dropped
`projectId`.

## Fix
`issue start --daemon <host> [--project <id>]` sends the same request as the
dialog. With only `--daemon`, the CLI picks the same-named project on that
daemon. The SDK forwards `projectId`, and the server still checks that the
target is a sibling.

## How to avoid next time
When a web dialog adds a choice, add the CLI flag and SDK field in the same
change (see `cli/api-parity.json`).
