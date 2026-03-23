# misc: linux install.sh should avoid system npm prefix by default (2026-03-23)
## Problem performance
- On Linux, `web/public/install.sh` could try to install Conductor into a system npm global prefix such as `/usr/local`.
- That path usually requires root or sudo, so the installer could fail or unexpectedly push users toward a privileged install.

## Cause analysis
- The installer treated any detected system npm as the default target and only reacted after discovering write permission problems.
- It did not distinguish between a user-owned npm global prefix and a system-owned prefix.
- It also did not offer a first-class fallback to a local user prefix such as `~/.conductor`.

## Solution
- Detect Linux system npm prefixes such as `/usr`, `/usr/local`, `/opt`, and `/var/lib`.
- Before attempting installation there, ask the user whether to switch to a local prefix under `~/.conductor`.
- In non-interactive environments, automatically fall back to the local prefix instead of attempting sudo.
- When local prefix mode is used, print or write both:
  - `export npm_config_prefix="$HOME/.conductor"`
  - `export PATH="$HOME/.conductor/bin:$PATH"`

## How to avoid it next time
- Any installer that may touch system-owned paths should detect that condition before it reaches the permission failure path.
- For CLI bootstrap scripts, always design an unprivileged user-local install path first, then treat system installs as an explicit opt-in.
- Test both interactive and non-interactive installer behavior, especially around privilege escalation and shell setup output.
