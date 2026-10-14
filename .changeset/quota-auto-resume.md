---
"@love-moon/conductor-cli": patch
"@love-moon/ai-sdk": patch
---

When a task's model quota runs out ("You've hit your session limit · resets
1:20am"), fire no longer stops there. It reads the reset time, schedules a
one-off Conductor scheduled message to continue a minute or few after the
reset, and posts a single notice. Messages that arrive while waiting are queued
and handed to the resume turn together instead of each failing with another
"处理失败". The resume shows up in the task's scheduled-message list, where it
can be canceled. This also covers a quota hit while Claude works on its own
between user turns: ai-sdk now reports such a background turn that ends in an
error result (or a process exit after it) as a failed turn.
