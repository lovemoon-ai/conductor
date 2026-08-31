# misc: install.sh still produced the superseded ~/.conductor/{bin,lib} layout (2026-08-31)

## Problem performance
- `web/public/install.sh` could still install the CLI into `~/.conductor/bin` + `~/.conductor/lib/node_modules`, the layout that `26abd1b` ("fix conductor update installing into the wrong npm prefix") retired in favour of the managed Node dir.
- Two paths reached it:
  - the Linux fallback, when the detected system npm prefix was root-owned (`/usr`, `/usr/local`, `/opt`, `/var/lib`);
  - any shell that had already sourced an older installer's rc block, because that block exports `npm_config_prefix="$HOME/.conductor"` and the installer simply obeyed it.
- Symptom on the affected machine: the CLI sat under `~/.conductor/lib`, while `conductor update` and the daemon auto-update wrote to `~/.conductor/node-v23.11.0-*/lib`, so the two trees drifted apart again — the same failure `26abd1b` fixed for the fresh-install path only.

## Cause analysis
- `26abd1b` fixed the Conductor-managed-Node branch (stop pinning a prefix, let the bundled npm resolve its own default, which `conductor update` re-derives independently). It did not touch `configure_local_npm_prefix()`, which kept pinning `npm_config_prefix="$CONDUCTOR_HOME"` and persisting that export into the user's rc.
- So the installer had two install layouts while the updater had one. Whichever branch the machine happened to take decided whether install and update agreed.
- The persisted export made it sticky: even after the layout was retired, a re-run of the installer inherited `npm_config_prefix` from the environment, resolved the legacy prefix, and reinstalled into it. `migrate_conductor_home_layout()` could not help, because it only ran when `USED_CONDUCTOR_NODE=1`.
- Latent, found while testing the fix: when the managed Node was already on `PATH` from a previous install, `check_npm()` treated it as a plain "system npm", leaving `USED_CONDUCTOR_NODE=0`. The rc block was then generated from the *resolved* dirs, emitting the versioned `~/.conductor/node-v23.11.0-darwin-arm64/bin` twice instead of the stable `~/.conductor/node/bin` symlink — a `PATH` that breaks on the next Node version bump, plus a spurious "your rc is outdated" prompt on every re-run.
- Latent, found in review: `rc_contains_current_path_setup()` decided "the rc is already up to date" by `grep`ing the **whole file** for each line the installer would write, and only ever checked that the new lines were *present* — never that the old ones were *gone*. Since the new block is a single `PATH` line, a user who followed the installer's own non-interactive instructions and pasted that line outside the markers, leaving the stale block intact, was classified as up to date. `offer_path_setup()` then returned early and the `npm_config_prefix` export survived every subsequent run — the exact thing this change exists to remove.

## Solution
- Deleted `configure_local_npm_prefix()` / `maybe_switch_to_local_npm_prefix()`. The single user-local target is now the managed Node dir, reached through `setup_conductor_node()`.
- `maybe_switch_to_conductor_node()` redirects there for both triggers: a root-owned system prefix on Linux (unchanged prompt, non-interactive still falls back automatically), and a prefix that resolves to the legacy `~/.conductor` (redirected without asking — installing there is simply wrong now). `setup_conductor_node()` already unsets `npm_config_prefix`, which drops the inherited env var on the way through.
- `check_npm()` sets `USED_CONDUCTOR_NODE=1` when the resolved prefix lives under `~/.conductor`, so a re-run keeps writing the stable `$HOME/.conductor/node/bin` rc line and re-runs the migration.
- Removed `build_npm_prefix_export_line()`: the rc block is now PATH-only on every branch, so no installer writes an `npm_config_prefix` that outlives it.
- `rc_contains_current_path_setup()` now compares only the text *between the markers*, and compares it for equality rather than containment, so a surviving `npm_config_prefix` line forces the rewrite branch. After a rewrite the installer also warns if `npm_config_prefix` still appears elsewhere in the rc — text outside the markers is not ours to delete, but it is worth naming.
- `migrate_conductor_home_layout()` also `rmdir`s the now-empty `~/.conductor/lib`; `print_manual_path_instructions()` tells non-interactive users to *replace* the stale block rather than append to it.

## Verification
`install.sh` had no automated coverage, which is why the same class of drift landed twice. It now has some: `web/scripts/install-sh-scenarios.sh` runs the installer against a throwaway `$HOME` with the Node download, `npm`, `node` and `uname` all stubbed, and `web/scripts/install-sh.test.ts` runs each scenario as its own case under `cd web && pnpm test`. The scenarios:

