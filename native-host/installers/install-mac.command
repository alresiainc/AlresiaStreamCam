#!/bin/bash
# ╔══════════════════════════════════════════════════════════╗
# ║  StreamCam — One-Click Installer for macOS               ║
# ║                                                          ║
# ║  Double-click this file to install.                      ║
# ║  It will:                                                ║
# ║    1. Find the StreamCam extension directory              ║
# ║    2. Install Node.js dependencies                        ║
# ║    3. Register the native host with Chrome                ║
# ║    4. Compile the virtual camera plugin                   ║
# ╚══════════════════════════════════════════════════════════╝

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo
echo "╔══════════════════════════════════════════════════╗"
echo "║   StreamCam — One-Click Installer               ║"
echo "╚══════════════════════════════════════════════════╝"
echo

# ── Find the native-host directory ────────────────────────────────
# The installer sits in native-host/installers/, so go up one level.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_DIR="$(dirname "$SCRIPT_DIR")"

# Verify we're in the right place
if [ ! -f "$HOST_DIR/host.js" ]; then
    echo -e "${RED}Error: Could not find host.js${NC}"
    echo "Make sure this installer is in the native-host/installers/ folder"
    echo "inside the StreamCam extension directory."
    echo
    echo "Press any key to close..."
    read -n 1
    exit 1
fi

echo "Extension directory: $(dirname "$HOST_DIR")"
echo

# ── Check for Node.js ─────────────────────────────────────────────

echo -n "Checking for Node.js... "
if command -v node &>/dev/null; then
    NODE_VER=$(node -v)
    echo -e "${GREEN}found ($NODE_VER)${NC}"
else
    echo -e "${YELLOW}not found${NC}"
    echo
    echo "Node.js is required. Installing via Homebrew..."

    if ! command -v brew &>/dev/null; then
        echo "Homebrew not found. Installing Homebrew first..."
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    fi

    brew install node
    echo -e "${GREEN}Node.js installed${NC}"
fi

# ── Check for Xcode Command Line Tools ────────────────────────────

echo -n "Checking for Xcode Command Line Tools... "
if xcode-select -p &>/dev/null; then
    echo -e "${GREEN}found${NC}"
else
    echo -e "${YELLOW}not found${NC}"
    echo "Installing (this may take a few minutes)..."
    xcode-select --install 2>/dev/null || true
    echo "Please follow the installer prompt, then re-run this script."
    echo "Press any key to close..."
    read -n 1
    exit 1
fi

# ── Check for FFmpeg ──────────────────────────────────────────────

echo -n "Checking for FFmpeg... "
if command -v ffmpeg &>/dev/null; then
    echo -e "${GREEN}found${NC}"
else
    echo -e "${YELLOW}not found${NC}"
    echo "Installing FFmpeg via Homebrew..."
    if command -v brew &>/dev/null; then
        brew install ffmpeg
        echo -e "${GREEN}FFmpeg installed${NC}"
    else
        echo -e "${YELLOW}Install FFmpeg manually: brew install ffmpeg${NC}"
    fi
fi

# ── Install npm dependencies ──────────────────────────────────────

echo
echo "Installing dependencies..."
cd "$HOST_DIR"
npm install --production 2>&1 | tail -1
echo -e "${GREEN}Dependencies installed${NC}"

# ── Detect extension ID ───────────────────────────────────────────
# Try to find the extension ID from Chrome's NativeMessagingHosts

EXTENSION_ID=""

# Check if there's a cached ID
if [ -f "$HOST_DIR/.extension-id" ]; then
    EXTENSION_ID=$(cat "$HOST_DIR/.extension-id")
    echo "Using cached extension ID: $EXTENSION_ID"
fi

# If no cached ID, try to detect from Chrome's config
if [ -z "$EXTENSION_ID" ]; then
    CHROME_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    if [ -d "$CHROME_DIR" ]; then
        # Look for any existing manifest
        for f in "$CHROME_DIR"/com.alresia.*.json; do
            if [ -f "$f" ]; then
                # Extract the extension ID from allowed_origins
                EXTENSION_ID=$(grep -o 'chrome-extension://[a-p]\{32\}' "$f" | head -1 | sed 's/chrome-extension:\/\///')
                if [ -n "$EXTENSION_ID" ]; then
                    echo "Detected extension ID: $EXTENSION_ID"
                    break
                fi
            fi
        done
    fi
fi

# ── Register native host ──────────────────────────────────────────

echo
echo "Registering native host with Chrome..."

if [ -n "$EXTENSION_ID" ]; then
    node install.js --id="$EXTENSION_ID"
else
    echo
    echo "Could not auto-detect extension ID."
    echo "Please enter your extension ID (from chrome://extensions):"
    echo "  (You can also re-run this installer later with --id=YOUR_ID)"
    echo
    read -p "Extension ID (or press Enter to skip): " USER_ID
    if [ -n "$USER_ID" ]; then
        node install.js --id="$USER_ID"
    else
        echo "Skipping host registration. Re-run with --id later."
    fi
fi

# ── Compile virtual camera plugin ─────────────────────────────────

echo
echo "Setting up virtual camera..."

# Run vcam setup (compiles the CoreMediaIO plugin)
node vcam-setup.js setup 2>&1 || true

# ── Done ──────────────────────────────────────────────────────────

echo
echo "═══════════════════════════════════════════════════"
echo -e "${GREEN}Installation complete!${NC}"
echo
echo "Next steps:"
echo "  1. Restart Chrome"
echo "  2. Click the StreamCam icon"
echo "  3. Click 'Virtual Cam' to test"
echo "═══════════════════════════════════════════════════"
echo
echo "Press any key to close..."
read -n 1
