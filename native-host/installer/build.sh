#!/bin/bash
# StreamCam Installer — Build Script
#
# Builds native installers (.dmg, .exe, .deb, .AppImage)
# Run this from the native-host/installer/ directory.
#
# Requirements:
#   - Node.js 16+
#   - For macOS builds: macOS
#   - For Windows builds: Windows (or Wine)
#   - For Linux builds: Linux

set -e

echo "StreamCam Installer — Build"
echo "============================"
echo

# Install dependencies
echo "Installing Electron and builder..."
npm install

echo
echo "Building installer for current platform..."
echo

case "$(uname -s)" in
  Darwin)
    echo "Building macOS .dmg..."
    npm run build:mac
    echo
    echo "Built: dist/StreamCam Installer-{version}.dmg"
    ;;
  Linux)
    echo "Building Linux .deb and .AppImage..."
    npm run build:linux
    echo
    echo "Built: dist/StreamCam Installer-{version}.deb"
    echo "       dist/StreamCam Installer-{version}.AppImage"
    ;;
  MINGW*|CYGWIN*|MSYS*)
    echo "Building Windows .exe..."
    npm run build:win
    echo
    echo "Built: dist/StreamCam Installer Setup {version}.exe"
    ;;
  *)
    echo "Unsupported platform: $(uname -s)"
    exit 1
    ;;
esac

echo
echo "Done! Installer is in the dist/ folder."
