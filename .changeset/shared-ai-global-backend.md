---
"@love-moon/conductor-cli": patch
---

Allow a shared daemon to run the AI side of a Global AI Backend task while code
stays on one of the user's own daemons. Advertise
`shared_ai_global_backend_v1` and forward the task id on remote exec, file, and
MCP requests so the backend can authorize only that task's remote binding.


Keep remote grants tied to active tasks: shared credentials cannot mint remote
bindings, renew them through restarts or persistent rounds, or reactivate ended
tasks through status updates. Check shared AI compatibility when restarting or
starting later rounds of an existing remote task too.
