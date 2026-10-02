---
"@love-moon/conductor-cli": patch
---

`conductor update` and the daemon updater compile node-pty against the headers
the running Node ships, instead of downloading them from nodejs.org, so an
update no longer needs that host to be reachable. `conductor update` also stops
an npm install that has not finished after 15 minutes instead of waiting on a
stalled registry connection forever.
