# misc: install.sh hung forever on a stalled npm registry and needed nodejs.org to compile node-pty (2026-10-02)

## Problem performance
- Installing the CLI on a Jetson Thor (aarch64, Ubuntu 24.04, no direct internet, reached through an `ssh -R` SOCKS tunnel) did not complete. Three separate failures were reproduced on that machine:
  - With no network at all, the installer printed only `curl: (7) Failed to connect to nodejs.org port 443` and exited 7, with no hint about what to do.
  - Through the tunnel, `npm install -g @love-moon/conductor-cli@latest` hung with no output and no error. Two runs out of two; they were stopped by hand after 23 and 14 minutes.
  - With the network gone, compiling node-pty failed with a wall of `gyp ERR!` ending in `FetchError: request to https://nodejs.org/download/release/v23.11.0/node-v23.11.0-headers.tar.gz failed`.
- No trace of the user's original attempt was left on the machine, so which of the three they hit first is not known.

## Cause analysis
- About a third of the connections from that network to `registry.npmjs.org` complete the TCP handshake and then stall in the TLS handshake (8 of 24 probes across the registry's addresses).
- npm 10.9 has no timeout for that state. A local test against a server that accepts and never answers showed it still hanging after 60s with `--fetch-timeout=5000 --fetch-retries=1`, both directly and through a SOCKS proxy. npm flags cannot fix this.
- `install.sh` ran npm with no bound, and its only retry was `--force` against the same registry.
- node-pty 1.1.0 ships prebuilds for darwin and win32 only. On Linux it is compiled by node-gyp, which first downloads the Node headers from nodejs.org. The managed Node tarball the installer had just unpacked already contains those headers under `include/node`.
- The Node download used a bare `curl -fsSL` under `set -e`, so a failure ended the script before any explanation.

## Solution
- `install.sh` bounds each `npm install -g` (300s, `CONDUCTOR_INSTALL_NPM_TIMEOUT` overrides) with a small bash watchdog, since macOS has no `timeout`. The attempts are now: default registry, then `--registry=https://registry.npmmirror.com/`, then `--force`.
- `setup_conductor_node` exports `npm_config_nodedir` pointing at the managed Node dir, so node-gyp uses the bundled headers and never contacts nodejs.org.
- A failed Node download removes the partial archive and says what failed and that `HTTPS_PROXY` is the way through.
- `conductor update` and the daemon updater set `npm_config_nodedir` when the running Node ships its headers (`resolveBundledNodeDir`). `conductor update` also stops an npm install that runs past 15 minutes; the daemon updater already did.

## Verification
- `web/scripts/install-sh-scenarios.sh` gained `stalled-npm-falls-back-to-mirror` and `node-download-failure-is-explained`, and `fresh-managed-node` now asserts the pinned header dir. All three fail against the previous `install.sh`.
- On the Thor, in a throwaway `$HOME`: a normal install through the tunnel finished in 161s and left no `~/.cache/node-gyp`; with the default registry pointed at a server that never answers, npm was stopped at the timeout and the mirror attempt completed the install.
- Not covered: the watchdog cannot stop npm when it runs under `sudo`, and `conductor update` has no mirror fallback.

## How to avoid next time
- Any child process that talks to the network needs a bound owned by the caller. Do not assume the tool's own timeout flags cover every stall; test against a peer that accepts and stays silent.
- When listing what an installer needs from the network, include what its dependencies' install scripts fetch. node-gyp's header download was missed in the first pass of this investigation because the tunnel happened to be up.
- Test installers on a machine with no direct internet, not only on developer laptops.
