#!/usr/bin/env node

/**
 * Alresia StreamCam — Cross-Platform Virtual Camera Setup
 *
 * Handles virtual camera detection, compilation, and auto-setup:
 *
 * Linux:   Auto-installs v4l2loopback kernel module (full auto-setup)
 *          - Detects package manager (apt, dnf, pacman, zypper)
 *          - Installs v4l2loopback-dkms + v4l-utils
 *          - Loads kernel module with device label
 *          - Persists across reboots via /etc/modules-load.d/
 *
 * macOS:   Compiles CoreMediaIO DAL plugin from C source
 *          - Checks for Xcode Command Line Tools
 *          - Compiles platform/macos/streamcam-vcam.c → StreamCamVirtualCam.plugin
 *          - Plugin receives frames via Unix domain socket
 *
 * Windows: Compiles DirectShow source filter from C source
 *          - Checks for Visual Studio Build Tools (cl.exe)
 *          - Compiles platform/windows/streamcam-vcam.c → StreamCamVirtualCam.dll
 *          - Registers as virtual camera via regsvr32
 *          - Filter receives frames via named pipe
 */

'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

// ─── Configuration ────────────────────────────────────────────────

const DEVICE_NUM = 10;
const LABEL = 'StreamCam Virtual Camera';
const PLUGIN_NAME = 'StreamCamVirtualCam';
const SOCKET_PATH = '/tmp/streamcam-vcam.sock';
const PIPE_NAME = '\\\\.\\pipe\\streamcam-vcam';

// ─── Logging ──────────────────────────────────────────────────────

function log(msg) {
  process.stderr.write(`[vcam-setup] ${msg}\n`);
}

// ─── Platform Detection ───────────────────────────────────────────

function detectPlatform() {
  const platform = os.platform();
  switch (platform) {
    case 'linux': return 'linux';
    case 'darwin': return 'macos';
    case 'win32': return 'windows';
    default: return 'unsupported';
  }
}

// ─── Linux: v4l2loopback Auto-Setup ───────────────────────────────

