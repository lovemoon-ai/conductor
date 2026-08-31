#!/usr/bin/env bash
#
# Scenario tests for web/public/install.sh.
#
# install.sh picks an install layout by probing the machine (is there an npm? whose prefix is it?
# what did a previous run leave in the rc?), and every one of those branches has to agree with the
# layout `conductor update` re-derives on its own. That agreement has already drifted twice, so the
# branches are pinned here.
#
# Everything the installer touches is faked: $HOME is a throwaway directory, the Node download is a
# locally built tarball, and node/npm are stubs. Nothing reaches the network or the real machine.
#
# Usage:
#   bash scripts/install-sh-scenarios.sh            # run all scenarios
#   bash scripts/install-sh-scenarios.sh --list     # print scenario names
#   bash scripts/install-sh-scenarios.sh <name>...  # run selected scenarios

set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
WEB_DIR=$(dirname "$SCRIPT_DIR")
INSTALL_SH="${WEB_DIR}/public/install.sh"
NODE_VERSION="23.11.0"

SCENARIOS=(
    fresh-managed-node
    legacy-prefix-from-env
    linux-system-prefix
    rewrites-stale-rc-block
    detects-stale-block-when-path-line-pasted-outside
    rerun-is-idempotent
    user-owned-npm-untouched
)

FAILURES=0
CURRENT=""
SANDBOX=""
SANDBOX_REAL=""

# npm and pnpm export npm_config_* to everything they spawn, and npm_config_prefix points at the
# developer's real global prefix. `env -i` in the runners is the primary barrier; dropping these
# here means a future runner that forgets it still cannot reach outside the sandbox.
while IFS='=' read -r _name _; do
    case "$_name" in
        npm_config_*|NPM_CONFIG_*) unset "$_name" ;;
    esac
done < <(env)

# ----------------------------------------------------------------------------- assertions

fail() {
    printf 'FAIL %s: %s\n' "$CURRENT" "$1" >&2
    FAILURES=$((FAILURES + 1))
}

assert_exists() {
    [ -e "$1" ] || [ -L "$1" ] || fail "expected to exist: ${1#"$SANDBOX"/} ($2)"
}

assert_absent() {
    if [ -e "$1" ] || [ -L "$1" ]; then
        fail "expected to be gone: ${1#"$SANDBOX"/} ($2)"
    fi
}

assert_symlink_to() {
    local actual
    actual=$(readlink "$1" 2>/dev/null || true)
    [ "$actual" = "$2" ] || fail "${1#"$SANDBOX"/} -> '${actual}', expected '$2' ($3)"
}

assert_contains() {
    grep -Fq "$2" "$1" 2>/dev/null || fail "${1#"$SANDBOX"/} should contain '$2' ($3)"
}

assert_not_contains() {
    if grep -Fq "$2" "$1" 2>/dev/null; then
        fail "${1#"$SANDBOX"/} should NOT contain '$2' ($3)"
    fi
}

# ----------------------------------------------------------------------------- fixtures

