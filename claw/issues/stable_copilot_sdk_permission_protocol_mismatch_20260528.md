# Copilot SDK Permission Protocol Mismatch

## Incident

- Task: `975f32a9-6404-4380-946d-0b6e11353aff`
- Observed at: `2026-05-28 00:19` Asia/Shanghai
- Backend: `copilot`
- Diagnosis source: `live`

The task returned a message asking the user to approve filesystem tool
permissions instead of inspecting and serving `/Users/duino/ws/arxiv-radar`.

## Evidence

- `conductor diagnose` reported a connected fire execution host and an acked
  user message. This excludes routing and websocket delivery as the cause.
- The task log showed the `copilot-sdk` session started successfully with
  session ID `c2ec204d-5a6f-4a3f-b59b-e461e56f877a`.
- The Copilot event log recorded repeated `permission.completed` events with
  `{ "kind": "approved" }`, immediately followed by failed `view`, `glob`,
  and `bash` tool executions with `unexpected user permission response`.
- The target directory is writable by the local daemon user; this was not an
  operating-system filesystem denial.

## Root Cause

The installed Conductor package used `@github/copilot-sdk@0.2.2`, whose
`approveAll()` returns `{ kind: "approved" }`. Its permissive transitive
dependency range resolved the Copilot CLI subprocess to `1.0.54`, whose
permission protocol expects the newer decision shape. GitHub's
`@github/copilot-sdk@0.3.0` changes `approveAll()` to
`{ kind: "approve-once" }` and targets Copilot CLI `1.0.36+`.

Conductor was configured for maximum Copilot SDK tool approval, but sent a
decision value the newer CLI no longer accepted.

## Resolution

- Upgrade the Copilot SDK dependency in the AI SDK and CLI packages from
  `^0.2.2` to `^0.3.0`.
- Add a contract regression test requiring the installed SDK approval result
  to be `{ kind: "approve-once" }`.
- Keep Conductor's fallback approval handler on the same decision shape and
  update Copilot client token forwarding to the SDK 0.3 `gitHubToken` option.
