# CLI entrypoint non-blocking version checks and prompts (2026-03-18)

## 1. Background
The current branch has implemented two types of version-related capabilities:
- `conductor update`: Manually check and upgrade CLI
- daemon auto-update: The background daemon automatically upgrades and restarts in the idle window
For everyday users, there is still a clear UX gap:
- When users usually run `conductor fire`, `conductor diagnose`, `conductor send-file` and other commands, they may not necessarily know that they are behind the latest version.
- If you do not actively execute `conductor update` and do not have a long-running daemon, you will not see the upgrade prompt in time.
Therefore, it is necessary to add a lightweight version-check capability at the **CLI entrypoint** to:
- Remind users of new versions without interrupting the main command
- Avoid lags caused by connecting to the Internet every time you start up
- Avoid polluting the output of scripts/CI scenarios
- Maintain clear layering with existing daemon auto-update responsibilities

## 2. Goal
### Main goals
Add a **non-blocking, cached, closeable, low-risk** version checking and prompting mechanism to each subcommand entry of `conductor`.
### Success definition
- When users run common CLI commands, if the local version lags behind, they can see clear prompts in the interactive terminal
- Version checks must **not block main command execution**
- The local cache controls check frequency so commands do not hit the network on every startup
- Non-TTY and script scenarios stay silent by default and do not pollute stdout
- `conductor update`, the child process launched inside the daemon, and the scenario where the check is explicitly turned off will not trigger the version check repeatedly.
## 3. Scope
### In Scope
- Hook the version-check trigger into the `cli/bin/conductor.js` entrypoint
- Add local cache files, such as `~/.conductor/version-check.json`
- Add background asynchronous checking logic
- Add new version prompt output
- Added environment variable switch and scenario exemption logic
- Supplementary testing for key behaviors
### Out of Scope
- Do not block and wait for npm registry synchronously before starting each command
- Do not perform automatic upgrade through normal CLI command entry
- Do not change the core strategy of daemon auto-update
- No additional UI pages or backend API changes
- Do not implement "cross-process global lock" or complex notification center in this issue

## 4. Problem statement
If you put "Check the latest version" directly before each command is started and execute it synchronously, there will be the following problems:
- High-frequency commands such as `fire` start slowly
- npm registry/proxy jitter will affect main functionality
- CI / shell script scenarios are easily polluted by redundant output
- Easily confused with the responsibilities of daemon auto-update
Therefore, this plan must meet:
- **Main command takes precedence**
- **Checks run asynchronously**
- **Cache-limited frequency**
- **Interactive-only prompts**
- **Explicitly switchable**

## 5. Suggestions
Adopt **Option 1: Each CLI entry triggers a lightweight check, but the frequency is limited through local cache and executed in a non-blocking manner**.
### Core Principles
1. The command execution path must not fail because version checking failed.
2. Version checking must not noticeably slow command startup.
3. Prompts should only appear for interactive users and must not disturb automated scripts.
4. The daemon idle window remains responsible for automatic updates; entrypoint checks are prompt-only.

## 6. Detailed design
### 6.1 Trigger position
In `cli/bin/conductor.js`, trigger a `maybeCheckForUpdates()` before routing subcommand.
Suggested timing:
- After parsing out the subcommand
- Dynamic `import(subcommandPath)` ago
- But the calling method must be **fire-and-forget**, not `await`
Right now:
- command start to continue immediately
- Version check is executed asynchronously in the background
- If the prompt condition is hit, print a concise prompt
### 6.2 Cache files
Add local cache file:
- `~/.conductor/version-check.json`
Suggested fields:
```json
{
  "lastCheckedAt": "2026-03-18T10:00:00.000Z",
  "latestVersion": "0.2.21",
  "latestCheckedAt": "2026-03-18T10:00:00.000Z",
  "lastNotifiedVersion": "0.2.21",
  "lastNotifiedAt": "2026-03-18T10:00:05.000Z"
}
```

Field semantics:
- `lastCheckedAt`: The time of the latest online check
- `latestVersion`: The latest successfully checked version
- `latestCheckedAt`: The confirmation time of `latestVersion`
- `lastNotifiedVersion`: The version that the user has been prompted for most recently
- `lastNotifiedAt`: Last prompt time
### 6.3 Frequency limiting strategy
Recommended default strategy:
- Not more than **12 hours** since the last successful/failed check: No more online checks
- If there is already `latestVersion > currentVersion` in the cache, it is allowed to directly use the cached result as a prompt
- Add a layer of suppression to the prompts of the same version, for example **Only prompt once within 24 hours**
Purpose:
- Reduce network request frequency
- Prevent users from seeing the same prompt for every command throughout the day
### 6.4 Network request constraints
Version checking should reuse existing capabilities:
- `cli/src/version-check.js`
- Priority `npm view ... version --json`
- Failure fallback to registry HTTP
However, it is recommended to add a shorter timeout in the entrance inspection scenario. The goal is:
- A single check should finish within **300ms to 1000ms** whenever possible.
- Timeouts and errors should be ignored directly and must not affect the main command.
Optional implementation methods:
- Add configurable timeout parameter to `fetchLatestVersion()`
- Or add a new wrapper:`fetchLatestVersionQuick()`
### 6.5 Output strategy
By default, prompts are only output under the following conditions:
- `process.stdout.isTTY === true`
- Not a CI scenario
- Not explicit silent mode
- The current command is not `conductor update`
- The current process is not a subcommand to be started within daemon/fire
Suggested prompt copy:
```text
New conductor version available: 0.2.20 -> 0.2.21. Run: conductor update
```

