#!/bin/bash
#
# StreamCam Virtual Camera — macOS Build Script
#
# Compiles the CoreMediaIO DAL plugin that creates a virtual camera on macOS.
# Run this once (or the native host runs it automatically on first use).
#
# Requirements: Xcode Command Line Tools (xcode-select --install)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE="$SCRIPT_DIR/streamcam-vcam.c"
BUILD_DIR="$SCRIPT_DIR/build"
PLUGIN_DIR="$BUILD_DIR/StreamCamVirtualCam.plugin"

echo "StreamCam Virtual Camera — macOS Build"
echo "======================================="
echo

# Check for compiler
if ! command -v clang &>/dev/null; then
    echo "Error: clang not found."
    echo "Install Xcode Command Line Tools: xcode-select --install"
    exit 1
fi

echo "Source: $SOURCE"
echo "Output: $PLUGIN_DIR/Contents/MacOS/StreamCamVirtualCam"
echo

# Create plugin bundle structure
mkdir -p "$PLUGIN_DIR/Contents/MacOS"
mkdir -p "$PLUGIN_DIR/Contents/Resources"

# Create Info.plist
cat > "$PLUGIN_DIR/Contents/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key>
    <string>English</string>
    <key>CFBundleExecutable</key>
    <string>StreamCamVirtualCam</string>
    <key>CFBundleIdentifier</key>
    <string>com.alresia.streamcam.virtualcam</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleName</key>
    <string>StreamCam Virtual Camera</string>
    <key>CFBundlePackageType</key>
    <string>BNDL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>CMIOPlugin Categories</key>
    <array>
        <string>2</string>
    </array>
    <key>NSHumanReadableCopyright</key>
    <string>Copyright © 2024 Alresia. MIT License.</string>
</dict>
</plist>
PLIST

# Compile
echo "Compiling..."
clang -dynamiclib \
    -framework CoreMediaIO \
    -framework CoreVideo \
    -framework CoreFoundation \
    -framework Foundation \
    -arch arm64 -arch x86_64 \
    -mmacosx-version-min=11.0 \
    -O2 \
    -Wall \
    -Wextra \
    -o "$PLUGIN_DIR/Contents/MacOS/StreamCamVirtualCam" \
    "$SOURCE" \
    2>&1

if [ $? -ne 0 ]; then
    echo
    echo "Build failed. Make sure Xcode Command Line Tools are installed:"
    echo "  xcode-select --install"
    exit 1
fi

# Make executable
chmod +x "$PLUGIN_DIR/Contents/MacOS/StreamCamVirtualCam"

echo
echo "Build successful!"
echo "Plugin: $PLUGIN_DIR"
echo
echo "To install system-wide, copy to:"
echo "  ~/Library/QuickLook/StreamCamVirtualCam.qlgenerator"
echo "  (or the native host will link it automatically)"
