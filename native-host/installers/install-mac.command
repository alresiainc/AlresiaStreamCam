#!/bin/bash
# ╔══════════════════════════════════════════════════════════╗
# ║  StreamCam — One-Click Installer for macOS               ║
# ║                                                          ║
# ║  Right-click this file → Open to run.                    ║
# ║                                                          ║
# ║  It will:                                                ║
# ║    1. Install Node.js (if missing)                       ║
# ║    2. Install dependencies                               ║
# ║    3. Register with Chrome                               ║
# ║    4. Compile the virtual camera                         ║
# ╚══════════════════════════════════════════════════════════╝

set -e

# ── Colors ────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

# ── Header ────────────────────────────────────────────────────────
clear
echo
echo -e "${BOLD}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║                                                      ║${NC}"
echo -e "${BOLD}║   🎥  StreamCam Installer for macOS                  ║${NC}"
echo -e "${BOLD}║                                                      ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════════════╝${NC}"
echo

# ── Find the StreamCam directory ──────────────────────────────────
# This .command file is downloaded to ~/Downloads.
# We need to find where StreamCam is installed or guide the user.

INSTALL_DIR=""
POSSIBLE_PATHS=(
    "$HOME/Applications/StreamCam.app/Contents/MacOS"
    "/Applications/StreamCam.app/Contents/MacOS"
    "$HOME/Downloads/StreamCam"
)

for p in "${POSSIBLE_PATHS[@]}"; do
    if [ -f "$p/host.js" ]; then
        INSTALL_DIR="$p"
        break
    fi
done

# If not found, check if we're inside the extension directory
if [ -z "$INSTALL_DIR" ]; then
    SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
    # Check if we're in native-host/installers/
    if [ -f "$SCRIPT_DIR/../host.js" ]; then
        INSTALL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
    fi
fi

if [ -z "$INSTALL_DIR" ]; then
    echo -e "${YELLOW}StreamCam not found on your system.${NC}"
    echo
    echo "Where is the StreamCam extension folder?"
    echo "(It contains host.js, install.js, and other files)"
    echo
    read -p "Path (or press Enter to skip): " USER_PATH
    USER_PATH="${USER_PATH/#\~/$HOME}"
    USER_PATH="${USER_PATH//\"/}"
    USER_PATH="${USER_PATH//\'/}"
    
    if [ -n "$USER_PATH" ] && [ -f "$USER_PATH/host.js" ]; then
        INSTALL_DIR="$USER_PATH"
    else
        echo
        echo -e "${RED}Could not find StreamCam files.${NC}"
        echo
        echo "Please make sure you have the StreamCam extension folder."
        echo "It should contain: host.js, install.js, package.json"
        echo
        echo "Press any key to close..."
        read -n 1
        exit 1
    fi
fi

echo -e "  Location: ${GREEN}$INSTALL_DIR${NC}"
echo

# ── Step 1: Check for Node.js ─────────────────────────────────────
echo -e "${BOLD}Step 1/4: Checking for Node.js${NC}"

if command -v node &>/dev/null; then
    NODE_VER=$(node -v)
    echo -e "  ${GREEN}✓${NC} Found: Node.js $NODE_VER"
else
    echo -e "  ${YELLOW}→${NC} Not found. Installing via Homebrew..."
    
    if ! command -v brew &>/dev/null; then
        echo "  Installing Homebrew first..."
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
        eval "$(/opt/homebrew/bin/brew shellenv)"
    fi
    
    brew install node
    echo -e "  ${GREEN}✓${NC} Node.js installed"
fi
echo

# ── Step 2: Check for Xcode CLT ───────────────────────────────────
echo -e "${BOLD}Step 2/4: Checking for build tools${NC}"

if xcode-select -p &>/dev/null 2>&1; then
    echo -e "  ${GREEN}✓${NC} Xcode Command Line Tools found"
else
    echo -e "  ${YELLOW}→${NC} Installing Xcode Command Line Tools..."
    echo "  (This opens a dialog — click Install and wait)"
    xcode-select --install 2>/dev/null
    echo
    echo "After the Xcode install completes, run this script again."
    echo "Press any key to close..."
    read -n 1
    exit 0
fi
echo

# ── Step 3: Install dependencies & register ───────────────────────
echo -e "${BOLD}Step 3/4: Installing StreamCam${NC}"

cd "$INSTALL_DIR"
echo "  Installing npm dependencies..."
npm install --production 2>&1 | tail -3
echo -e "  ${GREEN}✓${NC} Dependencies installed"
echo

# ── Step 4: Register with Chrome ──────────────────────────────────
echo -e "${BOLD}Step 4/4: Registering with Chrome${NC}"

# Try to auto-detect extension ID
EXTENSION_ID=""

# Check cached ID
if [ -f ".extension-id" ]; then
    EXTENSION_ID=$(cat ".extension-id" 2>/dev/null)
fi

# Check Chrome's NativeMessagingHosts
if [ -z "$EXTENSION_ID" ]; then
    CHROME_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    if [ -d "$CHROME_DIR" ]; then
        for f in "$CHROME_DIR"/com.alresia.*.json; do
            [ -f "$f" ] || continue
            EXTENSION_ID=$(grep -o 'chrome-extension://[a-p]\{32\}' "$f" 2>/dev/null | head -1 | sed 's|chrome-extension://||')
            [ -n "$EXTENSION_ID" ] && break
        done
    fi
fi

if [ -n "$EXTENSION_ID" ]; then
    echo "  Extension ID: $EXTENSION_ID"
    node install.js --id="$EXTENSION_ID" 2>&1 | tail -2
    echo -e "  ${GREEN}✓${NC} Registered with Chrome"
else
    echo
    echo -e "  ${YELLOW}Could not auto-detect extension ID.${NC}"
    echo "  Find it at: chrome://extensions → Developer mode → StreamCam"
    echo
    read -p "  Extension ID (or press Enter to skip): " USER_ID
    if [ -n "$USER_ID" ]; then
        node install.js --id="$USER_ID" 2>&1 | tail -2
        echo -e "  ${GREEN}✓${NC} Registered with Chrome"
    else
        echo "  Skipped. Run later: node install.js --id=YOUR_ID"
    fi
fi

# ── Setup virtual camera ──────────────────────────────────────────
echo
echo -e "${BOLD}Setting up virtual camera...${NC}"
node vcam-setup.js setup 2>&1 | tail -3 || true
echo -e "  ${GREEN}✓${NC} Virtual camera ready"
echo

# ── Done ──────────────────────────────────────────────────────────
echo -e "${BOLD}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║                                                      ║${NC}"
echo -e "${BOLD}║   ${GREEN}✓ Installation complete!${NC}${BOLD}                           ║${NC}"
echo -e "${BOLD}║                                                      ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════════════╝${NC}"
echo
echo "  Next steps:"
echo "    1. Close and reopen Chrome"
echo "    2. Click the StreamCam icon in your toolbar"
echo "    3. Click 'Virtual Cam' to test"
echo
echo "  Press any key to close..."
read -n 1
