---
"@love-moon/conductor-cli": patch
---

Refuse `--force` daemon restart when it would take over an unrelated daemon instance.

Previously `conductor daemon --force` blindly replaced any existing lock, which could kill a daemon belonging to a different conductor home, backend URL, or agent token. The lock now stores an identity fingerprint (home directory, backend URL, agent token prefix, and daemon name) and `--force` only overwrites when the fingerprint matches. A mismatch reports the running daemon's identity and exits with code 7.

This makes `--force` safe for "restart my own stuck daemon" while preventing accidental cross-instance takeovers.
