#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# StreamCam — macOS Installer Helper
#
# This script removes the macOS quarantine flag and opens the
# .pkg installer. Users double-click this instead of the .pkg.
#
# Gatekeeper blocks unsigned .pkg files. This script uses
# xattr to remove the quarantine attribute, then opens the
# installer. This is the standard approach for open-source
# macOS apps without a $99/yr Apple Developer certificate.
# ═══════════════════════════════════════════════════════════════

echo ""
echo "StreamCam Installer"
echo "==================="
echo

# Find the .pkg in the same directory as this script
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_FILE=$(find "$SCRIPT_DIR" -name "*.pkg" -maxdepth 1 | head -1)

if [ -z "$PKG_FILE" ]; then
    # Also check the Downloads folder
    PKG_FILE=$(find ~/Downloads -name "StreamCam-Installer*.pkg" -maxdepth 1 | head -1)
fi

if [ -z "$PKG_FILE" ]; then
    echo "Could not find StreamCam-Installer.pkg"
    echo "Please download it from:"
    echo "  https://github.com/alresiainc/AlresiaStreamCam/releases"
    echo
    open "https://github.com/alresiainc/AlresiaStreamCam/releases"
    echo "Press any key to close..."
    read -n 1
    exit 1
fi

echo "Found: $(basename "$PKG_FILE")"
echo

# Remove quarantine flag (this is what Gatekeeper checks)
echo "Removing macOS security flag..."
xattr -d com.apple.quarantine "$PKG_FILE" 2>/dev/null

# Open the installer
echo "Opening installer..."
open "$PKG_FILE"

echo
echo "The installer should open now."
echo "Follow the prompts to complete installation."
echo
echo "Press any key to close..."
read -n 1
