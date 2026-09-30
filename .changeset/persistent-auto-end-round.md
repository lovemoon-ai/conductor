---
"@love-moon/conductor-cli": patch
---

`conductor task persistent` takes `--auto-end-round` / `--no-auto-end-round`. Persistent
tasks now end the current round automatically (asking the AI for its summary, like
End round) after an hour without a reply; on by default.
