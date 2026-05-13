---
"@love-moon/conductor-cli": patch
"@love-moon/ai-sdk": patch
"@love-moon/ai-manager": patch
---

Prefer the bundled Copilot platform executable before the JS entrypoint so Node
20 installs do not fail with `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite`.
