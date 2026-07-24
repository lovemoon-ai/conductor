---
"@love-moon/conductor-cli": patch
"@love-moon/conductor-sdk": patch
---

Report a terminal task status when a stop request finds no active process, so a
task whose Fire already died converges instead of sitting in `killing` forever.

Drop queued terminal status events before an in-place restart reuses a working
directory. The durable upstream outbox lives inside that directory, so an
undelivered `KILLED` from the previous run was flushed on startup and killed the
task that had just finished resuming.
