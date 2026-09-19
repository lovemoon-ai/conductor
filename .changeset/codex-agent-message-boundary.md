---
"@love-moon/ai-sdk": patch
---

Show Codex progress notes as soon as Codex finishes writing them. The session
did not recognize the app-server's `agentMessage` items, so a commentary message
was held back until the next message started or the turn ended, often minutes
later during long tool runs.
