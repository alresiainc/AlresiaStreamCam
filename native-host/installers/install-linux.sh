#!/bin/bash
# ╔══════════════════════════════════════════════════════════╗
# ║  StreamCam — One-Click Installer for Linux               ║
# ║                                                          ║
# ║  Run this file to install:                               ║
# ║    bash install-linux.sh                                 ║
# ║                                                          ║
# ║  It will:                                                ║
# ║    1. Find the StreamCam extension directory              ║
# ║    2. Install Node.js dependencies                        ║
# ║    3. Register the native host with Chrome                ║
# ║    4. Install v4l2loopback for virtual camera             ║
# ╚══════════════════════════════════════════════════════════╝

set -e

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

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_DIR="$(dirname "$SCRIPT_DIR")"

if [ ! -f "$HOST_DIR/host.js" ]; then
    echo -e "${RED}Error: Could not find host.js${NC}"
    echo "Make sure this installer is in the native-host/installers/ folder"
    echo "inside the StreamCam extension directory."
    exit 1
fi

echo "Extension directory: $(dirname "$HOST_DIR")"
echo

# ── Check for Node.js ─────────────────────────────────────────────

echo -n "Checking for Node.js... "
if command -v node &>/dev/null; then
    echo -e "${GREEN}found ($(node -v))${NC}"
else
    echo -e "${YELLOW}not found${NC}"
    echo "Installing Node.js..."

    if command -v apt &>/dev/null; then
        curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
        sudo apt install -y nodejs
    elif command -v dnf &>/dev/null; then
        curl -fsSL https://rpm.nodesource.com/setup_lts.x | sudo bash -
        sudo dnf install -y nodejs
    elif command -v pacman &>/dev/null; then
        sudo pacman -S --noconfirm nodejs npm
    else
        echo -e "${YELLOW}Could not auto-install Node.js${NC}"
        echo "Please install from https://nodejs.org"
        exit 1
    fi
    echo -e "${GREEN}Node.js installed${NC}"
fi

# ── Check for FFmpeg ──────────────────────────────────────────────

echo -n "Checking for FFmpeg... "
if command -v ffmpeg &>/dev/null; then
    echo -e "${GREEN}found${NC}"
else
    echo -e "${YELLOW}not found${NC}"
    echo "Installing FFmpeg..."
    if command -v apt &>/dev/null; then
        sudo apt install -y ffmpeg
    elif command -v dnf &>/dev/null; then
        sudo dnf install -y ffmpeg
    elif command -v pacman &>/dev/null; then
        sudo pacman -S --noconfirm ffmpeg
    fi
fi

# ── Install npm dependencies ──────────────────────────────────────

echo
echo "Installing dependencies..."
cd "$HOST_DIR"
npm install --production 2>&1 | tail -1
echo -e "${GREEN}Dependencies installed${NC}"

# ── Register native host ──────────────────────────────────────────

echo
echo "Registering native host with Chrome..."

# Try to detect extension ID
EXTENSION_ID=""
if [ -f "$HOST_DIR/.extension-id" ]; then
    EXTENSION_ID=$(cat "$HOST_DIR/.extension-id")
    echo "Using cached extension ID: $EXTENSION_ID"
fi

if [ -z "$EXTENSION_ID" ]; then
    CHROME_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
    if [ -d "$CHROME_DIR" ]; then
        for f in "$CHROME_DIR"/com.alresia.*.json; do
            if [ -f "$f" ]; then
                EXTENSION_ID=$(grep -o 'chrome-extension://[a-p]\{32\}' "$f" | head -1 | sed 's|chrome-extension://||')
                if [ -n "$EXTENSION_ID" ]; then
                    echo "Detected extension ID: $EXTENSION_ID"
                    break
                fi
            fi
        done
    fi
fi

if [ -n "$EXTENSION_ID" ]; then
    node install.js --id="$EXTENSION_ID"
else
    echo
    echo "Could not auto-detect extension ID."
    read -p "Extension ID (or press Enter to skip): " USER_ID
    if [ -n "$USER_ID" ]; then
        node install.js --id="$USER_ID"
    else
        echo "Skipping host registration."
    fi
fi

# ── Setup virtual camera ──────────────────────────────────────────

echo
echo "Setting up virtual camera..."
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
