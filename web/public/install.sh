#!/usr/bin/env bash
# Conductor CLI Installation Script
# Usage: curl -fsSL https://your-domain.com/install.sh | bash

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
PACKAGE_NAME="@love-moon/conductor-cli"
TEMP_DIR="${HOME}/.conductor-install-tmp"
NODE_VERSION="20.11.0"
NODE_CMD="node"
INSTALL_USE_SUDO=""
ORIGINAL_PATH="$PATH"
LOCAL_NODE_DIR=""
NPM_PREFIX=""
NPM_BIN_DIR=""
PATH_RC_FILE=""
PATH_EXPORT_LINE=""

# Utility functions
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

cleanup() {
    if [ -d "$TEMP_DIR" ]; then
        log_info "Cleaning up temporary files..."
        rm -rf "$TEMP_DIR"
    fi
}

trap cleanup EXIT

# Detect OS and architecture
detect_platform() {
    local os=$(uname -s | tr '[:upper:]' '[:lower:]')
    local arch=$(uname -m)

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

# Check if npm is available
check_npm() {
    if command -v npm &> /dev/null; then
        NPM_CMD="$(command -v npm)"
        NODE_CMD="$(command -v node)"
        log_info "Found npm: $($NPM_CMD --version)"
        log_info "Node path: $NODE_CMD"
        log_info "npm path: $NPM_CMD"
        return 0
    fi
    return 1
}

# Download and setup local Node.js
setup_temp_node() {
    log_info "npm not found. Setting up local Node.js environment..."

    local node_basename="node-v${NODE_VERSION}-${OS}-${ARCH}"
    LOCAL_NODE_DIR="${HOME}/.conductor/${node_basename}"
    mkdir -p "${HOME}/.conductor"

    if [ -x "$LOCAL_NODE_DIR/bin/node" ] && [ -x "$LOCAL_NODE_DIR/bin/npm" ]; then
        log_info "Using existing local Node.js: $LOCAL_NODE_DIR"
    else
        mkdir -p "$TEMP_DIR"
        cd "$TEMP_DIR"

        # Construct Node.js download URL
        local node_filename="${node_basename}.tar.gz"
        local node_url="https://nodejs.org/dist/v${NODE_VERSION}/${node_filename}"

        log_info "Downloading Node.js ${NODE_VERSION}..."
        if command -v curl &> /dev/null; then
            curl -fsSL "$node_url" -o "$node_filename"
        elif command -v wget &> /dev/null; then
            wget -q "$node_url" -O "$node_filename"
        else
            log_error "Neither curl nor wget found. Please install one of them."
            exit 1
        fi

        log_info "Extracting Node.js..."
        tar -xzf "$node_filename"

        log_info "Installing Node.js to $LOCAL_NODE_DIR..."
        rm -rf "$LOCAL_NODE_DIR"
        mv "$TEMP_DIR/$node_basename" "$LOCAL_NODE_DIR"
    fi

    export PATH="$LOCAL_NODE_DIR/bin:$PATH"
    NPM_CMD="$LOCAL_NODE_DIR/bin/npm"
    NODE_CMD="$LOCAL_NODE_DIR/bin/node"

    log_info "Local Node.js setup complete: $($NODE_CMD --version)"
    log_info "Node path: $NODE_CMD"
    log_info "npm path: $NPM_CMD"
}

# Install conductor-cli
install_conductor() {
    log_info "Installing ${PACKAGE_NAME}..."

    # Check write permission for global installation
    local npm_prefix=$("$NPM_CMD" config get prefix)
    if [ ! -w "$npm_prefix" ] && [ "$EUID" -ne 0 ]; then
        log_warn "No write permission to $npm_prefix. Attempting to use sudo..."
        if command -v sudo &> /dev/null; then
            INSTALL_USE_SUDO="sudo"
        else
            log_error "sudo not found and no write permission to $npm_prefix."
            log_error "Please run this script as root or fix npm permissions."
            return 1
        fi
    fi

    # Try to install
    if [ -n "$INSTALL_USE_SUDO" ]; then
        if $INSTALL_USE_SUDO "$NPM_CMD" install -g "${PACKAGE_NAME}@latest"; then
            log_info "Successfully installed ${PACKAGE_NAME}"
            return 0
        fi
    else
        if "$NPM_CMD" install -g "${PACKAGE_NAME}@latest"; then
            log_info "Successfully installed ${PACKAGE_NAME}"
            return 0
        fi
    fi

    log_warn "Global installation failed. Trying with --force flag..."
    if [ -n "$INSTALL_USE_SUDO" ]; then
        if $INSTALL_USE_SUDO "$NPM_CMD" install -g --force "${PACKAGE_NAME}@latest"; then
            log_info "Successfully installed ${PACKAGE_NAME} with --force"
            return 0
        fi
    else
        if "$NPM_CMD" install -g --force "${PACKAGE_NAME}@latest"; then
            log_info "Successfully installed ${PACKAGE_NAME} with --force"
            return 0
        fi
    fi

    log_error "Failed to install ${PACKAGE_NAME}"
    return 1
}

detect_shell_rc_file() {
    local shell_name
    shell_name=$(basename "${SHELL:-}")

    case "$shell_name" in
        zsh)
            PATH_RC_FILE="${HOME}/.zshrc"
            PATH_EXPORT_LINE="export PATH=\"$NPM_BIN_DIR:\$PATH\""
            ;;
        bash)
            if [ -f "${HOME}/.bash_profile" ]; then
                PATH_RC_FILE="${HOME}/.bash_profile"
            elif [ -f "${HOME}/.bash_login" ]; then
                PATH_RC_FILE="${HOME}/.bash_login"
            elif [ -f "${HOME}/.profile" ]; then
                PATH_RC_FILE="${HOME}/.profile"
            elif [ -f "${HOME}/.bashrc" ]; then
                PATH_RC_FILE="${HOME}/.bashrc"
            else
                PATH_RC_FILE="${HOME}/.profile"
            fi
            PATH_EXPORT_LINE="export PATH=\"$NPM_BIN_DIR:\$PATH\""
            ;;
        fish)
            PATH_RC_FILE="${HOME}/.config/fish/config.fish"
            PATH_EXPORT_LINE="set -gx PATH \"$NPM_BIN_DIR\" \$PATH"
            ;;
        *)
            PATH_RC_FILE="${HOME}/.profile"
            PATH_EXPORT_LINE="export PATH=\"$NPM_BIN_DIR:\$PATH\""
            ;;
    esac
}

