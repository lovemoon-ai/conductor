---
"@love-moon/conductor-cli": patch
---

Fix Update daemon deleting the running install when the upgrade failed. Any
failed `npm install -g` (a timeout on a slow registry, a node-gyp error) used to
trigger an uninstall plus `rm -rf` of the global package before one retry. When
the retry also failed, the daemon kept running with its files gone and every new
task died at Fire launch with `MODULE_NOT_FOUND`. The clear-and-retry now only
runs on `ENOTEMPTY`, and it moves the old install aside and restores it if the
retry fails.
