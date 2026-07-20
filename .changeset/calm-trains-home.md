---
"@love-moon/conductor-cli": patch
"@love-moon/conductor-sdk": minor
"@love-moon/ai-sdk": minor
---

Add `CONDUCTOR_HOME` support for relocating user-level configuration, logs,
Fire locks, sessions, update metadata, and AI manager caches while leaving
project-scoped `.conductor` directories and Fire task markers in place.

Migrate device authorization to `conductor.conductor-ai.top` while preserving
compatibility with the legacy official endpoint and self-hosted backends.
