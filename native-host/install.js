#!/usr/bin/env node

/**
 * Alresia StreamCam — Native Host Installer
 *
 * Registers the native messaging host with Chrome/Chromium and sets up
 * the virtual camera. Fully automatic — no manual prompts needed.
 *
 * Usage:
 *   node install.js                  # Install (auto-detect extension ID)
 *   node install.js --id=<ext-id>    # Install with explicit extension ID
 *   node install.js --global         # Install for all users (requires admin/sudo)
 *   node install.js --auto           # Non-interactive mode (skip prompts)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const vcamSetup = require('./vcam-setup');

// ─── Configuration ────────────────────────────────────────────────

const HOST_NAME = 'com.alresia.streamcam.host';
const HOST_PATH = path.join(__dirname, 'host.js');
const EXTENSION_ID_RE = /^[a-p]{32}$/; // Chrome extension IDs are 32 lowercase letters a-p

// ─── Platform Paths ───────────────────────────────────────────────

function getChromeNativeMessagingDir() {
  const platform = os.platform();
  const home = os.homedir();

  switch (platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts');

    case 'win32':
      // Per-user
      return path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'NativeMessagingHosts');

    case 'linux':
      return path.join(home, '.config', 'google-chrome', 'NativeMessagingHosts');

    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
}

function getEdgeNativeMessagingDir() {
  const platform = os.platform();
  const home = os.homedir();

  switch (platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Microsoft Edge', 'NativeMessagingHosts');

    case 'win32':
      return path.join(home, 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data', 'NativeMessagingHosts');

    case 'linux':
      return path.join(home, '.config', 'microsoft-edge', 'NativeMessagingHosts');

    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
}

// ─── Extension ID Detection ───────────────────────────────────────
// Try to auto-detect the extension ID from manifest.json in the
// parent directory (the extension root). Falls back to prompting.

function findExtensionManifest() {
  // The native-host dir is typically at <extension-root>/native-host/
  // so manifest.json is one level up.
  const parentDir = path.join(__dirname, '..');
  const manifestPath = path.join(parentDir, 'manifest.json');

  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      // We can't get the extension ID from manifest.json directly (it's assigned by Chrome),
      // but we can verify the extension structure exists.
      return { manifestPath, parentDir, manifest };
    } catch { /* invalid JSON */ }
  }

  // Also check current directory (if run from extension root)
  const localManifest = path.join(process.cwd(), 'manifest.json');
  if (fs.existsSync(localManifest)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(localManifest, 'utf8'));
      return { manifestPath: localManifest, parentDir: process.cwd(), manifest };
    } catch { /* invalid JSON */ }
  }

  return null;
}

function resolveExtensionId() {
  // Check command-line argument first
  const argId = process.argv.find((a) => a.startsWith('--id='));
  if (argId) return Promise.resolve(argId.slice('--id='.length).trim());

  // Check for cached ID (saved from previous install)
  const cachePath = path.join(__dirname, '.extension-id');
  if (fs.existsSync(cachePath)) {
    try {
      const cached = fs.readFileSync(cachePath, 'utf8').trim();
      if (EXTENSION_ID_RE.test(cached)) {
        console.log(`Using cached extension ID: ${cached}`);
        return Promise.resolve(cached);
      }
    } catch { /* ignore */ }
  }

  // Check if running in auto mode (no prompts)
  if (process.argv.includes('--auto')) {
    return Promise.resolve(null);
  }

  // Prompt the user
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(
      '\nExtension ID (chrome://extensions → enable Developer Mode → copy the ID under Alresia StreamCam).\n' +
      'If you haven\'t loaded the extension yet, press Enter to skip (you can re-run later with --id=<id>): ',
      (answer) => {
        rl.close();
        resolve(answer.trim() || null);
      }
    );
  });
}

function saveExtensionId(id) {
  if (!id) return;
  try {
    fs.writeFileSync(path.join(__dirname, '.extension-id'), id);
  } catch { /* ignore */ }
}

// ─── Install ──────────────────────────────────────────────────────