Require:
- single line
- clear message
- Do not output multi-paragraph descriptions
- Does not pollute stdout structured output scenarios
You can consider outputting to `stderr` to reduce interference to stdout.
### 6.6 Explicit shutdown
Support environment variables:
- `CONDUCTOR_SKIP_UPDATE_CHECK=1`
Behavior:
- Skip entry checks completely
- Do not read or write cache
### 6.7 Scenario exemption
The following scenarios should skip version checking:
1. `conductor update`
- Avoid recursion and duplicate checks
2. Non-TTY scenarios
   Avoid polluting script output.
3. CI scenarios
   Recognize `CI=1/true`.
4. daemon/fire internal secondary entry
   For example, subcommands spawned by daemon should not run update checks repeatedly.
   This can be identified using existing environment variables, such as `CONDUCTOR_CLI_COMMAND`.
- Or add `CONDUCTOR_SKIP_UPDATE_CHECK=1` to be passed explicitly by the internal call chain
5. User explicitly sets `CONDUCTOR_SKIP_UPDATE_CHECK=1`
### 6.8 Responsibility boundaries with daemon auto-update
Make a clear distinction between:
- CLI entry version checks: **prompt only**
- daemon auto-update: **actually performs automatic upgrades**
Entrance inspections should not:
- Automatically install new versions
- Modify global installation
- Actively restart daemon
Otherwise, it will conflict with daemon auto-update and increase the risk of command startup.

## 7. Involved files
### Needs changes
- `cli/bin/conductor.js`
- Entry trigger logic
- `cli/src/version-check.js`
- Reuse or expand quick inspection capabilities
- It is possible to add cache read and write help functions, or create a new independent module
### May be added
- `cli/src/cli-update-notifier.js`
- Responsible:
- Cache path and cache reading and writing
- Frequency limit judgment
- Skip conditional judgment
- Non-blocking checks and tips
### Test file
- Add or expand:
- `cli/test/version-check.test.js`
- Add `cli/test/cli-update-notifier.test.js` depending on implementation
- Or add `cli/test/conductor-entry.test.js`

## 8. Execution plan
1. Caching and skipping logic required for abstract entry version checking2. Define cache file format and frequency limiting strategy3. Reuse the version acquisition capability of `version-check.js` and add short timeout support4. Access non-blocking trigger at `cli/bin/conductor.js`5. Add TTY / CI / subcommand / env skip judgment6. Added "new version available" prompt output7. Supplementary testing covers cache hits, cache expiration, skip scenarios, prompt suppression, and non-blocking behavior8. Manual verification:
- There are prompts under the interactive terminal
- Non-interactive scenes do not pollute the output
- `conductor update` does not trigger repeatedly
## 9. Acceptance Criteria
- [ ] When running commands such as `conductor fire` / `conductor diagnose`, the main process will not be blocked due to version checking
- [ ] When the local cache has not expired, network requests to the registry will not be repeated.
- [ ] When cache or network results indicate that there is a new version, the interactive terminal will prompt `Run: conductor update`
- [ ] The same version will not repeat frequent prompts in a short period of time
- [ ] `conductor update` does not trigger entry version check
- [ ] `CI=true` or non
- TTY scenes do not output prompts by default
- [ ] Skip checking completely after setting `CONDUCTOR_SKIP_UPDATE_CHECK=1`
- [ ] Test covers success path, failure path, timeout path, cache path, skip path

## 10. Risks
### Risk 1: Still affecting command startup speed
If the implementation misuses `await` or long timeouts, the entry check can slow down all CLI commands.
### Risk 2: Output contamination
If the prompt outputs to stdout, it may break scripts or structured output.
### Risk 3: Too many repeated prompts
Without the `lastNotifiedVersion` mechanism, users would see the same prompt frequently.
### Risk 4: Internal sub-process triggered repeatedly
If the child process of daemon/fire also performs entry checks, it may cause additional noise and meaningless network requests.

## 11. Questions to be clarified
1. Should entrypoint prompts always go to `stderr` to reduce the risk of stdout contamination?
2. Should the default cache policy be:
- Check interval 12h
- Notification interval 24h
3. Should this only apply to the `conductor` entrypoint, or should it also cover development flows that directly execute `conductor-fire.js` / `conductor-daemon.js`?

## 12. Recommended conclusion
It is recommended to follow this issue and use:
- Unified triggering at the entrypoint
- Non-blocking asynchronous checks
- Local cache frequency limit
- Interactive one-line prompts
- Automatic upgrades continue to be handled only by daemon auto-update
This is the smallest, most stable, and least disturbing enhancement path to the current version of the system.
