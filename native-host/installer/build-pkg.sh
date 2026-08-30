#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# StreamCam — macOS .pkg Installer Builder
#
# Creates a native macOS installer package (~2MB).
# No Electron. No bloat. Just a real .pkg that:
#   1. Checks for Node.js
#   2. Installs npm dependencies
#   3. Registers the native host with Chrome
#   4. Compiles the virtual camera plugin
#
# Usage:
#   cd native-host/installer
#   bash build-pkg.sh
#
# Output: dist/StreamCam-Installer.pkg
# ═══════════════════════════════════════════════════════════════

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
DIST_DIR="$SCRIPT_DIR/dist"
PKG_ID="com.alresia.streamcam.installer"
PKG_VERSION="1.0.0"

echo "StreamCam — macOS .pkg Builder"
echo "==============================="
echo

# ── Prepare ────────────────────────────────────────────────────

rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

# Copy the files that the installer needs
STAGING="$DIST_DIR/staging"
mkdir -p "$STAGING/native-host"

# Copy native host files
cp "$PROJECT_ROOT/host.js" "$STAGING/native-host/"
cp "$PROJECT_ROOT/install.js" "$STAGING/native-host/"
cp "$PROJECT_ROOT/vcam-setup.js" "$STAGING/native-host/"
cp "$PROJECT_ROOT/package.json" "$STAGING/native-host/"
cp -r "$PROJECT_ROOT/platform" "$STAGING/native-host/"
cp -r "$PROJECT_ROOT/installers" "$STAGING/native-host/"

# Create a skeleton package root for pkgbuild
PKG_ROOT="$DIST_DIR/pkgroot"
mkdir -p "$PKG_ROOT/Applications/StreamCam"
cp -r "$STAGING/native-host" "$PKG_ROOT/Applications/StreamCam/"

# ── Post-install script ────────────────────────────────────────
# This runs after the files are copied.

POSTINSTALL="$DIST_DIR/postinstall"
cat > "$POSTINSTALL" << 'POSTINSTALLEOF'
#!/bin/bash
# StreamCam — Post-install script

INSTALL_DIR="/Applications/StreamCam/native-host"

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║   StreamCam — Setting up...                  ║"
echo "╚══════════════════════════════════════════════╝"
echo

# ── Check for Node.js ─────────────────────────────────────────
echo -n "Checking for Node.js... "
if command -v node &>/dev/null; then
    echo "found ($(node -v))"
else
    echo "NOT FOUND"
    echo ""
    echo "Node.js is required. Install it:"
    echo "  brew install node"
    echo "  or download from https://nodejs.org"
    echo ""
    # Open the Node.js download page
    open "https://nodejs.org"
    exit 1
fi

# ── Check for Xcode CLT ───────────────────────────────────────
echo -n "Checking for Xcode CLT... "
if xcode-select -p &>/dev/null 2>&1; then
    echo "found"
else
    echo "NOT FOUND"
    echo "Installing Xcode Command Line Tools..."
    xcode-select --install 2>/dev/null
    echo "Please approve the installer, then re-run StreamCam."
    exit 1
fi

# ── Install dependencies ──────────────────────────────────────
echo ""
echo "Installing dependencies..."
cd "$INSTALL_DIR"
npm install --production 2>&1 | tail -1
echo "Dependencies installed."

# ── Detect extension ID ───────────────────────────────────────
EXTENSION_ID=""

# Check cached ID
if [ -f "$INSTALL_DIR/.extension-id" ]; then
    EXTENSION_ID=$(cat "$INSTALL_DIR/.extension-id")
fi

# Check Chrome's config
if [ -z "$EXTENSION_ID" ]; then
    CHROME_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    if [ -d "$CHROME_DIR" ]; then
        for f in "$CHROME_DIR"/com.alresia.*.json; do
            if [ -f "$f" ]; then
                EXTENSION_ID=$(grep -o 'chrome-extension://[a-p]\{32\}' "$f" 2>/dev/null | head -1 | sed 's|chrome-extension://||')
                [ -n "$EXTENSION_ID" ] && break
            fi
        done
    fi
fi

# ── Register native host ──────────────────────────────────────
echo ""
if [ -n "$EXTENSION_ID" ]; then
    echo "Registering native host with Chrome (ID: $EXTENSION_ID)..."
    cd "$INSTALL_DIR"
    node install.js --id="$EXTENSION_ID" 2>&1 | tail -3
else
    echo "Could not detect extension ID automatically."
    echo "After installing the Chrome extension, run:"
    echo "  cd $INSTALL_DIR && node install.js --id=YOUR_EXTENSION_ID"
fi

# ── Setup virtual camera ──────────────────────────────────────
echo ""
echo "Setting up virtual camera..."
cd "$INSTALL_DIR"
node vcam-setup.js setup 2>&1 | tail -2

echo ""
echo "══════════════════════════════════════════════"
echo "Installation complete!"
echo ""
echo "1. Restart Chrome"
echo "2. Click the StreamCam icon"
echo "3. Click 'Virtual Cam' to test"
echo "══════════════════════════════════════════════"
echo

exit 0
POSTINSTALLEOF
chmod +x "$POSTINSTALL"

# ── Build the .pkg ─────────────────────────────────────────────

echo "Building package..."

# Component package (the actual files)
pkgbuild \
    --root "$PKG_ROOT" \
    --identifier "$PKG_ID" \
    --version "$PKG_VERSION" \
    --scripts "$POSTINSTALL" \
    --install-location "/" \
    "$DIST_DIR/StreamCam.pkg"

# Distribution file (installer UI)
cat > "$DIST_DIR/Distribution" << 'DISTEOF'
<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
    <title>StreamCam Installer</title>
    <options customize="never" require-scripts="true" hostArchitectures="x86_64,arm64"/>
    <domains enable_anywhere="false" enable_currentUserHome="false" enable_localSystem="true"/>
    <choices-outline>
        <line choice="com.alresia.streamcam.installer"/>
    </choices-outline>
    <choice id="com.alresia.streamcam.installer" title="StreamCam">
        <pkg-ref id="com.alresia.streamcam.installer"/>
    </choice>
    <pkg-ref id="com.alresia.streamcam.installer" version="1.0.0">StreamCam.pkg</pkg-ref>
</installer-gui-script>
DISTEOF

# Product archive (final .pkg)
productbuild \
    --distribution "$DIST_DIR/Distribution" \
    --package-path "$DIST_DIR/StreamCam.pkg" \
    "$DIST_DIR/StreamCam-Installer.pkg"

# ── Done ────────────────────────────────────────────────────────

# Clean up intermediate files
rm -f "$DIST_DIR/StreamCam.pkg"
rm -rf "$DIST_DIR/staging" "$DIST_DIR/pkgroot"

echo
echo "Built: $DIST_DIR/StreamCam-Installer.pkg"
echo "Size: $(du -h "$DIST_DIR/StreamCam-Installer.pkg" | cut -f1)"
echo
echo "To sign (optional, removes Gatekeeper warning):"
echo "  codesign --force --sign \"Developer ID Application: YOUR NAME\" $DIST_DIR/StreamCam-Installer.pkg"
echo
echo "To notarize (optional, fully removes all warnings):"
echo "  xcrun notarytool submit $DIST_DIR/StreamCam-Installer.pkg --apple-id YOUR@email.com --team-id TEAM_ID --wait"
