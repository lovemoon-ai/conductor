#!/usr/bin/env bash

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PACKAGE_NAME="@love-moon/conductor-cli"
CONDUCTOR_HOME="${HOME}/.conductor"
NODE_VERSION="20.11.0"
NODE_CMD="node"
NPM_CMD="npm"
INSTALL_USE_SUDO=""
ORIGINAL_PATH="$PATH"
USED_CONDUCTOR_NODE=0
NODE_INSTALL_DIR=""
NODE_LINK_DIR="${CONDUCTOR_HOME}/node"
NODE_BIN_DIR=""
NPM_GLOBAL_PREFIX=""
GLOBAL_BIN_DIR=""
RC_FILE=""
RC_SHELL=""
USE_LOCAL_NPM_PREFIX=0
PATH_BLOCK_START="# >>> conductor install >>>"
PATH_BLOCK_END="# <<< conductor install <<<"

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

print_installed_paths() {
    local node_path=""
    local npm_path=""
    local conductor_path=""

    if [ -n "$NODE_CMD" ] && [ -x "$NODE_CMD" ]; then
        node_path="$NODE_CMD"
    elif command -v node >/dev/null 2>&1; then
        node_path="$(command -v node)"
    fi

    if [ -n "$NPM_CMD" ] && [ -x "$NPM_CMD" ]; then
        npm_path="$NPM_CMD"
    elif command -v npm >/dev/null 2>&1; then
        npm_path="$(command -v npm)"
    fi

    if [ -n "$GLOBAL_BIN_DIR" ] && [ -x "$GLOBAL_BIN_DIR/conductor" ]; then
        conductor_path="$GLOBAL_BIN_DIR/conductor"
    elif command -v conductor >/dev/null 2>&1; then
        conductor_path="$(command -v conductor)"
    fi

    log_info "Resolved paths:"
    log_info "  node: ${node_path:-not found}"
    log_info "  npm: ${npm_path:-not found}"
    log_info "  conductor: ${conductor_path:-not found}"
}

detect_platform() {
    local os
    local arch
    os=$(uname -s | tr '[:upper:]' '[:lower:]')
    arch=$(uname -m)

    case "$os" in
        darwin)
            OS="darwin"
            ;;
        linux)
            OS="linux"
            ;;
        *)
            log_error "Unsupported operating system: $os"
            log_error "Conductor CLI supports macOS and Linux only."
            exit 1
            ;;
    esac

    case "$arch" in
        x86_64|amd64)
            ARCH="x64"
            ;;
        arm64|aarch64)
            ARCH="arm64"
            ;;
        *)
            log_error "Unsupported architecture: $arch"
            log_error "Conductor CLI supports x64 and arm64 only."
            exit 1
            ;;
    esac

    log_info "Detected platform: $OS-$ARCH"
}

prepend_path_if_missing() {
    local directory="$1"

    if [ -z "$directory" ] || [ ! -d "$directory" ]; then
        return
    fi

    case ":$PATH:" in
        *":$directory:"*)
            ;;
        *)
            export PATH="$directory:$PATH"
            ;;
    esac
}

refresh_runtime_paths() {
    if [ -n "$NODE_CMD" ] && [ -x "$NODE_CMD" ]; then
        NODE_BIN_DIR=$(cd "$(dirname "$NODE_CMD")" && pwd -P)
    fi

    if [ -n "$NPM_CMD" ] && [ -x "$NPM_CMD" ]; then
        if [ "$USE_LOCAL_NPM_PREFIX" -eq 1 ] && [ -n "${npm_config_prefix:-}" ]; then
            NPM_GLOBAL_PREFIX="$npm_config_prefix"
        else
            NPM_GLOBAL_PREFIX=$("$NPM_CMD" config get prefix 2>/dev/null || true)
        fi
        if [ -n "$NPM_GLOBAL_PREFIX" ]; then
            GLOBAL_BIN_DIR="${NPM_GLOBAL_PREFIX}/bin"
        else
            GLOBAL_BIN_DIR=""
        fi
    fi

    prepend_path_if_missing "$NODE_BIN_DIR"
    prepend_path_if_missing "$GLOBAL_BIN_DIR"
}

