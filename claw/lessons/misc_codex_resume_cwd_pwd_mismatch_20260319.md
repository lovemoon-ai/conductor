# misc: codex resume cwd / PWD inconsistency leads to additional queries (2026-03-19)

## Symptoms
- When the user executes `conductor fire --resume <session-id>`, if the current shell path is not the working directory of the original codex session, an additional path-related question will be asked during the resume process.
- It seems that the cwd corresponding to the session has been parsed, but the running context has not been completely switched to the directory before actually calling the codex app-server.

## Root Cause
- `conductor fire` In the resume scenario, `cwd` recorded in the session will be parsed first, and `process.chdir()` will be called to switch the current directory.
- But just switching `process.cwd()` is not enough, the `PWD` environment variable inherited by the child process may still retain the old value.
- The working directory context perceived by codex app-server after startup is inconsistent, thus triggering additional queries.

## Fix
- In `applyWorkingDirectory()` of `conductor fire`, `process.env.PWD` is updated synchronously after executing `process.chdir()`.
- When starting the child process in codex app-server transport, explicitly set `PWD` in the child process environment to the cwd parsed by resume.
- Supplementary testing, covering:
- `PWD` is updated synchronously when cwd is switched on the fire side
- The `process.cwd()` / `PWD` seen by the codex app-server child process is consistent with the target cwd

## Prevention
- When dealing with "switching working directory" problems in the future, don't just check `process.cwd()`, but also check:
- Parent process `PWD`
- `PWD` inherited by the child process
- Really perceived cwd by downstream tools
- Fix the path involving external CLI/app-server, add an end-to-end test to verify the child process perspective, not just the current Node process perspective.
