# Contributing to StreamCam

Thanks for your interest in contributing! StreamCam is an open-source streaming studio and virtual camera for Chrome.

## Getting Started

1. **Fork** this repository
2. **Clone** your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/AlresiaStreamCam.git
   cd AlresiaStreamCam
   ```
3. **Load the extension** in Chrome:
   - Open `chrome://extensions`
   - Enable "Developer mode"
   - Click "Load unpacked" → select the project root
4. **Install the native host** (for streaming/virtual camera):
   ```bash
   cd native-host
   npm install
   node install.js --id=YOUR_EXTENSION_ID
   ```

## Project Structure

```
AlresiaStreamCam/
├── src/                     # Extension source code
│   ├── background/          # Service worker
│   ├── studio/              # Main studio UI
│   ├── simple/              # Simple mode
│   ├── streaming/           # Stream + virtual camera managers
│   ├── types/               # Constants and enums
│   └── utils/               # Event bus, logger, etc.
├── native-host/             # Node.js native host (FFmpeg bridge)
│   ├── host.js              # Main host process
│   ├── install.js           # Host installer
│   ├── vcam-setup.js        # Cross-platform vcam setup
│   ├── platform/            # Native vcam code (C source + build scripts)
│   │   ├── macos/           # CoreMediaIO DAL plugin
│   │   └── windows/         # DirectShow filter
│   └── installer/           # Electron installer app
├── popup/                   # Extension popup
├── icons/                   # Extension icons
└── .github/workflows/       # CI/CD (GitHub Actions)
```

## How It Works

### Virtual Camera (Cross-Platform)

| Platform | Method | How it works |
|----------|--------|-------------|
| **Linux** | v4l2loopback | Auto-installed kernel module, FFmpeg writes frames |
| **macOS** | CoreMediaIO plugin | Compiled from C source, receives frames via Unix socket |
| **Windows** | DirectShow filter | Compiled from C source, receives frames via named pipe |

### Streaming

RTMP streaming uses FFmpeg via the native messaging host. The extension sends raw frames to the host, which pipes them to FFmpeg for encoding.

## Development Workflow

1. Make your changes in `src/`
2. Reload the extension in `chrome://extensions`
3. Refresh the studio page
4. Test your changes

### Building the Native Virtual Camera

On macOS/Windows, the virtual camera plugin compiles from C source on first use. To build manually:

```bash
# macOS
cd native-host/platform/macos
bash build.sh

# Windows (in Developer Command Prompt)
cd native-host\platform\windows
build.bat
```

### Building the Installer

```bash
cd native-host/installer
npm install
npm run build:mac    # macOS .dmg
npm run build:win    # Windows .exe
npm run build:linux  # Linux .deb + .AppImage
```

Or let GitHub Actions build it when you push a tag:
```bash
git tag v1.0.0
git push origin v1.0.0
```

## Submitting Changes

1. Create a feature branch: `git checkout -b feature/my-feature`
2. Make your changes and commit: `git commit -m "Add my feature"`
3. Push to your fork: `git push origin feature/my-feature`
4. Open a Pull Request against `main`

### Commit Messages

Use clear, descriptive commit messages:
- `Add recording quality settings`
- `Fix virtual camera frame rate on Linux`
- `Update README with new install instructions`

## Reporting Issues

- Use GitHub Issues for bug reports and feature requests
- Include your OS, Chrome version, and steps to reproduce
- For virtual camera issues, include the host log (check stderr)

## Code Style

- Vanilla JavaScript (no build system for the extension)
- ES modules for the service worker, globals for content scripts
- Follow existing patterns in the codebase
- Keep changes minimal and focused

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
