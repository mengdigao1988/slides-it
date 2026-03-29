#!/usr/bin/env bash
# install.sh — Install slides-it
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/slides-it/slides-it/main/install.sh | bash
#
# What this does:
#   1. Detects your platform and architecture
#   2. Checks that opencode is installed (installs it if not)
#   3. Downloads the matching slides-it binary from the latest GitHub Release
#   4. Installs it to ~/.local/bin/slides-it

set -euo pipefail

REPO="mengdigao1988/slides-it"
INSTALL_DIR="${HOME}/.local/bin"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

info()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m ✓\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33mWARN\033[0m %s\n' "$*" >&2; }
die()   { printf '\033[1;31mERROR\033[0m %s\n' "$*" >&2; exit 1; }

need() {
    command -v "$1" >/dev/null 2>&1 || die "$1 is required but not found. Please install it first."
}

# ---------------------------------------------------------------------------
# 1. Detect platform
# ---------------------------------------------------------------------------

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
    Darwin)
        case "$ARCH" in
            arm64)  ARTIFACT="slides-it-macos-arm64" ;;
            x86_64) ARTIFACT="slides-it-macos-x86_64" ;;
            *)      die "Unsupported macOS architecture: $ARCH" ;;
        esac
        ;;
    Linux)
        case "$ARCH" in
            x86_64) ARTIFACT="slides-it-linux-x86_64" ;;
            *)      die "Unsupported Linux architecture: $ARCH (only x86_64 is supported)" ;;
        esac
        ;;
    *)
        die "Unsupported operating system: $OS"
        ;;
esac

info "Platform: $OS $ARCH → $ARTIFACT"

# ---------------------------------------------------------------------------
# 2. Check for required tools
# ---------------------------------------------------------------------------

need curl

# ---------------------------------------------------------------------------
# 3. Check / install opencode
# ---------------------------------------------------------------------------

if command -v opencode >/dev/null 2>&1; then
    ok "opencode is already installed ($(opencode --version 2>/dev/null | head -1 || echo 'version unknown'))"
else
    info "opencode not found — installing..."
    curl -fsSL https://opencode.ai/install | bash
    # Re-source PATH in case the installer added ~/.local/bin etc.
    export PATH="${HOME}/.local/bin:${PATH}"
    if command -v opencode >/dev/null 2>&1; then
        ok "opencode installed"
    else
        warn "opencode may not be on PATH yet. You may need to restart your shell."
    fi
fi

# ---------------------------------------------------------------------------
# 4. Resolve latest release tag from GitHub API
# ---------------------------------------------------------------------------

info "Fetching latest slides-it release..."

LATEST_TAG="$(
    curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | grep '"tag_name"' \
    | head -1 \
    | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/'
)"

if [ -z "$LATEST_TAG" ]; then
    die "Could not determine latest release tag. Check https://github.com/${REPO}/releases"
fi

ok "Latest release: $LATEST_TAG"

DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${LATEST_TAG}/${ARTIFACT}"

# ---------------------------------------------------------------------------
# 5. Download binary
# ---------------------------------------------------------------------------

info "Downloading ${ARTIFACT}..."

TMP_FILE="$(mktemp)"
# shellcheck disable=SC2064
trap "rm -f '${TMP_FILE}'" EXIT

if ! curl -fsSL --progress-bar -o "$TMP_FILE" "$DOWNLOAD_URL"; then
    die "Download failed: $DOWNLOAD_URL"
fi

# ---------------------------------------------------------------------------
# 6. Install to ~/.local/bin
# ---------------------------------------------------------------------------

mkdir -p "$INSTALL_DIR"
DEST="${INSTALL_DIR}/slides-it"
mv "$TMP_FILE" "$DEST"
chmod +x "$DEST"

ok "Installed: $DEST"

# Symlink to /usr/local/bin for universal PATH availability
# (works across all shells and terminal emulators without sourcing any profile)
if [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
    ln -sf "$DEST" /usr/local/bin/slides-it
    ok "Symlinked to /usr/local/bin/slides-it"
fi

# Symlink opencode too if it's in ~/.local/bin
if [ -f "${HOME}/.local/bin/opencode" ]; then
    if [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
        ln -sf "${HOME}/.local/bin/opencode" /usr/local/bin/opencode
        ok "Symlinked opencode to /usr/local/bin/opencode"
    fi
fi

# ---------------------------------------------------------------------------
# 7. PATH check — write shell profile as fallback
# ---------------------------------------------------------------------------

# Detect shell profile
SHELL_NAME="$(basename "${SHELL:-bash}")"
if [ "$SHELL_NAME" = "zsh" ]; then
    PROFILE="${HOME}/.zshrc"
elif [ "$SHELL_NAME" = "bash" ]; then
    if [ -f "${HOME}/.bash_profile" ]; then
        PROFILE="${HOME}/.bash_profile"
    else
        PROFILE="${HOME}/.bashrc"
    fi
else
    PROFILE="${HOME}/.profile"
fi

LINE='export PATH="$HOME/.local/bin:$PATH"'

# Check profile file contents (not current $PATH which may be polluted by sub-shells)
if ! grep -qF '.local/bin' "$PROFILE" 2>/dev/null; then
    printf '\n# Added by slides-it installer\n%s\n' "$LINE" >> "$PROFILE"
    ok "Added ~/.local/bin to PATH in $PROFILE"
    echo ""
    echo "  Run this to apply in the current terminal:"
    echo ""
    echo "    source $PROFILE"
    echo ""
    echo "  (New terminals will work automatically)"
    echo ""
else
    ok "~/.local/bin already configured in $PROFILE"
fi

# ---------------------------------------------------------------------------
# 8. Done
# ---------------------------------------------------------------------------

echo ""
printf '\033[1;32mslides-it %s installed successfully!\033[0m\n' "$LATEST_TAG"
echo ""
echo "  Get started:"
echo "    slides-it            # launch the web UI"
echo "    slides-it --help     # show all commands"
echo "    slides-it --version  # show version"
echo ""
