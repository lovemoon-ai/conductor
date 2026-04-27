# Remote AI Provider Local Tool Boundary

## Symptom

The `codex-remote` and `claude-remote` AI SDK providers created in `4567f02` made the whole AI session run inside the remote `conductor serve-ai` process. Users expected a remote AI session to still read local files and run local scripts from the machine that started the task.

## Root Cause

The implementation only proxied AI SDK session calls over HTTP to the remote `serve-ai` host. Tool execution, file reads, shell commands, and working directory resolution all happened on the remote host because `serve-ai` created the backend session with its own `cwd`. The client-side `remoteCwd` option was explicitly ignored, and there was no reverse RPC or local daemon bridge for local tool execution.

## Fix

Revert the remote AI provider implementation until the execution boundary is designed explicitly.

## Avoid Next Time

Do not add a remote runtime mode without documenting which machine owns model execution, workspace filesystem access, shell execution, and permission prompts. If the intended behavior is "remote model with local tools", add a dedicated local tool bridge through the daemon/fire transport instead of moving the entire AI SDK session to the remote host.
