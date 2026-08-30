# Alresia StreamCam

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-blueviolet)](https://chrome.google.com/webstore)
[![Build Installers](https://github.com/nicepkg/AlresiaStreamCam/actions/workflows/build.yml/badge.svg)](https://github.com/nicepkg/AlresiaStreamCam/actions)

> A lightweight, local-first browser extension that functions as a streaming studio and virtual-camera system.
> **100% open source.** No cloud, no accounts, no tracking.

## Features

- 📷 **Camera Capture** — Select any connected camera
- 🖥️ **Tab Capture** — Capture any browser tab with audio
- 🪟 **Screen/Window Capture** — Capture your screen or specific windows
- 🎬 **Scene Compositor** — Multiple sources composed into a single scene with Canvas 2D
- ⏺️ **Local Recording** — Record your composition to a local file (WebM)
- 📡 **RTMP Streaming** — Stream to YouTube, Twitch, or any RTMP destination
- 🎭 **Multiple Scenes** — Switch between different source layouts
- 🎥 **Virtual Camera** — Cross-platform, no OBS dependency
- 🔒 **Local-First** — No cloud dependency, no video uploaded anywhere by default

## Quick Install

### Option 1: Download the Installer (Recommended)

Go to [**Releases**](https://github.com/nicepkg/AlresiaStreamCam/releases) and download the installer for your platform:

| Platform | File | Notes |
|----------|------|-------|
| **macOS** | `StreamCam-Installer.dmg` | Double-click to install |
| **Windows** | `StreamCam-Installer-Setup.exe` | Run the setup wizard |
| **Linux** | `StreamCam-Installer.deb` or `.AppImage` | Install or double-click |

The installer handles everything: Node.js, FFmpeg, native host, and virtual camera.

### Option 2: From Source

```bash
git clone https://github.com/nicepkg/AlresiaStreamCam.git
cd AlresiaStreamCam

# 1. Load the extension in chrome://extensions (Developer Mode → Load Unpacked)

# 2. Install the native host
cd native-host && npm install && node install.js --id=YOUR_EXTENSION_ID

# 3. Restart Chrome
```

## Requirements

- Google Chrome 117+ (or Chromium-based browser)
- Node.js 16+ (installer handles this automatically)
- FFmpeg (installer handles this automatically)
- **Virtual Camera:** Linux (auto-installed), macOS/Windows (compiles from source)

## Virtual Camera (Cross-Platform)

The extension ships its own virtual camera — **no OBS dependency**. Built from source on first use.

| Platform | Method | Setup |
|----------|--------|-------|
| **Linux** | v4l2loopback kernel module | Auto-installed on first use (needs sudo) |
| **macOS** | CoreMediaIO DAL plugin | Compiled from C source (needs Xcode CLT) |
| **Windows** | DirectShow source filter | Compiled from C source (needs VS Build Tools) |

**Linux** is fully automatic — the native host installs v4l2loopback, loads the kernel module, and persists across reboots.

**macOS/Windows** compile a lightweight native plugin from C source. The plugin registers as a system-wide virtual camera ("StreamCam Virtual Camera") that appears in Zoom, Meet, Teams, FaceTime, and any video app.

## Architecture

```
Extension (UI + Compositor)
    ↓ Canvas 2D rendering → captureStream()
Native Messaging
    ↓ JSON + base64 binary transport
Native Host (Node.js)
    ├── Pipe to FFmpeg → RTMP/RTMPS output (YouTube, Twitch, etc.)
    └── Virtual Camera:
        ├── Linux:   FFmpeg → v4l2loopback device (auto-installed)
        ├── macOS:   Unix socket → CoreMediaIO plugin (compiled from source)
        └── Windows: Named pipe → DirectShow filter (compiled from source)
```

## Project Structure

```
AlresiaStreamCam/
├── src/                          # Extension source code
│   ├── background/               # Service worker
│   ├── studio/                   # Main studio UI
│   ├── simple/                   # Simple mode
│   ├── streaming/                # Stream + virtual camera managers
│   ├── types/                    # Constants and enums
│   └── utils/                    # Event bus, logger, etc.
├── native-host/                  # Node.js native host
│   ├── host.js                   # Main host process
│   ├── install.js                # Host installer
│   ├── vcam-setup.js             # Cross-platform vcam setup
│   ├── platform/                 # Native vcam code (C source)
│   │   ├── macos/                # CoreMediaIO DAL plugin
│   │   └── windows/              # DirectShow filter
│   ├── installers/               # One-click install scripts
│   └── installer/                # Electron installer app
│       ├── main.js               # Electron main process
│       ├── renderer/             # Installer GUI
│       └── package.json          # electron-builder config
├── popup/                        # Extension popup
├── icons/                        # Extension icons
├── .github/workflows/build.yml   # CI/CD — builds .dmg, .exe, .deb
├── CONTRIBUTING.md               # How to contribute
├── LICENSE                       # MIT License
└── manifest.json                 # Chrome MV3 manifest
```

## Contributing

We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md) for:

- How to set up the development environment
- Project structure overview
- How the virtual camera and streaming work
- How to build the native installers
- Pull request guidelines

## Building Installers

The GitHub Actions workflow automatically builds native installers when you push a version tag:

```bash
git tag v1.0.0
git push origin v1.0.0
```

This triggers builds on macOS, Windows, and Linux, and creates a GitHub Release with:
- `StreamCam-Installer.dmg` (macOS)
- `StreamCam-Installer-Setup.exe` (Windows)
- `StreamCam-Installer.deb` (Linux)
- `StreamCam-Installer.AppImage` (Linux)

## Keyboard Shortcuts

- `Ctrl+R` — Toggle recording
- `Ctrl+Shift+R` — Toggle streaming

## Privacy

- **No cloud dependency** — Everything runs locally
- **No video uploaded** — Your video stays on your machine unless you choose to stream
- **Stream keys stored locally** — Never sent to any server except your RTMP destination
- **No analytics or tracking** — Zero network requests by default

## License

[MIT](LICENSE) — use it however you like.
