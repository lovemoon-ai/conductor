# misc: conductor update installed into a different prefix than install.sh (2026-08-24)

## Problem performance
- After installing via `web/public/install.sh`, running `conductor update` reported success, but `conductor --version` kept showing the old version.
- Repeating the update did not help: every run "succeeded" and every run left the version unchanged.
- Two independent copies of the CLI were present on the affected machine:
  - `~/.conductor/bin/conductor` -> `~/.conductor/lib/node_modules/@love-moon/conductor-cli` (0.8.0, written by `install.sh`)
  - `~/.conductor/node/bin/conductor` -> `~/.conductor/node-v23.11.0-linux-x64/lib/node_modules/@love-moon/conductor-cli` (0.9.0, written by `conductor update`)

## Cause analysis
- `setup_conductor_node()` in `install.sh` ran `export npm_config_prefix="$CONDUCTOR_HOME"`. That export only lived for the duration of the installer process.
- The export was never persisted: `build_npm_prefix_export_line()` returns early unless `USE_LOCAL_NPM_PREFIX` is `1`, and only `configure_local_npm_prefix()` set that flag. The Conductor-managed-Node branch did not, so the rc block got the `PATH` line and nothing else. No `.npmrc` was written either.
- Consequently the prefix was forgotten the moment the installer exited. When `conductor update` later ran `npm install -g`, the bundled npm fell back to its built-in default prefix, which is its own Node install dir (`~/.conductor/node-v23.11.0-linux-x64`), not `~/.conductor`.
- The two locations then drifted apart. Because the update wrote to a tree that was not the one being executed, the running CLI never changed version, and the next update repeated the cycle.
- Aggravating factor: `conductor update` spawned a bare `npm` resolved through `PATH`, so the destination depended on whichever npm happened to win the lookup. `native-deps.js` had the same issue with `npm root -g`, which is why the post-update node-pty verification passed while inspecting the wrong tree.
- Note the sibling branch (system npm switched to a local prefix, see `misc_linux_install_sh_system_npm_prefix_20260323.md`) was never affected: it sets `USE_LOCAL_NPM_PREFIX=1`, so its `npm_config_prefix` does get persisted into the rc.

## Solution
- `install.sh`, Conductor-managed-Node branch: stop pinning a prefix and `unset npm_config_prefix` instead, so the bundled npm uses its built-in default. `conductor update` resolves that same default with no shared state, so the two agree by construction rather than by agreement.
- `install.sh`: drop `~/.conductor/bin` from the generated `PATH` block, since `node/bin` now exposes the CLI.
- `install.sh`: added `migrate_conductor_home_layout()`, which removes the superseded `~/.conductor/lib/node_modules/@love-moon` tree and leaves `~/.conductor/bin/conductor` behind as a symlink to `../node/bin/conductor`. The link goes through the stable `node` symlink so it survives a Node version bump, and it keeps old rc entries, cached shell hashes and absolute references pointing at the live build.
- `install.sh`: added `rc_has_outdated_conductor_block()` so a stale block is rewritten even when `conductor` already resolves. Old blocks exported an `npm_config_prefix` that outlived the install and silently retargeted every later `npm install -g`, not just Conductor's.
- `conductor update`: added `resolveGlobalInstallPrefix()` in `cli/src/version-check.js`, which derives the prefix from the running package root (`<prefix>/lib/node_modules/<package>`), and pins `npm_config_prefix` for all child commands. The update now always replaces the copy that is actually running, whatever installed it.

## How to avoid it next time
- An installer and its updater are two processes that never meet. Any location the installer chooses must either be re-derivable from scratch by the updater, or persisted somewhere the updater will read. An `export` in the installer is neither.
- Prefer inheriting a tool's built-in default over overriding it. An override has to be transported to every future invocation; a default is recomputed correctly every time.
- A self-updating CLI should target the prefix it is running from, not the one a `PATH` lookup happens to resolve. Deriving it from `__dirname` is reliable; `which npm` is not.
- "Update succeeded" is not evidence. Verification must re-read the version through the same entry point the user invokes, otherwise it can pass against a tree nobody runs.
- When changing an install layout, ship the migration in the same change: delete the superseded tree and leave a compatibility symlink. Users do not re-run installers to repair themselves, and stale absolute paths outlive the install that created them.
- `install.sh` has no automated coverage. The fix was validated with a throwaway-`HOME` sandbox that stubs the Node download and npm; that approach is cheap and worth reaching for whenever this script changes.