build_runtime_path() {
    local runtime_path="$ORIGINAL_PATH"

    if [ -n "$NODE_BIN_DIR" ] && [ -d "$NODE_BIN_DIR" ]; then
        runtime_path="${NODE_BIN_DIR}:${runtime_path}"
    fi

    if [ -n "$GLOBAL_BIN_DIR" ] && [ -d "$GLOBAL_BIN_DIR" ]; then
        runtime_path="${GLOBAL_BIN_DIR}:${runtime_path}"
    fi

    printf '%s' "$runtime_path"
}

check_npm() {
    if command -v npm >/dev/null 2>&1; then
        NPM_CMD="$(command -v npm)"
        NODE_CMD="$(command -v node)"
        refresh_runtime_paths
        log_info "Found npm: $("$NPM_CMD" --version)"
        log_info "Node path: $NODE_CMD"
        log_info "npm path: $NPM_CMD"
        return 0
    fi

    return 1
}

is_system_npm_prefix() {
    local prefix="$1"

    case "$prefix" in
        /usr|/usr/*|/usr/local|/usr/local/*|/opt|/opt/*|/var/lib|/var/lib/*)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

configure_local_npm_prefix() {
    mkdir -p "$CONDUCTOR_HOME"
    export npm_config_prefix="$CONDUCTOR_HOME"
    USE_LOCAL_NPM_PREFIX=1
    INSTALL_USE_SUDO=""
    NPM_GLOBAL_PREFIX="$CONDUCTOR_HOME"
    GLOBAL_BIN_DIR="${CONDUCTOR_HOME}/bin"
    refresh_runtime_paths
    log_info "Using local npm prefix: ${CONDUCTOR_HOME}"
}

maybe_switch_to_local_npm_prefix() {
    local npm_prefix="$1"
    local prompt_status=0

    if [ "$OS" != "linux" ] || [ "$USED_CONDUCTOR_NODE" -eq 1 ]; then
        return
    fi

    if ! is_system_npm_prefix "$npm_prefix"; then
        return
    fi

    log_warn "npm global prefix points to a system path: ${npm_prefix}"
    log_warn "Installing there may require root permissions."

    if prompt_yes_no "Install Conductor to ${CONDUCTOR_HOME} instead (recommended)?"; then
        prompt_status=0
    else
        prompt_status=$?
    fi

    if [ "$prompt_status" -eq 0 ]; then
        configure_local_npm_prefix
        return
    fi

    if [ "$prompt_status" -eq 2 ]; then
        log_warn "No interactive terminal available. Falling back to local npm prefix."
        configure_local_npm_prefix
        return
    fi

    log_warn "Continuing with the system npm prefix at your request."
}

setup_conductor_node() {
    log_info "npm not found. Setting up Conductor-managed Node.js in ${CONDUCTOR_HOME}..."

    mkdir -p "$CONDUCTOR_HOME"

    local node_filename="node-v${NODE_VERSION}-${OS}-${ARCH}.tar.gz"
    local node_url="https://nodejs.org/dist/v${NODE_VERSION}/${node_filename}"
    local archive_path="${CONDUCTOR_HOME}/${node_filename}"
    NODE_INSTALL_DIR="${CONDUCTOR_HOME}/node-v${NODE_VERSION}-${OS}-${ARCH}"

    if [ ! -x "${NODE_INSTALL_DIR}/bin/node" ]; then
        log_info "Downloading Node.js ${NODE_VERSION}..."
        if command -v curl >/dev/null 2>&1; then
            curl -fsSL "$node_url" -o "$archive_path"
        elif command -v wget >/dev/null 2>&1; then
            wget -q "$node_url" -O "$archive_path"
        else
            log_error "Neither curl nor wget found. Please install one of them."
            exit 1
        fi

        log_info "Extracting Node.js into ${CONDUCTOR_HOME}..."
        rm -rf "$NODE_INSTALL_DIR"
        tar -xzf "$archive_path" -C "$CONDUCTOR_HOME"
        rm -f "$archive_path"
    else
        log_info "Reusing existing Node.js at ${NODE_INSTALL_DIR}"
    fi

    if [ -L "$NODE_LINK_DIR" ] || [ ! -e "$NODE_LINK_DIR" ]; then
        ln -sfn "$NODE_INSTALL_DIR" "$NODE_LINK_DIR"
    else
        rm -rf "$NODE_LINK_DIR"
        ln -sfn "$NODE_INSTALL_DIR" "$NODE_LINK_DIR"
    fi

    export npm_config_prefix="$CONDUCTOR_HOME"
    NPM_CMD="${NODE_LINK_DIR}/bin/npm"
    NODE_CMD="${NODE_LINK_DIR}/bin/node"
    USED_CONDUCTOR_NODE=1
    refresh_runtime_paths

    log_info "Conductor-managed Node.js ready: $("$NODE_CMD" --version)"
    log_info "Node path: $NODE_CMD"
    log_info "npm path: $NPM_CMD"
}

install_conductor() {
    log_info "Installing ${PACKAGE_NAME}..."

    local npm_prefix
    if [ "$USE_LOCAL_NPM_PREFIX" -eq 1 ] && [ -n "${npm_config_prefix:-}" ]; then
        npm_prefix="$npm_config_prefix"
    else
        npm_prefix=$("$NPM_CMD" config get prefix)
        maybe_switch_to_local_npm_prefix "$npm_prefix"
        if [ "$USE_LOCAL_NPM_PREFIX" -eq 1 ] && [ -n "${npm_config_prefix:-}" ]; then
            npm_prefix="$npm_config_prefix"
        fi
    fi
    NPM_GLOBAL_PREFIX="$npm_prefix"
    GLOBAL_BIN_DIR="${NPM_GLOBAL_PREFIX}/bin"
    refresh_runtime_paths

    if [ ! -w "$npm_prefix" ] && [ "$EUID" -ne 0 ]; then
        log_warn "No write permission to $npm_prefix. Attempting to use sudo..."
        if command -v sudo >/dev/null 2>&1; then
            INSTALL_USE_SUDO="sudo"
        else
            log_error "sudo not found and no write permission to $npm_prefix."
            log_error "Please run this script as root or fix npm permissions."
            return 1
        fi
    fi

    if [ -n "$INSTALL_USE_SUDO" ]; then
        if $INSTALL_USE_SUDO "$NPM_CMD" install -g "${PACKAGE_NAME}@latest"; then
            log_info "Successfully installed ${PACKAGE_NAME}"
            refresh_runtime_paths
            return 0
        fi
    else
        if "$NPM_CMD" install -g "${PACKAGE_NAME}@latest"; then
            log_info "Successfully installed ${PACKAGE_NAME}"
            refresh_runtime_paths
            return 0
        fi
    fi

    log_warn "Global installation failed. Trying with --force flag..."
    if [ -n "$INSTALL_USE_SUDO" ]; then
        if $INSTALL_USE_SUDO "$NPM_CMD" install -g --force "${PACKAGE_NAME}@latest"; then
            log_info "Successfully installed ${PACKAGE_NAME} with --force"
            refresh_runtime_paths
            return 0
        fi
    else
        if "$NPM_CMD" install -g --force "${PACKAGE_NAME}@latest"; then
            log_info "Successfully installed ${PACKAGE_NAME} with --force"
            refresh_runtime_paths
            return 0
        fi
    fi

    log_error "Failed to install ${PACKAGE_NAME}"
    return 1
}

resolve_rc_file() {
    if [ -n "$CONDUCTOR_INSTALL_RC_FILE" ]; then
        RC_FILE="$CONDUCTOR_INSTALL_RC_FILE"
        case "$RC_FILE" in
            *.fish|*/fish/config.fish)
                RC_SHELL="fish"
                ;;
            *)
                RC_SHELL="sh"
                ;;
        esac
        return
    fi

    local shell_name
    shell_name=$(basename "${SHELL:-}")

    case "$shell_name" in
        fish)
            RC_FILE="${HOME}/.config/fish/config.fish"
            RC_SHELL="fish"
            ;;
        zsh)
            RC_FILE="${HOME}/.zshrc"
            RC_SHELL="sh"
            ;;
        bash)
            RC_SHELL="sh"
            if [ "$OS" = "darwin" ]; then
                if [ -f "${HOME}/.bash_profile" ]; then
                    RC_FILE="${HOME}/.bash_profile"
                elif [ -f "${HOME}/.bash_login" ]; then
                    RC_FILE="${HOME}/.bash_login"
                elif [ -f "${HOME}/.profile" ]; then
                    RC_FILE="${HOME}/.profile"
                else
                    RC_FILE="${HOME}/.bash_profile"
                fi
            else
                if [ -f "${HOME}/.bashrc" ]; then
                    RC_FILE="${HOME}/.bashrc"
                elif [ -f "${HOME}/.profile" ]; then
                    RC_FILE="${HOME}/.profile"
                elif [ -f "${HOME}/.bash_profile" ]; then
                    RC_FILE="${HOME}/.bash_profile"
                else
                    RC_FILE="${HOME}/.bashrc"
                fi
            fi
            ;;
        *)
            RC_FILE="${HOME}/.profile"
            RC_SHELL="sh"
            ;;
    esac
}

