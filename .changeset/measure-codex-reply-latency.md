---
"@love-moon/ai-sdk": patch
---

Add opt-in Codex reply timing diagnostics to distinguish first-text generation
from buffering before a complete message is forwarded. Traces contain IDs and
monotonic durations, never prompt or reply text.
