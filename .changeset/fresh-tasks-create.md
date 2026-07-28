---
"@love-moon/conductor-cli": minor
"@love-moon/conductor-sdk": minor
---

Add `conductor task create` for creating app tasks with title, prompt, backend,
project resolution, and optional parent task-card grouping. App tasks now
require an online compatible daemon, and grouping results are exposed to
callers so partial success is visible without retrying task creation.