prompt_write_path_to_rc() {
    if [ -z "$NPM_BIN_DIR" ]; then
        log_warn "npm global bin directory is empty; skipping PATH update prompt"
        return 1
    fi

    detect_shell_rc_file

    if [ -f "$PATH_RC_FILE" ] && grep -Fqx "$PATH_EXPORT_LINE" "$PATH_RC_FILE"; then
        log_info "PATH entry already exists in $PATH_RC_FILE"
        return 0
    fi

    if [ ! -r /dev/tty ] || [ ! -w /dev/tty ]; then
        log_warn "No interactive terminal detected; cannot prompt to update PATH"
        log_warn "Add this line to $PATH_RC_FILE:"
        log_warn "$PATH_EXPORT_LINE"
        return 1
    fi

    printf "\n${YELLOW}[WARN]${NC} conductor is not on your default PATH\n" > /dev/tty
    printf "${YELLOW}[WARN]${NC} Add %s to %s ? [Y/n] " "$NPM_BIN_DIR" "$PATH_RC_FILE" > /dev/tty

    local answer=""
    read -r answer < /dev/tty || true
    case "$answer" in
        n|N|no|No|NO)
            log_warn "Skipped PATH update"
            return 1
            ;;
    esac

    local rc_dir
    rc_dir=$(dirname "$PATH_RC_FILE")
    if ! mkdir -p "$rc_dir"; then
        log_warn "Failed to create directory for $PATH_RC_FILE"
        return 1
    fi

    if [ ! -f "$PATH_RC_FILE" ] && ! touch "$PATH_RC_FILE"; then
        log_warn "Failed to create $PATH_RC_FILE"
        return 1
    fi

    if ! printf '\n%s\n' "$PATH_EXPORT_LINE" >> "$PATH_RC_FILE"; then
        log_warn "Failed to update $PATH_RC_FILE"
        return 1
    fi

    log_info "Added PATH entry to $PATH_RC_FILE"
    log_info "Run: source \"$PATH_RC_FILE\" (or reopen your terminal)"
    return 0
}

