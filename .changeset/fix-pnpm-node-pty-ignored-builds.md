---
"@love-moon/conductor-cli": patch
---

Fix pnpm-installed daemon PTY support by allowing the `node-pty` build script during pnpm CLI updates and by failing native dependency repair with a clear error when pnpm has already recorded `node-pty` under ignored builds.
