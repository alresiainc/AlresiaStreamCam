#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# StreamCam — Native Installer Builder
#
# macOS:  .dmg containing .pkg + helper script (bypasses Gatekeeper)
# Linux:  .deb package
#
# No Electron. No bloat. Just scripts.
# ═══════════════════════════════════════════════════════════════

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
DIST_DIR="$SCRIPT_DIR/dist"
VERSION="1.0.0"

echo "StreamCam Installer Builder"
echo "=========================="
echo

rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

# ── macOS: .pkg → .dmg ───────────────────────────────────────

build_macos() {
    echo "Building macOS installer..."

    WORK="$DIST_DIR/_mac_work"
    mkdir -p "$WORK/root/Applications/StreamCam"
    mkdir -p "$WORK/scripts"
    mkdir -p "$WORK/dmg_contents"

    # Copy host files into the package root
    cp "$PROJECT_ROOT/host.js" "$WORK/root/Applications/StreamCam/"
    cp "$PROJECT_ROOT/install.js" "$WORK/root/Applications/StreamCam/"
    cp "$PROJECT_ROOT/vcam-setup.js" "$WORK/root/Applications/StreamCam/"
    cp "$PROJECT_ROOT/package.json" "$WORK/root/Applications/StreamCam/"
    cp -r "$PROJECT_ROOT/platform" "$WORK/root/Applications/StreamCam/"
    mkdir -p "$WORK/root/Applications/StreamCam/installers"
    cp "$PROJECT_ROOT"/installers/* "$WORK/root/Applications/StreamCam/installers/" 2>/dev/null || true

    # Post-install script
    cat > "$WORK/scripts/postinstall" << 'POSTEOF'
#!/bin/bash
set -e

SRC="/Applications/StreamCam"
DEST="/Applications/StreamCam.app/Contents/MacOS"

mkdir -p "$DEST"
mv "$SRC/host.js" "$DEST/" 2>/dev/null || true
mv "$SRC/install.js" "$DEST/" 2>/dev/null || true
mv "$SRC/vcam-setup.js" "$DEST/" 2>/dev/null || true
mv "$SRC/package.json" "$DEST/" 2>/dev/null || true
mv "$SRC/platform" "$DEST/" 2>/dev/null || true
mv "$SRC/installers" "$DEST/" 2>/dev/null || true
rm -rf "$SRC"

INSTALL_DIR="$DEST"

echo ""
echo "StreamCam — Setting up..."

if ! command -v node &>/dev/null; then
    echo "Node.js not found."
    if command -v brew &>/dev/null; then
        echo "Installing via Homebrew..."
        brew install node
    else
        echo "Please install Node.js: https://nodejs.org"
        open "https://nodejs.org"
        exit 1
    fi
fi

if ! xcode-select -p &>/dev/null 2>&1; then
    echo "Installing Xcode Command Line Tools..."
    xcode-select --install 2>/dev/null
    echo "Approve the installer, then re-run StreamCam."
    exit 0
fi

cd "$INSTALL_DIR"
echo "Installing npm dependencies..."
npm install --production 2>&1 | tail -1

EXT_ID=""
CHROME_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
if [ -d "$CHROME_DIR" ]; then
    for f in "$CHROME_DIR"/com.alresia.*.json; do
        [ -f "$f" ] || continue
        EXT_ID=$(grep -o 'chrome-extension://[a-p]\{32\}' "$f" 2>/dev/null | head -1 | sed 's|chrome-extension://||')
        [ -n "$EXT_ID" ] && break
    done
fi

if [ -n "$EXT_ID" ]; then
    echo "Registering with Chrome (ID: $EXT_ID)..."
    node install.js --id="$EXT_ID" 2>&1 | tail -2
else
    echo "Run: node install.js --id=YOUR_EXTENSION_ID"
fi

echo "Setting up virtual camera..."
node vcam-setup.js setup 2>&1 | tail -2 || true

echo ""
echo "Done! Restart Chrome to use StreamCam."
exit 0
POSTEOF
    chmod +x "$WORK/scripts/postinstall"

    # Build component package
    pkgbuild \
        --root "$WORK/root" \
        --identifier "com.alresia.streamcam" \
        --version "$VERSION" \
        --scripts "$WORK/scripts" \
        --install-location "/" \
        "$WORK/component.pkg"

    # Build product archive
    productbuild \
        --package "$WORK/component.pkg" \
        "$WORK/StreamCam-Installer.pkg"

    # Create DMG contents
    cp "$WORK/StreamCam-Installer.pkg" "$WORK/dmg_contents/"
    cp "$PROJECT_ROOT/installers/open-mac.command" "$WORK/dmg_contents/"

    # Build the DMG
    hdiutil create \
        -volname "StreamCam Installer" \
        -srcfolder "$WORK/dmg_contents" \
        -ov -format UDZO \
        "$DIST_DIR/StreamCam-Installer.dmg"

    rm -rf "$WORK"

    SIZE=$(du -h "$DIST_DIR/StreamCam-Installer.dmg" | cut -f1)
    echo "  Built: dist/StreamCam-Installer.dmg ($SIZE)"
    echo "  Contains: StreamCam-Installer.pkg + Open Installer.command"
}

# ── Linux: .deb ───────────────────────────────────────────────

build_linux() {
    echo "Building Linux .deb..."

    DEB="$DIST_DIR/deb"
    mkdir -p "$DEB/DEBIAN"
    mkdir -p "$DEB/usr/lib/streamcam"

    cp "$PROJECT_ROOT/host.js" "$DEB/usr/lib/streamcam/"
    cp "$PROJECT_ROOT/install.js" "$DEB/usr/lib/streamcam/"
    cp "$PROJECT_ROOT/vcam-setup.js" "$DEB/usr/lib/streamcam/"
    cp "$PROJECT_ROOT/package.json" "$DEB/usr/lib/streamcam/"
    cp -r "$PROJECT_ROOT/platform" "$DEB/usr/lib/streamcam/"

    cat > "$DEB/DEBIAN/control" << EOF
Package: streamcam
Version: $VERSION
Section: utils
Priority: optional
Architecture: amd64
Depends: nodejs (>= 16), npm, ffmpeg
Maintainer: Alresia <hello@alresia.com>
Homepage: https://github.com/alresiainc/AlresiaStreamCam
Description: StreamCam streaming studio and virtual camera for Chrome
EOF

    cat > "$DEB/DEBIAN/postinst" << 'EOF'
#!/bin/bash
echo "StreamCam: Installing dependencies..."
cd /usr/lib/streamcam && npm install --production 2>/dev/null
echo "StreamCam: Done. Restart Chrome to use."
EOF
    chmod 755 "$DEB/DEBIAN/postinst"

    dpkg-deb --build "$DEB" "$DIST_DIR/streamcam_${VERSION}_amd64.deb" 2>/dev/null
    rm -rf "$DEB"

    SIZE=$(du -h "$DIST_DIR/streamcam_${VERSION}_amd64.deb" | cut -f1)
    echo "  Built: dist/streamcam_${VERSION}_amd64.deb ($SIZE)"
}

# ── Run ───────────────────────────────────────────────────────

case "$(uname -s)" in
    Darwin) build_macos ;;
    Linux)  build_linux ;;
    *)      echo "Unsupported: $(uname -s)"; exit 1 ;;
esac

echo
echo "Done! Installers are in dist/"