async function install() {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║   Alresia StreamCam — Native Host Installer     ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  const extensionId = await resolveExtensionId();
  const isGlobal = process.argv.includes('--global');
  const autoMode = process.argv.includes('--auto');

  // ── Step 1: Register Native Messaging Host ──────────────────────

  console.log('Step 1: Registering native messaging host...\n');

  const dirs = [getChromeNativeMessagingDir()];
  if (os.platform() === 'darwin' || os.platform() === 'linux') {
    try { dirs.push(getEdgeNativeMessagingDir()); } catch { /* ignore */ }
  }

  // Resolve the actual host.js path
  const hostPath = path.resolve(HOST_PATH);
  if (!fs.existsSync(hostPath)) {
    console.error(`Host script not found: ${hostPath}`);
    process.exit(1);
  }

  // Make host.js executable (Unix)
  if (os.platform() !== 'win32') {
    fs.chmodSync(hostPath, 0o755);
  }

  let anySucceeded = false;
  let manifestPath = null;

  if (extensionId) {
    // Create the native messaging manifest
    const manifest = {
      name: HOST_NAME,
      description: 'Alresia StreamCam native host for RTMP streaming and virtual camera',
      path: os.platform() === 'win32'
        ? hostPath.replace(/\//g, '\\')
        : hostPath,
      type: 'stdio',
      allowed_origins: [
        `chrome-extension://${extensionId}/`,
      ],
    };

    console.log(`Host name: ${HOST_NAME}`);
    console.log(`Host path: ${hostPath}`);
    console.log(`Extension ID: ${extensionId}`);

    for (const dir of dirs) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        manifestPath = path.join(dir, `${HOST_NAME}.json`);
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
        console.log(`✓ Installed to: ${manifestPath}`);
        anySucceeded = true;
      } catch (err) {
        console.error(`✗ Failed to install to ${dir}: ${err.message}`);
      }
    }

    if (anySucceeded) {
      saveExtensionId(extensionId);
    }
  } else {
    console.log('No extension ID provided — skipping native host registration.');
    console.log('Run again with --id=<your-extension-id> after loading the extension.\n');
  }

  // ── Step 2: Setup Virtual Camera ────────────────────────────────

  console.log('\nStep 2: Setting up virtual camera...\n');

  const vcamResult = vcamSetup.autoSetup();

  switch (vcamResult.status) {
    case 'ready':
      if (vcamResult.platform === 'linux') {
        console.log(`✓ Virtual camera ready: ${vcamResult.device}`);
        console.log('  v4l2loopback is installed and the device is available.');
      } else if (vcamResult.platform === 'macos' || vcamResult.platform === 'windows') {
        console.log(`✓ Virtual camera plugin ready (${vcamResult.method}).`);
      }
      break;

    case 'needs_sudo':
      console.log(`⚠ ${vcamResult.reason}`);
      console.log(`  Run this command to install v4l2loopback:\n    ${vcamResult.command}\n`);
      break;

    case 'needs_build_tools':
      console.log(`⚠ ${vcamResult.reason}`);
      if (vcamResult.command) {
        console.log(`  Run: ${vcamResult.command}`);
      }
      if (vcamResult.manual) {
        console.log(`  ${vcamResult.manual}`);
      }
      break;

    case 'needs_setup':
      console.log(`⚠ ${vcamResult.reason}`);
      if (vcamResult.manual) {
        console.log(`  ${vcamResult.manual}`);
      }
      break;

    case 'error':
      console.error(`✗ Virtual camera setup failed: ${vcamResult.reason}`);
      break;

    default:
      console.log(`Virtual camera status: ${vcamResult.status}`);
      if (vcamResult.reason) console.log(`  ${vcamResult.reason}`);
  }

  // ── Step 3: Check FFmpeg ────────────────────────────────────────

  console.log('\nStep 3: Checking dependencies...\n');

  checkFfmpeg();

  // ── Done ────────────────────────────────────────────────────────

  console.log('\n═══════════════════════════════════════════════════');
  console.log('Installation complete!\n');

  if (!extensionId) {
    console.log('Next steps:');
    console.log('1. Load the extension in chrome://extensions (Developer Mode → Load Unpacked)');
    console.log('2. Run this installer again with --id=<your-extension-id>');
    console.log('3. Restart Chrome to pick up the native messaging host');
  } else {
    console.log('Next steps:');
    console.log('1. Make sure ffmpeg is installed and on your PATH (see check above).');
    console.log('2. Fully restart Chrome (native messaging hosts are only read at browser startup).');
    console.log('3. Click "Add destination" → "Go Live" in the studio to test the connection.');
    if (vcamResult.platform !== 'linux') {
      console.log('4. For virtual camera: the plugin compiles on first use. Select "StreamCam Virtual Camera" in your video app.');
    }
  }
  console.log('═══════════════════════════════════════════════════\n');
}

function checkFfmpeg() {
  const { spawnSync } = require('child_process');
  const result = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  if (result.error || result.status !== 0) {
    console.warn('⚠ Could not find "ffmpeg" on your PATH.');
    console.warn('  RTMP streaming needs it. Install it with:');
    console.warn('    macOS:   brew install ffmpeg');
    console.warn('    Linux:   sudo apt install ffmpeg');
    console.warn('    Windows: winget install ffmpeg  (or download from ffmpeg.org)');
  } else {
    console.log('✓ ffmpeg found on PATH.');
  }
}

// ─── Run ──────────────────────────────────────────────────────────

install();
