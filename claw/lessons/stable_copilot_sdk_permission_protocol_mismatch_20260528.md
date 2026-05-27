# Copilot SDK Permission Protocol Compatibility

## Symptom

A Copilot-backed task reported that tool permissions required user approval,
although Conductor automatically approves Copilot SDK tool requests.

## Root Cause

`@github/copilot-sdk@0.2.2` returned `{ kind: "approved" }` from
`approveAll()`, while the installed Copilot CLI `1.0.54` rejected that older
permission decision as `unexpected user permission response`. The SDK allowed
a newer Copilot CLI to be installed through its transitive dependency range.

## Fix

Upgrade to `@github/copilot-sdk@^0.3.0`, whose permission decision contract
uses `{ kind: "approve-once" }`, and assert this contract in the Copilot
session test. Match Conductor's fallback approval response and SDK client
option names (`gitHubToken`) to the upgraded SDK contract as well.

## Avoid Next Time

When an SDK controls a separately versioned bundled runtime over RPC, test one
runtime-facing contract value rather than relying only on a fake client.
Review transitive semver ranges when publishing provider integrations.