# An npm stub that defaults its global prefix to its own Node dir, the way a bundled npm does.
# $2 pins a different default, standing in for a system npm at /usr/local or similar. It is baked
# into this stub rather than passed through the environment, so it cannot leak into the managed npm
# that the installer switches to partway through a run.
#
# The stub has to honour an inherited npm_config_prefix, because that is exactly what the legacy
# layout the installer migrates away from looks like. That makes it a destructive write driven by an
# environment variable, so `install` refuses to touch anything outside the sandbox: npm and pnpm
# export npm_config_prefix pointing at the developer's REAL global prefix, and a leak that reaches
# here would otherwise overwrite their actual conductor install instead of failing a test.
write_npm_stub() {
    {
        printf '#!/usr/bin/env bash\n'
        printf 'set -e\n'
        printf 'self_bin=$(cd "$(dirname "$0")" && pwd -P)\n'
        printf 'stub_default=%q\n' "${2:-}"
        printf 'stub_sandbox=%q\n' "$SANDBOX_REAL"
        printf '[ -n "$stub_default" ] || stub_default=$(dirname "$self_bin")\n'
        cat <<'STUB'
prefix="${npm_config_prefix:-$stub_default}"

# Resolve the deepest existing ancestor, so a prefix that does not exist yet still resolves to a
# real path that can be compared against the sandbox.
assert_inside_sandbox() {
    local probe="$1"
    local resolved=""

    while [ -n "$probe" ] && [ "$probe" != "/" ] && [ ! -d "$probe" ]; do
        probe=$(dirname "$probe")
    done
    [ -d "$probe" ] && resolved=$(cd "$probe" && pwd -P)

    case "${resolved}/" in
        "${stub_sandbox}"/*) return 0 ;;
    esac

    {
        echo "stub npm: REFUSING to install outside the sandbox."
        echo "  npm prefix : ${1}"
        echo "  resolved   : ${resolved:-<unresolvable>}"
        echo "  sandbox    : ${stub_sandbox}"
        echo "  npm_config_prefix=${npm_config_prefix:-<unset>}"
        echo "This means the caller's environment leaked into the scenario."
    } >&2
    exit 1
}

case "${1:-}" in
    --version) echo "10.9.2" ;;
    config) [ "${2:-}" = get ] && [ "${3:-}" = prefix ] && echo "$prefix" ;;
    root) echo "$prefix/lib/node_modules" ;;
    rebuild) exit 0 ;;
    install)
        assert_inside_sandbox "$prefix"
        pkg="$prefix/lib/node_modules/@love-moon/conductor-cli"
        mkdir -p "$pkg/bin" "$prefix/bin"
        printf '{"name":"@love-moon/conductor-cli","version":"9.9.9"}\n' > "$pkg/package.json"
        printf '#!/usr/bin/env bash\necho 9.9.9\n' > "$pkg/bin/conductor.js"
        printf 'process.exit(0)\n' > "$pkg/bin/conductor-verify-node-pty.js"
        chmod +x "$pkg/bin/conductor.js"
        ln -sfn "../lib/node_modules/@love-moon/conductor-cli/bin/conductor.js" "$prefix/bin/conductor"
        ;;
    *) echo "stub npm: unhandled $*" >&2; exit 1 ;;
esac
STUB
    } > "$1"
    chmod +x "$1"
}

write_node_stub() {
    cat > "$1" <<STUB
#!/usr/bin/env bash
[ "\${1:-}" = --version ] && echo "v${NODE_VERSION}"
exit 0
STUB
    chmod +x "$1"
}

# The tarball install.sh believes it downloaded from nodejs.org.
build_node_tarball() {
    local os="$1" arch="$2" out="$3"
    local staging="${SANDBOX}/staging" dir="node-v${NODE_VERSION}-${os}-${arch}"

    rm -rf "$staging"
    mkdir -p "${staging}/${dir}/bin"
    write_node_stub "${staging}/${dir}/bin/node"
    write_npm_stub "${staging}/${dir}/bin/npm"
    tar -czf "$out" -C "$staging" "$dir"
    rm -rf "$staging"
}

# HOME, PATH and the download all pointed at the sandbox. Sets HOME_DIR / STUB_DIR / RC_FILE.
new_case() {
    local os="${1:-darwin}" arch="${2:-arm64}"

    CASE_DIR="${SANDBOX}/${CURRENT}"
    HOME_DIR="${CASE_DIR}/home"
    STUB_DIR="${CASE_DIR}/stub"
    RC_FILE="${HOME_DIR}/.zshrc"
    rm -rf "$CASE_DIR"
    mkdir -p "$HOME_DIR" "$STUB_DIR"

    build_node_tarball "$os" "$arch" "${CASE_DIR}/node.tar.gz"

    cat > "${STUB_DIR}/curl" <<STUB
#!/usr/bin/env bash
out=""
while [ \$# -gt 0 ]; do
    case "\$1" in -o) out="\$2"; shift 2 ;; *) shift ;; esac
done
cp "${CASE_DIR}/node.tar.gz" "\$out"
STUB
    chmod +x "${STUB_DIR}/curl"

    # install.sh keys the download URL and the Linux-only prefix prompt off uname.
    cat > "${STUB_DIR}/uname" <<STUB
#!/usr/bin/env bash
case "\${1:-}" in
    -s) echo "$([ "$os" = darwin ] && echo Darwin || echo Linux)" ;;
    -m) echo "$([ "$arch" = x64 ] && echo x86_64 || echo arm64)" ;;
esac
STUB
    chmod +x "${STUB_DIR}/uname"

    # Force the curl path; a real wget would try the network.
    printf '#!/usr/bin/env bash\nexit 1\n' > "${STUB_DIR}/wget"
    chmod +x "${STUB_DIR}/wget"
}

# Pre-existing install in the superseded ~/.conductor/{bin,lib} layout.
seed_legacy_install() {
    local pkg="${HOME_DIR}/.conductor/lib/node_modules/@love-moon/conductor-cli"

    mkdir -p "${pkg}/bin" "${HOME_DIR}/.conductor/bin"
    printf '{"name":"@love-moon/conductor-cli","version":"0.8.0"}\n' > "${pkg}/package.json"
    printf '#!/usr/bin/env bash\necho 0.8.0\n' > "${pkg}/bin/conductor.js"
    chmod +x "${pkg}/bin/conductor.js"
    ln -sfn "../lib/node_modules/@love-moon/conductor-cli/bin/conductor.js" \
        "${HOME_DIR}/.conductor/bin/conductor"
}

# Pre-existing install in the current managed-Node layout.
seed_managed_install() {
    local conductor_home="${HOME_DIR}/.conductor"
    local pkg

    mkdir -p "$conductor_home"
    tar -xzf "${CASE_DIR}/node.tar.gz" -C "$conductor_home"
    ln -sfn "${conductor_home}/node-v${NODE_VERSION}-darwin-arm64" "${conductor_home}/node"
    pkg="${conductor_home}/node/lib/node_modules/@love-moon/conductor-cli"
    mkdir -p "${pkg}/bin"
    printf '{"name":"@love-moon/conductor-cli","version":"9.9.9"}\n' > "${pkg}/package.json"
    printf '#!/usr/bin/env bash\necho 9.9.9\n' > "${pkg}/bin/conductor.js"
    printf 'process.exit(0)\n' > "${pkg}/bin/conductor-verify-node-pty.js"
    chmod +x "${pkg}/bin/conductor.js"
    ln -sfn "../lib/node_modules/@love-moon/conductor-cli/bin/conductor.js" \
        "${conductor_home}/node/bin/conductor"
}

write_legacy_rc_block() {
    cat > "$RC_FILE" <<'RC'
# >>> conductor install >>>
# Added by Conductor installer
export npm_config_prefix="$HOME/.conductor"
export PATH="$HOME/.conductor/bin:$PATH"
# <<< conductor install <<<
RC
}

# ----------------------------------------------------------------------------- running

# $@ = extra VAR=value assignments. PATH_EXTRA prepends to the sandbox PATH.
run_installer() {
    env -i \
        HOME="$HOME_DIR" \
        PATH="${PATH_EXTRA:-}${STUB_DIR}:/usr/bin:/bin:/usr/sbin:/sbin" \
        SHELL=/bin/zsh \
        CONDUCTOR_INSTALL_RC_FILE="$RC_FILE" \
        "$@" \
        bash "$INSTALL_SH" > "${CASE_DIR}/output.log" 2>&1
    local status=$?

    if [ "$status" -ne 0 ]; then
        fail "installer exited ${status}; see ${CASE_DIR}/output.log"
    fi
    return 0
}

have_pty_runner() {
    command -v script >/dev/null 2>&1
}

# install.sh reads confirmations from /dev/tty, so the interactive branches need a real pty.
# `script` covers that on both macOS (BSD) and Linux (util-linux), with incompatible argument
# orders; the sleep keeps the pty open long enough for the read to land.
run_installer_with_tty() {
    local driver="${CASE_DIR}/driver.sh"

    # `env -i` for the same reason run_installer uses it: without it the driver inherits the
    # caller's environment, and running the suite under npm/npx would leak npm_config_* into the
    # installer and silently send it down a different branch than a plain shell run.
    {
        printf '#!/usr/bin/env bash\n'
        printf 'exec env -i \\\n'
        printf '  HOME=%q \\\n' "$HOME_DIR"
        printf '  PATH=%q \\\n' "${PATH_EXTRA:-}${STUB_DIR}:/usr/bin:/bin:/usr/sbin:/sbin"
        printf '  SHELL=/bin/zsh \\\n'
        printf '  CONDUCTOR_INSTALL_RC_FILE=%q \\\n' "$RC_FILE"
        local assignment
        for assignment in "$@"; do
            printf '  %q \\\n' "$assignment"
        done
        printf '  bash %q\n' "$INSTALL_SH"
    } > "$driver"
    chmod +x "$driver"

    if script --version 2>&1 | grep -q util-linux; then
        { printf 'y\n'; sleep 3; } | script -q -e -c "$driver" /dev/null \
            > "${CASE_DIR}/output.log" 2>&1
    else
        { printf 'y\n'; sleep 3; } | script -q /dev/null "$driver" \
            > "${CASE_DIR}/output.log" 2>&1
    fi
}

conductor_home() { printf '%s' "${HOME_DIR}/.conductor"; }
managed_pkg_root() {
    printf '%s' "${HOME_DIR}/.conductor/node/lib/node_modules/@love-moon/conductor-cli"
}

# The invariant every branch has to hold: the CLI lives in the managed Node dir, the superseded
# ~/.conductor/lib tree is gone, and ~/.conductor/bin/conductor survives only as a symlink for
# users whose rc still has the old PATH entry.
assert_managed_node_layout() {
    assert_exists "$(managed_pkg_root)/package.json" "CLI installed under the managed Node dir"
    assert_absent "$(conductor_home)/lib" "superseded ~/.conductor/lib tree removed"
    assert_symlink_to "$(conductor_home)/bin/conductor" "../node/bin/conductor" \
        "compatibility symlink kept for old PATH entries"
}

# ----------------------------------------------------------------------------- scenarios

# No npm at all: download the managed Node and install into it.
scenario_fresh_managed_node() {
    new_case darwin arm64
    run_installer
    assert_managed_node_layout
    assert_contains "${CASE_DIR}/output.log" 'export PATH="$HOME/.conductor/node/bin:$PATH"' \
        "advertises the stable node/bin symlink"
}

# An older installer left `npm_config_prefix=~/.conductor` exported in the user's shell. Obeying it
# would rebuild the superseded layout, so the installer has to redirect and migrate instead.
scenario_legacy_prefix_from_env() {
    new_case darwin arm64
    seed_legacy_install
    write_legacy_rc_block
    write_npm_stub "${STUB_DIR}/npm"
    write_node_stub "${STUB_DIR}/node"

    run_installer npm_config_prefix="${HOME_DIR}/.conductor"

    assert_managed_node_layout
    assert_absent "$(conductor_home)/lib/node_modules/@love-moon" "legacy package tree removed"
}

# Linux with a root-owned npm prefix, no tty to answer the prompt: fall back to the managed Node
# rather than reaching for sudo.
scenario_linux_system_prefix() {
    new_case linux x64
    write_npm_stub "${STUB_DIR}/npm" /usr/local
    write_node_stub "${STUB_DIR}/node"

    run_installer

    assert_exists \
        "${HOME_DIR}/.conductor/node-v${NODE_VERSION}-linux-x64/lib/node_modules/@love-moon/conductor-cli" \
        "CLI installed under the managed Node dir"
    assert_absent "$(conductor_home)/lib" "no superseded ~/.conductor/lib tree"
}

# A stale block still exporting npm_config_prefix must be replaced, not appended to: left in place
# it retargets every later `npm install -g`.
scenario_rewrites_stale_rc_block() {
    if ! have_pty_runner; then
        printf 'SKIP %s: no `script` binary for a pty\n' "$CURRENT"
        return
    fi

    new_case darwin arm64
    seed_legacy_install
    write_legacy_rc_block
    write_npm_stub "${STUB_DIR}/npm"
    write_node_stub "${STUB_DIR}/node"

    run_installer_with_tty npm_config_prefix="${HOME_DIR}/.conductor"

    assert_managed_node_layout
    assert_not_contains "$RC_FILE" "npm_config_prefix" "stale prefix export removed from the rc"
    assert_contains "$RC_FILE" 'export PATH="$HOME/.conductor/node/bin:$PATH"' \
        "rc points at the stable node/bin symlink"
}

# Regression: the user pasted the new PATH line outside the markers (following the installer's own
# manual instructions) while the stale block stayed put. A file-wide "are the new lines present?"
# check calls that up to date and never removes the npm_config_prefix export.
scenario_detects_stale_block_when_path_line_pasted_outside() {
    if ! have_pty_runner; then
        printf 'SKIP %s: no `script` binary for a pty\n' "$CURRENT"
        return
    fi

    new_case darwin arm64
    seed_managed_install
    write_legacy_rc_block
    cat >> "$RC_FILE" <<'RC'

# pasted by hand from the installer's manual instructions
export PATH="$HOME/.conductor/node/bin:$PATH"
RC

    PATH_EXTRA="${HOME_DIR}/.conductor/node/bin:" run_installer_with_tty

    assert_not_contains "$RC_FILE" "npm_config_prefix" "stale prefix export removed from the rc"
    assert_not_contains "$RC_FILE" '$HOME/.conductor/bin:$PATH' "stale PATH entry removed"
}

# Re-running on an already-migrated machine must be a no-op, and must keep advertising the stable
# `node` symlink rather than this run's version-stamped directory.
scenario_rerun_is_idempotent() {
    new_case darwin arm64
    seed_managed_install
    printf '\n# >>> conductor install >>>\n# Added by Conductor installer\nexport PATH="$HOME/.conductor/node/bin:$PATH"\n# <<< conductor install <<<\n' \
        > "$RC_FILE"
    cp "$RC_FILE" "${CASE_DIR}/rc.before"

    PATH_EXTRA="${HOME_DIR}/.conductor/node/bin:" run_installer

    assert_managed_node_layout
    if ! diff -q "${CASE_DIR}/rc.before" "$RC_FILE" >/dev/null 2>&1; then
        fail "rc was rewritten on a re-run that changed nothing"
    fi
    assert_not_contains "${CASE_DIR}/output.log" "node-v${NODE_VERSION}-darwin-arm64/bin:" \
        "must advertise ~/.conductor/node/bin, not the version-stamped dir"
    assert_not_contains "${CASE_DIR}/output.log" "Downloading Node.js" "no redundant re-download"
}

# An ordinary user-owned npm (nvm, asdf, a user-writable Homebrew) is left alone: no redirect and
# no ~/.conductor at all.
scenario_user_owned_npm_untouched() {
    new_case darwin arm64
    mkdir -p "${CASE_DIR}/nvm/bin"
    write_npm_stub "${CASE_DIR}/nvm/bin/npm"
    write_node_stub "${CASE_DIR}/nvm/bin/node"

    PATH_EXTRA="${CASE_DIR}/nvm/bin:" run_installer

    assert_exists "${CASE_DIR}/nvm/lib/node_modules/@love-moon/conductor-cli" \
        "CLI installed into the user's own npm prefix"
    assert_absent "$(conductor_home)" "installer did not create ~/.conductor"
}

# ----------------------------------------------------------------------------- main

if [ "${1:-}" = "--list" ]; then
    printf '%s\n' "${SCENARIOS[@]}"
    exit 0
fi

if [ ! -f "$INSTALL_SH" ]; then
    printf 'install.sh not found at %s\n' "$INSTALL_SH" >&2
    exit 1
fi

SANDBOX=$(mktemp -d "${TMPDIR:-/tmp}/conductor-install-sh.XXXXXX")
# The stubs compare against a fully resolved path; on macOS $TMPDIR is itself a symlink.
SANDBOX_REAL=$(cd "$SANDBOX" && pwd -P)
trap 'rm -rf "$SANDBOX"' EXIT

selected=("$@")
if [ ${#selected[@]} -eq 0 ]; then
    selected=("${SCENARIOS[@]}")
fi

for name in "${selected[@]}"; do
    CURRENT="$name"
    PATH_EXTRA=""
    before=$FAILURES

    if ! declare -f "scenario_${name//-/_}" >/dev/null; then
        printf 'FAIL %s: unknown scenario\n' "$name" >&2
        FAILURES=$((FAILURES + 1))
        continue
    fi

    "scenario_${name//-/_}"

    if [ "$FAILURES" -eq "$before" ]; then
        printf 'PASS %s\n' "$name"
    fi
done

if [ "$FAILURES" -ne 0 ]; then
    printf '\n%d assertion(s) failed\n' "$FAILURES" >&2
    exit 1
fi