function isV4l2LoopbackAvailable() {
  try {
    const lsmod = execSync('lsmod 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
    if (lsmod.includes('v4l2loopback')) return true;
  } catch { /* lsmod not available */ }

  const modprobeDir = '/lib/modules';
  try {
    const release = execSync('uname -r', { encoding: 'utf8', timeout: 3000 }).trim();
    const modulePath = path.join(modprobeDir, release, 'kernel', 'drivers', 'media', 'v4l2loopback.ko');
    const altPath = path.join(modprobeDir, release, 'extra', 'v4l2loopback.ko');
    if (fs.existsSync(modulePath) || fs.existsSync(altPath)) return true;
  } catch { /* ignore */ }

  return false;
}

function findV4l2LoopbackDevice() {
  const base = '/sys/class/video4linux';
  if (!fs.existsSync(base)) return null;

  try {
    const entries = fs.readdirSync(base);
    for (const entry of entries) {
      try {
        const namePath = path.join(base, entry, 'name');
        const name = fs.readFileSync(namePath, 'utf8').trim();
        if (/v4l2loopback|streamcam/i.test(name)) {
          return `/dev/${entry}`;
        }
      } catch { /* not readable — skip */ }
    }
  } catch { /* ignore */ }
  return null;
}

function detectPackageManager() {
  if (fs.existsSync('/usr/bin/apt') || fs.existsSync('/usr/bin/apt-get')) return 'apt';
  if (fs.existsSync('/usr/bin/dnf')) return 'dnf';
  if (fs.existsSync('/usr/bin/pacman')) return 'pacman';
  if (fs.existsSync('/usr/bin/zypper')) return 'zypper';
  return null;
}

function isSudoAvailable() {
  try {
    execSync('sudo -n true 2>/dev/null', { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function setupLinux() {
  const existingDevice = findV4l2LoopbackDevice();
  if (existingDevice) {
    return { status: 'ready', device: existingDevice, platform: 'linux' };
  }

  if (isV4l2LoopbackAvailable()) {
    try {
      execSync(
        `sudo modprobe v4l2loopback video_nr=${DEVICE_NUM} card_label="${LABEL}" exclusive_caps=1`,
        { timeout: 10000 }
      );
      const device = findV4l2LoopbackDevice();
      if (device) {
        return { status: 'ready', device, platform: 'linux' };
      }
    } catch (err) {
      log(`Failed to load v4l2loopback: ${err.message}`);
    }
  }

  const pm = detectPackageManager();
  if (!pm) {
    return {
      status: 'needs_setup',
      platform: 'linux',
      reason: 'No supported package manager found (apt, dnf, pacman, zypper).',
      manual: `Install v4l2loopback-dkms manually, then run:\n  sudo modprobe v4l2loopback video_nr=${DEVICE_NUM} card_label="${LABEL}" exclusive_caps=1`,
    };
  }

  if (!isSudoAvailable()) {
    return {
      status: 'needs_sudo',
      platform: 'linux',
      reason: 'v4l2loopback needs to be installed (requires sudo).',
      command: `sudo ${pm === 'apt' ? 'apt update && sudo apt install -y' : pm === 'dnf' ? 'dnf install -y' : pm === 'pacman' ? 'pacman -S --noconfirm' : 'zypper install -y'} v4l2loopback-dkms v4l-utils`,
    };
  }

  log('Installing v4l2loopback...');
  try {
    switch (pm) {
      case 'apt':
        execSync('sudo apt update -qq 2>/dev/null && sudo apt install -y v4l2loopback-dkms v4l-utils', {
          timeout: 120000, stdio: 'pipe',
        });
        break;
      case 'dnf':
        execSync('sudo dnf install -y v4l2loopback v4l-utils', {
          timeout: 120000, stdio: 'pipe',
        });
        break;
      case 'pacman':
        execSync('sudo pacman -S --noconfirm v4l2loopback-dkms v4l-utils', {
          timeout: 120000, stdio: 'pipe',
        });
        break;
      case 'zypper':
        execSync('sudo zypper install -y v4l2loopback-kmp-default v4l-utils', {
          timeout: 120000, stdio: 'pipe',
        });
        break;
    }
    log('v4l2loopback installed');
  } catch (err) {
    return {
      status: 'error',
      platform: 'linux',
      reason: `Failed to install v4l2loopback: ${err.message}`,
    };
  }

  log('Loading v4l2loopback kernel module...');
  try {
    execSync(
      `sudo modprobe v4l2loopback video_nr=${DEVICE_NUM} card_label="${LABEL}" exclusive_caps=1`,
      { timeout: 10000 }
    );
  } catch (err) {
    return {
      status: 'error',
      platform: 'linux',
      reason: `Installed v4l2loopback but failed to load kernel module: ${err.message}`,
    };
  }

  const device = findV4l2LoopbackDevice();
  if (device) {
    persistLinuxSetup();
    return { status: 'ready', device, platform: 'linux' };
  }

  return {
    status: 'error',
    platform: 'linux',
    reason: 'v4l2loopback installed and loaded but device not found. Try rebooting.',
  };
}

function persistLinuxSetup() {
  try {
    const modulesConf = '/etc/modules-load.d/v4l2loopback.conf';
    if (!fs.existsSync(modulesConf)) {
      execSync(`echo 'v4l2loopback' | sudo tee ${modulesConf} > /dev/null`, { timeout: 5000 });
      log(`Persisted module load: ${modulesConf}`);
    }
    const modprobeConf = '/etc/modprobe.d/v4l2loopback.conf';
    if (!fs.existsSync(modprobeConf)) {
      const opts = `options v4l2loopback video_nr=${DEVICE_NUM} card_label="${LABEL}" exclusive_caps=1`;
      execSync(`echo '${opts}' | sudo tee ${modprobeConf} > /dev/null`, { timeout: 5000 });
      log(`Persisted module options: ${modprobeConf}`);
    }
  } catch (err) {
    log(`Warning: could not persist setup across reboots: ${err.message}`);
  }
}

// ─── macOS: CoreMediaIO DAL Plugin ────────────────────────────────

function getPluginPath() {
  return path.join(__dirname, 'platform', 'macos', 'build', `${PLUGIN_NAME}.plugin`);
}

function getPluginBinary() {
  return path.join(getPluginPath(), 'Contents', 'MacOS', PLUGIN_NAME);
}

function isMacOSPluginInstalled() {
  return fs.existsSync(getPluginBinary());
}

function hasXcodeCommandLineTools() {
  try {
    execSync('xcode-select -p 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function buildMacOSPlugin() {
  log('Building macOS virtual camera plugin...');

  if (!hasXcodeCommandLineTools()) {
    return {
      status: 'needs_build_tools',
      platform: 'macos',
      reason: 'Xcode Command Line Tools are required to compile the virtual camera plugin.',
      command: 'xcode-select --install',
      manual: 'Install Xcode Command Line Tools, then re-run the installer.',
    };
  }

  const buildScript = path.join(__dirname, 'platform', 'macos', 'build.sh');
  if (!fs.existsSync(buildScript)) {
    return {
      status: 'error',
      platform: 'macos',
      reason: 'Build script not found: ' + buildScript,
    };
  }

  try {
    execSync(`bash "${buildScript}"`, {
      timeout: 120000,
      stdio: 'pipe',
      cwd: path.join(__dirname, 'platform', 'macos'),
    });
    log('macOS plugin built successfully');
    return { status: 'ready', platform: 'macos', method: 'coremediaio' };
  } catch (err) {
    return {
      status: 'error',
      platform: 'macos',
      reason: `Failed to build virtual camera plugin: ${err.message}`,
    };
  }
}

function setupMacOS() {
  if (isMacOSPluginInstalled()) {
    return { status: 'ready', platform: 'macos', method: 'coremediaio', device: 'StreamCam Virtual Camera' };
  }

  return buildMacOSPlugin();
}

// ─── Windows: DirectShow Source Filter ────────────────────────────

function getWindowsDllPath() {
  return path.join(__dirname, 'platform', 'windows', 'build', 'StreamCamVirtualCam.dll');
}

function isWindowsFilterInstalled() {
  return fs.existsSync(getWindowsDllPath());
}

function hasMSVC() {
  try {
    execSync('cl 2>&1', { encoding: 'utf8', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function buildWindowsFilter() {
  log('Building Windows virtual camera filter...');

  if (!hasMSVC()) {
    return {
      status: 'needs_build_tools',
      platform: 'windows',
      reason: 'Visual Studio Build Tools (cl.exe) are required to compile the virtual camera filter.',
      command: 'winget install Microsoft.VisualStudio.2022.BuildTools',
      manual: 'Install Visual Studio Build Tools, then open "Developer Command Prompt" and re-run.',
    };
  }

  const buildScript = path.join(__dirname, 'platform', 'windows', 'build.bat');
  if (!fs.existsSync(buildScript)) {
    return {
      status: 'error',
      platform: 'windows',
      reason: 'Build script not found: ' + buildScript,
    };
  }

  try {
    execSync(`"${buildScript}"`, {
      timeout: 120000,
      stdio: 'pipe',
      shell: true,
      cwd: path.join(__dirname, 'platform', 'windows'),
    });
    log('Windows filter built successfully');

    // Register the DLL
    const dllPath = getWindowsDllPath();
    try {
      execSync(`regsvr32 /s "${dllPath}"`, { timeout: 10000 });
      log('Windows filter registered');
    } catch (err) {
      log(`Warning: could not register filter (may need admin): ${err.message}`);
    }

    return { status: 'ready', platform: 'windows', method: 'directshow', device: 'StreamCam Virtual Camera' };
  } catch (err) {
    return {
      status: 'error',
      platform: 'windows',
      reason: `Failed to build virtual camera filter: ${err.message}`,
    };
  }
}

function setupWindows() {
  if (isWindowsFilterInstalled()) {
    return { status: 'ready', platform: 'windows', method: 'directshow', device: 'StreamCam Virtual Camera' };
  }

  return buildWindowsFilter();
}

// ─── Binary Path Helpers ──────────────────────────────────────────
// Used by host.js to find and launch the compiled virtual camera binary

function getBinaryPath() {
  const platform = detectPlatform();
  switch (platform) {
    case 'linux':
      return findV4l2LoopbackDevice(); // No separate binary — FFmpeg writes directly
    case 'macos':
      return getPluginBinary();
    case 'windows':
      return getWindowsDllPath();
    default:
      return null;
  }
}

function getSocketPath() {
  const platform = detectPlatform();
  if (platform === 'macos') return SOCKET_PATH;
  if (platform === 'windows') return PIPE_NAME;
  return null; // Linux uses v4l2 device directly
}

// ─── Main Entry Point ─────────────────────────────────────────────

function autoSetup() {
  const platform = detectPlatform();
  log(`Platform: ${platform}`);

  switch (platform) {
    case 'linux': return setupLinux();
    case 'macos': return setupMacOS();
    case 'windows': return setupWindows();
    default:
      return {
        status: 'unsupported',
        platform,
        reason: `Virtual camera is not supported on ${os.platform()}.`,
      };
  }
}

function quickCheck() {
  const platform = detectPlatform();

  switch (platform) {
    case 'linux': {
      const device = findV4l2LoopbackDevice();
      if (device) return { available: true, platform, device };
      if (isV4l2LoopbackAvailable()) return { available: false, platform, reason: 'v4l2loopback installed but not loaded' };
      return { available: false, platform, reason: 'v4l2loopback not installed' };
    }
    case 'macos': {
      if (isMacOSPluginInstalled()) return { available: true, platform, method: 'coremediaio', device: 'StreamCam Virtual Camera' };
      return { available: false, platform, reason: 'Virtual camera plugin not compiled yet' };
    }
    case 'windows': {
      if (isWindowsFilterInstalled()) return { available: true, platform, method: 'directshow', device: 'StreamCam Virtual Camera' };
      return { available: false, platform, reason: 'Virtual camera filter not compiled yet' };
    }
    default:
      return { available: false, platform, reason: 'Unsupported platform' };
  }
}

// ─── CLI Interface ────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0] || 'setup';

  switch (command) {
    case 'setup':
    case 'auto-setup': {
      const result = autoSetup();
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.status === 'ready' ? 0 : 1);
      break;
    }
    case 'check': {
      const result = quickCheck();
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.available ? 0 : 1);
      break;
    }
    case 'binary': {
      const binary = getBinaryPath();
      const socket = getSocketPath();
      console.log(JSON.stringify({ binary, socket }, null, 2));
      break;
    }
    default:
      console.error('Usage: node vcam-setup.js [setup|check|binary]');
      process.exit(1);
  }
}

module.exports = {
  autoSetup, quickCheck, detectPlatform,
  setupLinux, setupMacOS, setupWindows,
  getBinaryPath, getSocketPath,
  findV4l2LoopbackDevice,
};
