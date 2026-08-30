#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# StreamCam — Native Installer Builder
#
# Creates small, native installers for each platform.
# No Electron. No bloat. Just real OS-native packages.
#
# macOS:  .pkg (~2MB)  — built with pkgbuild/productbuild
# Windows: .exe (~1MB) — built with NSIS (or iexpress)
# Linux:  .deb (~1MB)  — built with dpkg-deb
#
# Usage:
#   bash build.sh          # Build for current platform
#   bash build.sh --all    # Build for all platforms (needs tools)
# ═══════════════════════════════════════════════════════════════

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DIST_DIR="$SCRIPT_DIR/dist"
VERSION="1.0.0"

echo "StreamCam Installer Builder"
echo "=========================="
echo

rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

# ── macOS: .pkg ───────────────────────────────────────────────

build_macos() {
    echo "Building macOS .pkg..."

    if ! command -v pkgbuild &>/dev/null; then
        echo "  ERROR: pkgbuild not found (requires macOS)"
        return 1
    fi

    PKG_ROOT="$DIST_DIR/mac-pkgroot"
    mkdir -p "$PKG_ROOT/Applications/StreamCam"

    # Copy host files
    cp "$SCRIPT_DIR/../host.js" "$PKG_ROOT/Applications/StreamCam/"
    cp "$SCRIPT_DIR/../install.js" "$PKG_ROOT/Applications/StreamCam/"
    cp "$SCRIPT_DIR/../vcam-setup.js" "$PKG_ROOT/Applications/StreamCam/"
    cp "$SCRIPT_DIR/../package.json" "$PKG_ROOT/Applications/StreamCam/"
    cp -r "$SCRIPT_DIR/../platform" "$PKG_ROOT/Applications/StreamCam/"
    mkdir -p "$PKG_ROOT/Applications/StreamCam/installers"
    cp "$SCRIPT_DIR"/../installers/* "$PKG_ROOT/Applications/StreamCam/installers/" 2>/dev/null || true

    # Post-install script
    POSTINSTALL="$DIST_DIR/postinstall"
    cat > "$POSTINSTALL" << 'EOF'
#!/bin/bash
INSTALL_DIR="/Applications/StreamCam/native-host"
echo ""
echo "StreamCam — Setting up..."

# Move files to the right place
mkdir -p "$INSTALL_DIR"
cp /Applications/StreamCam/* "$INSTALL_DIR/" 2>/dev/null || true
cp -r /Applications/StreamCam/platform "$INSTALL_DIR/" 2>/dev/null || true
cp -r /Applications/StreamCam/installers "$INSTALL_DIR/" 2>/dev/null || true
rm -rf /Applications/StreamCam

# Check Node.js
if ! command -v node &>/dev/null; then
    echo "Node.js not found. Installing via Homebrew..."
    if command -v brew &>/dev/null; then
        brew install node
    else
        echo "Please install Node.js from https://nodejs.org"
        open "https://nodejs.org"
        exit 1
    fi
fi

# Check Xcode CLT
if ! xcode-select -p &>/dev/null 2>&1; then
    echo "Installing Xcode Command Line Tools..."
    xcode-select --install 2>/dev/null
    echo "Please approve the installer, then re-run StreamCam."
    exit 1
fi

# Install deps
cd "$INSTALL_DIR"
echo "Installing dependencies..."
npm install --production 2>&1 | tail -1

# Detect extension ID
EXTENSION_ID=""
CHROME_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
if [ -d "$CHROME_DIR" ]; then
    for f in "$CHROME_DIR"/com.alresia.*.json; do
        if [ -f "$f" ]; then
            EXTENSION_ID=$(grep -o 'chrome-extension://[a-p]\{32\}' "$f" 2>/dev/null | head -1 | sed 's|chrome-extension://||')
            [ -n "$EXTENSION_ID" ] && break
        fi
    done
fi

if [ -n "$EXTENSION_ID" ]; then
    echo "Registering with Chrome (ID: $EXTENSION_ID)..."
    node install.js --id="$EXTENSION_ID" 2>&1 | tail -2
else
    echo "Run: cd $INSTALL_DIR && node install.js --id=YOUR_ID"
fi

# Virtual camera
echo "Setting up virtual camera..."
node vcam-setup.js setup 2>&1 | tail -2

echo ""
echo "Done! Restart Chrome to use StreamCam."
exit 0
EOF
    chmod +x "$POSTINSTALL"

    # Build
    pkgbuild \
        --root "$PKG_ROOT" \
        --identifier "com.alresia.streamcam.installer" \
        --version "$VERSION" \
        --scripts "$POSTINSTALL" \
        --install-location "/" \
        "$DIST_DIR/StreamCam.pkg" 2>/dev/null

    # Distribution
    cat > "$DIST_DIR/Distribution" << EOF
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
    <pkg-ref id="com.alresia.streamcam.installer" version="$VERSION">StreamCam.pkg</pkg-ref>
</installer-gui-script>
EOF

    productbuild \
        --distribution "$DIST_DIR/Distribution" \
        --package-path "$DIST_DIR/StreamCam.pkg" \
        "$DIST_DIR/StreamCam-Installer.pkg" 2>/dev/null

    rm -f "$DIST_DIR/StreamCam.pkg" "$DIST_DIR/Distribution" "$POSTINSTALL"
    rm -rf "$DIST_DIR/mac-pkgroot"

    echo "  Built: dist/StreamCam-Installer.pkg ($(du -h "$DIST_DIR/StreamCam-Installer.pkg" | cut -f1))"
}

# ── Linux: .deb ───────────────────────────────────────────────

build_linux() {
    echo "Building Linux .deb..."

    DEB_ROOT="$DIST_DIR/deb"
    mkdir -p "$DEB_ROOT/DEBIAN"
    mkdir -p "$DEB_ROOT/usr/lib/streamcam"
    mkdir -p "$DEB_ROOT/usr/share/applications"

    # Copy host files
    cp "$SCRIPT_DIR/../host.js" "$DEB_ROOT/usr/lib/streamcam/"
    cp "$SCRIPT_DIR/../install.js" "$DEB_ROOT/usr/lib/streamcam/"
    cp "$SCRIPT_DIR/../vcam-setup.js" "$DEB_ROOT/usr/lib/streamcam/"
    cp "$SCRIPT_DIR/../package.json" "$DEB_ROOT/usr/lib/streamcam/"
    cp -r "$SCRIPT_DIR/../platform" "$DEB_ROOT/usr/lib/streamcam/"

    # Control file
    cat > "$DEB_ROOT/DEBIAN/control" << EOF
Package: streamcam
Version: $VERSION
Section: utils
Priority: optional
Architecture: amd64
Depends: nodejs (>= 16), npm, ffmpeg
Maintainer: Alresia <hello@alresia.com>
Homepage: https://github.com/alresiainc/AlresiaStreamCam
Description: StreamCam - streaming studio and virtual camera for Chrome
 A lightweight browser extension for streaming and virtual camera.
 Includes native host for RTMP streaming and cross-platform virtual camera.
EOF

    # Post-install
    cat > "$DEB_ROOT/DEBIAN/postinst" << 'EOF'
#!/bin/bash
INSTALL_DIR="/usr/lib/streamcam"
echo "StreamCam: Installing dependencies..."
cd "$INSTALL_DIR" && npm install --production 2>/dev/null
echo "StreamCam: Setup complete. Restart Chrome to use."
EOF
    chmod 755 "$DEB_ROOT/DEBIAN/postinst"

    # Build
    dpkg-deb --build "$DEB_ROOT" "$DIST_DIR/streamcam_${VERSION}_amd64.deb" 2>/dev/null

    rm -rf "$DEB_ROOT"

    echo "  Built: dist/streamcam_${VERSION}_amd64.deb ($(du -h "$DIST_DIR/streamcam_${VERSION}_amd64.deb" | cut -f1))"
}

# ── Main ──────────────────────────────────────────────────────

case "$(uname -s)" in
    Darwin) build_macos ;;
    Linux)  build_linux ;;
    *)
        echo "Unsupported platform: $(uname -s)"
        echo "On Windows, use: makensis build-nsis.nsi"
        exit 1
        ;;
esac

echo
echo "Done! Installer is in the dist/ folder."
