---
"@love-moon/conductor-cli": patch
---

Fix new tasks never answering when their first message starts with "-" (a
markdown list, `--model ...`, `-i ...`). The daemon passed the message to Fire
as `--prefill <message>`, and Fire's argument parser read the leading dash as a
new flag and dropped the message. It is now passed as `--prefill=<message>`.