build_path_export_line() {
    local node_path=""
    local conductor_bin_path=""

    if [ -z "$RC_FILE" ] || [ -z "$RC_SHELL" ]; then
        resolve_rc_file
    fi

    if [ "$USED_CONDUCTOR_NODE" -eq 1 ]; then
        node_path='$HOME/.conductor/node/bin'
        conductor_bin_path='$HOME/.conductor/bin'
    else
        if [ "$USE_LOCAL_NPM_PREFIX" -eq 1 ]; then
            node_path=""
            conductor_bin_path='$HOME/.conductor/bin'
        else
            node_path="$NODE_BIN_DIR"
            conductor_bin_path="$GLOBAL_BIN_DIR"
        fi
    fi

    if [ "$RC_SHELL" = "fish" ]; then
        local line="set -gx PATH"

        if [ -n "$node_path" ]; then
            line="${line} \"$node_path\""
        fi
        if [ -n "$conductor_bin_path" ]; then
            line="${line} \"$conductor_bin_path\""
        fi

        if [ "$line" = "set -gx PATH" ]; then
            return
        fi

        line="${line} \$PATH"
        printf '%s' "$line"
        return
    fi

    local segments=""
    if [ -n "$node_path" ]; then
        segments="${segments}${node_path}:"
    fi
    if [ -n "$conductor_bin_path" ]; then
        segments="${segments}${conductor_bin_path}:"
    fi

    if [ -z "$segments" ]; then
        return
    fi

    printf 'export PATH="%s$PATH"' "$segments"
}