# Verify installation
verify_installation() {
    log_info "Verifying installation..."

    NPM_PREFIX=$("$NPM_CMD" config get prefix 2>/dev/null || true)
    if [ -z "$NPM_PREFIX" ]; then
        log_warn "Could not determine npm global prefix"
        return 1
    fi

    NPM_BIN_DIR="$NPM_PREFIX/bin"
    local conductor_bin="$NPM_BIN_DIR/conductor"
    if [ ! -x "$conductor_bin" ]; then
        detect_shell_rc_file
        log_warn "conductor command not found at $conductor_bin"
        log_warn "You may need to add npm global bin directory to your PATH"
        log_warn "Add this line to $PATH_RC_FILE:"
        log_warn "$PATH_EXPORT_LINE"
        return 1
    fi

    log_info "Node path: $NODE_CMD"
    log_info "npm path: $NPM_CMD"
    log_info "conductor path: $conductor_bin"

    local version
    if version=$(PATH="$NPM_BIN_DIR:$PATH" "$conductor_bin" --version 2>&1); then
        log_info "✓ conductor is installed: $version"
    else
        log_warn "conductor is installed but failed to run"
        log_warn "$version"
        return 1
    fi

    if [[ ":$ORIGINAL_PATH:" == *":$NPM_BIN_DIR:"* ]]; then
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

    local package_dir="$npm_root/$PACKAGE_NAME"
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

# Main installation flow
main() {
    echo ""
    log_info "=== Conductor CLI Installation ==="
    echo ""

    # Detect platform
    detect_platform

    # Check for npm or setup local Node.js
    if check_npm; then
        log_info "Using system npm"
    else
        setup_temp_node
    fi

    # Install conductor-cli
    if ! install_conductor; then
        log_error "Installation failed"
        exit 1
    fi

    # Verify installation
    echo ""
    local path_status=0
    local node_pty_ok=0
    verify_installation || path_status=$?
    verify_node_pty || node_pty_ok=$?

    if [ "$node_pty_ok" -ne 0 ]; then
        echo ""
        log_error "=== Installation Failed ==="
        log_error "Conductor CLI was installed, but node-pty is not usable."
        exit 1
    fi

    if [ "$path_status" -eq 2 ]; then
        prompt_write_path_to_rc && path_status=3
    fi

    if [ "$path_status" -eq 0 ]; then
        echo ""
        log_info "=== Installation Complete ==="
        log_info "You can now use 'conductor' command"
        log_info "Run 'conductor --help' to get started"
    elif [ "$path_status" -eq 3 ]; then
        echo ""
        log_info "=== Installation Complete ==="
        log_info "You can now use 'conductor' command"
        log_info "Open a new terminal or run: source \"$PATH_RC_FILE\""
    else
        echo ""
        log_warn "=== Installation Complete (with warnings) ==="
        log_warn "Please add npm global bin directory to your PATH"
        if [ -n "$NPM_BIN_DIR" ]; then
            detect_shell_rc_file
            log_warn "Add this line to $PATH_RC_FILE:"
            log_warn "$PATH_EXPORT_LINE"
        fi
    fi
    echo ""
}

# Run main function
main
