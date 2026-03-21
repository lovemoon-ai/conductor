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
        NPM_CMD="npm"
        NODE_CMD="$(command -v node)"
        log_info "Found npm: $(npm --version)"
        return 0
    fi
    return 1
}

# Download and setup temporary Node.js
setup_temp_node() {
    log_info "npm not found. Setting up temporary Node.js environment..."

    mkdir -p "$TEMP_DIR"
    cd "$TEMP_DIR"

    # Construct Node.js download URL
    local node_filename="node-v${NODE_VERSION}-${OS}-${ARCH}.tar.gz"
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

    # Set up temporary npm command
    local node_dir="$TEMP_DIR/node-v${NODE_VERSION}-${OS}-${ARCH}"
    export PATH="$node_dir/bin:$PATH"
    NPM_CMD="$node_dir/bin/npm"
    NODE_CMD="$node_dir/bin/node"

    log_info "Temporary Node.js setup complete: $(node --version)"
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

# Verify installation
verify_installation() {
    log_info "Verifying installation..."

    # Check if conductor-cli is available
    if command -v conductor &> /dev/null; then
        local version=$(conductor --version 2>&1 || echo "unknown")
        log_info "✓ conductor is installed: $version"
        return 0
    else
        log_warn "conductor command not found in PATH"
        log_warn "You may need to add npm global bin directory to your PATH"
        log_warn "Try running: export PATH=\"\$(npm config get prefix)/bin:\$PATH\""
        return 1
    fi
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

    # Check for npm or setup temporary node
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
    local path_ok=0
    local node_pty_ok=0
    verify_installation || path_ok=$?
    verify_node_pty || node_pty_ok=$?

    if [ "$node_pty_ok" -ne 0 ]; then
        echo ""
        log_error "=== Installation Failed ==="
        log_error "Conductor CLI was installed, but node-pty is not usable."
        exit 1
    fi

    if [ "$path_ok" -eq 0 ]; then
        echo ""
        log_info "=== Installation Complete ==="
        log_info "You can now use 'conductor' command"
        log_info "Run 'conductor --help' to get started"
    else
        echo ""
        log_warn "=== Installation Complete (with warnings) ==="
        log_warn "Please add npm global bin directory to your PATH"
    fi
    echo ""
}

# Run main function
main