| scenario | pins |
| --- | --- |
| `fresh-managed-node` | no npm at all → managed Node dir |
| `legacy-prefix-from-env` | inherited `npm_config_prefix=~/.conductor` → redirected + migrated |
| `linux-system-prefix` | root-owned prefix, no tty → managed Node dir, never sudo |
| `rewrites-stale-rc-block` | interactive → stale block replaced, prefix export gone |
| `detects-stale-block-when-path-line-pasted-outside` | the review finding above |
| `rerun-is-idempotent` | re-run advertises `node/bin`, not the version-stamped dir; no re-download |
| `user-owned-npm-untouched` | nvm-style npm left alone, no `~/.conductor` created |

Each scenario was checked to fail against the code it guards, not just to pass against the fix: the pre-change `install.sh` fails 4 of them (12 assertions), and the intermediate version that still had the file-wide rc check fails `detects-stale-block-when-path-line-pasted-outside`. Full suite: 214 files / 1928 tests green.

### The harness destroyed a real install before it was contained
An early revision of this harness overwrote the developer's actual global CLI — `package.json` and `bin/conductor.js` in `~/.nvm/.../@love-moon/conductor-cli` became the two-line `echo 9.9.9` stub, and `bin/conductor-verify-node-pty.js` became `process.exit(0)`, so every subcommand died and the node-pty check silently passed.

The path: the pty driver initially inherited the caller's environment, `npm`/`pnpm` export `npm_config_prefix` pointing at the developer's real global prefix, and the npm stub read `prefix="${npm_config_prefix:-$stub_default}"` and installed there. `cd web && pnpm test` — the command in CLAUDE.md — reproduced it every run.

Two guards now stand behind the `env -i`:
- the runner drops every `npm_config_*` / `NPM_CONFIG_*` variable before any scenario starts;
- the npm stub's `install` refuses to write unless the resolved prefix is inside this run's sandbox, printing the prefix, the resolution and the leaked variable.

Verified by deliberately reintroducing the leak: with `env -i` stripped from both runners *and* the scrub disabled, `npm_config_prefix` pointed at a decoy outside the sandbox, the scenarios go red with `stub npm: REFUSING to install outside the sandbox` and the decoy is untouched. Confirmed the other way too — the real install is byte-identical (checksums + symlink target) after a full `pnpm test`.

## How to avoid it next time
- When retiring an install layout, grep for *every* branch that can produce it before declaring the migration done. A fix applied to one branch of a two-branch installer leaves the bug alive on the other half of the fleet.
- An installer should have exactly one user-local target. Two targets means the updater has to guess, and it will guess wrong on some machines.
- Never persist an `npm_config_prefix` into a user's rc. It outlives the install, retargets every later `npm install -g`, and makes the next installer run inherit — and re-create — the layout you are trying to remove.
- Installer state must be re-derivable, not remembered. `USED_CONDUCTOR_NODE` was only set by the branch that *performed* the download; deriving it from the resolved prefix instead makes re-runs behave like first runs.
- Generated `PATH` entries should point at stable symlinks (`~/.conductor/node/bin`), never at version-stamped directories, or the entry rots at the next runtime bump.
- "Is this config current?" is an equality question, not a containment one. Checking that the new lines are present says nothing about whether the dangerous old ones are gone, and searching the whole file instead of the region you own lets text you did not write vouch for text you did.
- Ship coverage with the fix when a file has none. This script had drifted twice in two changes precisely because nothing pinned its branches; `install.sh` is shell, but it is still testable with a fake `$HOME` and stubbed binaries, and the scenarios only prove anything because each was run against the broken version first.
- A test harness has an environment too. The pty scenarios originally leaked the caller's env into the installer, so they passed under `npm test` (which exports `npm_config_*`) while failing under a plain shell — a green suite that was testing a different code path than the one it claimed.
- A destructive stub must prove its target is inside the sandbox before it writes, not merely try to stay there. Isolation built only from "the caller sets the right variables" fails open: one forgotten `env -i` turns the test suite into an uninstaller. The assertion is three lines and converts every future leak from a damaged machine into a red test.
- The dangerous variables are the ones you never mention. `HOME` was always safe because every runner assigns it explicitly; `npm_config_prefix` was not, because most scenarios simply left it unset and let an inherited value win. When sandboxing, enumerate what you clear, not just what you set.
- Test a harness's isolation the same way you test the code: break it on purpose and confirm it fails loudly. Deliberately re-leaking the environment is what proved the guard works — until that run, "the stubs write to a temp dir" was an assumption, not a verified property.