build_npm_prefix_export_line() {
    if [ "$USE_LOCAL_NPM_PREFIX" -ne 1 ]; then
        return
    fi

    if [ -z "$RC_FILE" ] || [ -z "$RC_SHELL" ]; then
        resolve_rc_file
    fi

    if [ "$RC_SHELL" = "fish" ]; then
        printf 'set -gx npm_config_prefix "$HOME/.conductor"'
        return
    fi

    printf 'export npm_config_prefix="$HOME/.conductor"'
}

build_shell_setup_block() {
    local prefix_line=""
    local path_line=""

    prefix_line=$(build_npm_prefix_export_line)
    path_line=$(build_path_export_line)

    if [ -n "$prefix_line" ]; then
        printf '%s\n' "$prefix_line"
    fi
    if [ -n "$path_line" ]; then
        printf '%s\n' "$path_line"
    fi
}

verify_installation() {
    log_info "Verifying installation..."
    refresh_runtime_paths

    local conductor_bin=""
    if [ -n "$GLOBAL_BIN_DIR" ] && [ -x "$GLOBAL_BIN_DIR/conductor" ]; then
        conductor_bin="$GLOBAL_BIN_DIR/conductor"
    elif command -v conductor >/dev/null 2>&1; then
        conductor_bin="$(command -v conductor)"
    fi

    if [ -z "$conductor_bin" ]; then
        log_warn "conductor command not found after installation"
        local export_line
        export_line=$(build_path_export_line)
        if [ -n "$export_line" ]; then
            log_warn "Add Conductor to your PATH with:"
            log_warn "  $export_line"
        fi
        return 1
    fi

    local runtime_path
    runtime_path=$(build_runtime_path)

    local version
    if version=$(PATH="$runtime_path" "$conductor_bin" --version 2>&1); then
        log_info "✓ conductor is installed: $version"
    else
        log_warn "conductor is installed but failed to run"
        log_warn "$version"
        return 1
    fi

    if PATH="$ORIGINAL_PATH" conductor --version >/dev/null 2>&1; then
        return 0
    fi

    return 2
}

