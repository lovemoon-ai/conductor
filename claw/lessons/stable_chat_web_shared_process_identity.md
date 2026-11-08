# Shared chat runtimes must not inherit the first fire task's identity

## Symptom

The detached runtime outlived its starting fire process while retaining
CONDUCTOR_AGENT_TOKEN, CONDUCTOR_TASK_ID and other task-scoped variables.

## Root cause

Both shared-daemon spawn and browser-worker fork copied the complete parent
environment.

## Fix

Filter CONDUCTOR_* variables at both process boundaries, including differently
cased keys. Preserve normal browser, account-directory and network/proxy
configuration required by the host's browser runtime.

## Validation and prevention

Start a real detached daemon and an IPC worker with fake task credentials.
A child-process probe verifies neither inherits task identity, while configured
browser and proxy values remain available. The worker is closed without
opening a browser or contacting a provider.
