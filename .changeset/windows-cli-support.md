---
"@love-moon/conductor-cli": patch
"@love-moon/conductor-sdk": patch
---

Support Windows CLI runtime paths by using Windows PTY shell arguments and package-manager command shims when repairing native dependencies.

Support Windows git-backed projects by resolving `git.exe` from config, environment variables, Git for Windows, Scoop, Chocolatey, and Visual Studio bundled Git paths, then reusing that command for project validation and worktree operations.

Add Windows installation and daemon launcher scripts for local CLI installs, plus a public Windows installer script served from the web app.