verify_node_pty() {
    log_info "Rebuilding native dependencies..."
    if [ -n "$INSTALL_USE_SUDO" ]; then
        if ! $INSTALL_USE_SUDO "$NPM_CMD" rebuild -g "${PACKAGE_NAME}"; then
            log_error "Failed to rebuild native dependencies for ${PACKAGE_NAME}"
            return 1
        fi
    else
        if ! "$NPM_CMD" rebuild -g "${PACKAGE_NAME}"; then
            log_error "Failed to rebuild native dependencies for ${PACKAGE_NAME}"
            return 1
        fi
    fi

    log_info "Verifying node-pty native binding..."

    local npm_root
    npm_root=$("$NPM_CMD" root -g 2>/dev/null || true)
    if [ -z "$npm_root" ]; then
        log_warn "Could not determine npm global root; skipping node-pty verification"
        return 0
    fi

    local package_dir="${npm_root}/${PACKAGE_NAME}"
    if [ ! -d "$package_dir" ]; then
        log_warn "Global package directory not found at $package_dir; skipping node-pty verification"
        return 0
    fi

    if "$NODE_CMD" "$package_dir/bin/conductor-verify-node-pty.js" "$package_dir"; then
        log_info "✓ node-pty native binding is available"
        return 0
    fi

    log_error "node-pty native binding failed to load"
    log_error "Please ensure native build tools are installed and npm scripts are enabled"
    return 1
}

rc_contains_current_path_setup() {
    if [ ! -f "$RC_FILE" ]; then
        return 1
    fi

    local block
    block=$(build_shell_setup_block)
    if [ -z "$block" ]; then
        return 1
    fi

    if ! grep -Fq "$PATH_BLOCK_START" "$RC_FILE" \
        || ! grep -Fq "$PATH_BLOCK_END" "$RC_FILE"; then
        return 1
    fi

    local line
    while IFS= read -r line; do
        [ -z "$line" ] && continue
        if ! grep -Fq "$line" "$RC_FILE"; then
            return 1
        fi
    done <<EOF
$block
EOF

    return 0
}

remove_existing_path_block() {
    if [ ! -f "$RC_FILE" ]; then
        return
    fi

    local temp_file="${RC_FILE}.conductor.$$"
    awk -v start="$PATH_BLOCK_START" -v end="$PATH_BLOCK_END" '
        $0 == start { skipping = 1; next }
        $0 == end { skipping = 0; next }
        !skipping { print }
    ' "$RC_FILE" > "$temp_file"
    mv "$temp_file" "$RC_FILE"
}

write_path_to_rc() {
    mkdir -p "$(dirname "$RC_FILE")"
    touch "$RC_FILE"
    remove_existing_path_block

    local block
    block=$(build_shell_setup_block)
    {
        printf '\n%s\n' "$PATH_BLOCK_START"
        printf '# Added by Conductor installer\n'
        printf '%s\n' "$block"
        printf '%s\n' "$PATH_BLOCK_END"
    } >> "$RC_FILE"
}

prompt_yes_no() {
    local prompt="$1"
    local reply

    if [ -n "${CI:-}" ] || [ -n "${CONDUCTOR_INSTALL_NONINTERACTIVE:-}" ]; then
        return 2
    fi

    if [ ! -t 0 ] || [ ! -t 1 ] || [ ! -r /dev/tty ] || [ ! -w /dev/tty ]; then
        return 2
    fi

    printf '%s [Y/n] ' "$prompt" > /dev/tty
    if ! read -r reply < /dev/tty; then
        return 2
    fi

    case "$reply" in
        ""|y|Y|yes|YES|Yes)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

print_manual_path_instructions() {
    local block
    block=$(build_shell_setup_block)
    if [ -z "$block" ]; then
        return
    fi

    resolve_rc_file
    log_info "Add the following lines to ${RC_FILE}:"
    printf '%s\n' "$block"
}

offer_path_setup() {
    local path_status="$1"
    local prompt_status=0

    if [ "$path_status" -ne 2 ] && [ "$USE_LOCAL_NPM_PREFIX" -ne 1 ]; then
        return
    fi

    resolve_rc_file
    if rc_contains_current_path_setup; then
        log_info "Shell setup is already configured in ${RC_FILE}"
        log_info "Open a new shell or run 'source ${RC_FILE}' to use it"
        return
    fi

    if prompt_yes_no "Write Conductor shell setup to ${RC_FILE}?"; then
        prompt_status=0
    else
        prompt_status=$?
    fi

    if [ "$prompt_status" -eq 0 ]; then
        write_path_to_rc
        log_info "Wrote Conductor shell setup to ${RC_FILE}"
        log_info "Run 'source ${RC_FILE}' or open a new shell to use it"
        return
    fi

    if [ "$prompt_status" -eq 2 ]; then
        log_warn "No interactive terminal available to update PATH automatically."
    else
        log_warn "Skipping shell rc update at your request."
    fi
    print_manual_path_instructions
}

main() {
    echo ""
    log_info "=== Conductor CLI Installation ==="
    echo ""

    detect_platform

    if check_npm; then
        log_info "Using system npm"
    else
        setup_conductor_node
    fi

    if ! install_conductor; then
        echo ""
        print_installed_paths
        log_error "=== Installation Failed ==="
        log_error "Failed to install Conductor CLI."
        exit 1
    fi

    echo ""
    local path_status=0
    local node_pty_ok=0
    verify_installation || path_status=$?
    verify_node_pty || node_pty_ok=$?

    if [ "$path_status" -eq 1 ]; then
        echo ""
        print_installed_paths
        log_error "=== Installation Failed ==="
        log_error "Conductor CLI was installed, but the command could not be verified."
        exit 1
    fi

    if [ "$node_pty_ok" -ne 0 ]; then
        echo ""
        print_installed_paths
        log_error "=== Installation Failed ==="
        log_error "Conductor CLI was installed, but node-pty is not usable."
        exit 1
    fi

    offer_path_setup "$path_status"

    echo ""
    print_installed_paths
    log_info "=== Installation Complete ==="
    if [ "$USED_CONDUCTOR_NODE" -eq 1 ]; then
        log_info "Conductor-managed runtime lives in ${CONDUCTOR_HOME}"
    fi
    log_info "You can now use 'conductor' command"
    log_info "Run 'conductor --help' to get started"
    echo ""
}

main
