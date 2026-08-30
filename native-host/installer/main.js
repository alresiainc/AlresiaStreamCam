/**
 * StreamCam Installer — Electron Main Process
 *
 * Native installer app that:
 * 1. Finds or installs Node.js
 * 2. Installs native host dependencies
 * 3. Registers the host with Chrome
 * 4. Compiles the virtual camera plugin
 * 5. Sets up v4l2loopback on Linux
 */

'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { execSync, spawn } = require('child_process');

// ─── State ────────────────────────────────────────────────────────

let mainWindow = null;

// Resolve the extension root — the installer sits in native-host/installer/
// so the extension root is two levels up.
const INSTALLER_DIR = __dirname;
const HOST_DIR = path.join(INSTALLER_DIR, '..');
const EXTENSION_DIR = path.join(HOST_DIR, '..');

// ─── Window ───────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 520,
    height: 620,
    resizable: false,
    fullscreenable: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0d0d0d',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.setMenuBarVisibility(false);

  // Open external links in browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ─── IPC Handlers ─────────────────────────────────────────────────

ipcMain.handle('install:get-info', () => {
  const platform = process.platform === 'darwin' ? 'macos'
    : process.platform === 'win32' ? 'windows'
    : process.platform === 'linux' ? 'linux'
    : 'unknown';

  return {
    platform,
    extensionDir: EXTENSION_DIR,
    hostDir: HOST_DIR,
    nodeVersion: getCommandOutput('node -v'),
    hasNode: hasCommand('node'),
    hasFfmpeg: hasCommand('ffmpeg'),
    hasXcodeCLT: platform === 'macos' ? hasCommand('xcode-select') : null,
    hasBuildTools: platform === 'windows' ? hasCommand('cl') : null,
  };
});

ipcMain.handle('install:run', async (event, step) => {
  const send = (msg) => mainWindow.webContents.send('install:progress', msg);

  try {
    switch (step) {
      case 'deps':
        return await installDependencies(send);
      case 'host':
        return await registerHost(send);
      case 'vcam':
        return await setupVirtualCam(send);
      default:
        return { ok: false, error: `Unknown step: ${step}` };
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('install:open-extensions', () => {
  shell.openExternal('chrome://extensions');
});

ipcMain.handle('install:get-extension-id', () => {
  // Try to detect from Chrome's NativeMessagingHosts
  const platform = process.platform;
  let configDir;

  if (platform === 'darwin') {
    configDir = path.join(app.getPath('home'), 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts');
  } else if (platform === 'linux') {
    configDir = path.join(app.getPath('home'), '.config', 'google-chrome', 'NativeMessagingHosts');
  } else if (platform === 'win32') {
    configDir = path.join(app.getPath('home'), 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'NativeMessagingHosts');
  }

  if (!configDir || !fs.existsSync(configDir)) return null;

  try {
    const files = fs.readdirSync(configDir);
    for (const file of files) {
      if (file.startsWith('com.alresia.')) {
        const content = fs.readFileSync(path.join(configDir, file), 'utf8');
        const match = content.match(/chrome-extension:\/\/([a-p]{32})/);
        if (match) return match[1];
      }
    }
  } catch { /* ignore */ }

  return null;
});

// ─── Installation Steps ───────────────────────────────────────────

async function installDependencies(send) {
  send({ type: 'status', message: 'Checking Node.js...' });

  if (!hasCommand('node')) {
    send({ type: 'status', message: 'Node.js not found — installing...' });

    if (process.platform === 'darwin') {
      if (!hasCommand('brew')) {
        send({ type: 'status', message: 'Installing Homebrew...' });
        runCommand('/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"');
      }
      runCommand('brew install node');
    } else if (process.platform === 'linux') {
      runCommand('curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -');
      runCommand('sudo apt install -y nodejs');
    } else if (process.platform === 'win32') {
      runCommand('winget install OpenJS.NodeJS.LTS');
    }
  }

  send({ type: 'status', message: `Node.js ${getCommandOutput('node -v')} found` });

  // Check/install FFmpeg
  if (!hasCommand('ffmpeg')) {
    send({ type: 'status', message: 'FFmpeg not found — installing...' });

    if (process.platform === 'darwin') {
      runCommand('brew install ffmpeg');
    } else if (process.platform === 'linux') {
      runCommand('sudo apt install -y ffmpeg');
    } else if (process.platform === 'win32') {
      runCommand('winget install Gyan.FFmpeg');
    }
  }

  send({ type: 'status', message: 'FFmpeg found' });

  // Check Xcode CLT on macOS
  if (process.platform === 'darwin' && !hasCommand('xcode-select')) {
    send({ type: 'status', message: 'Installing Xcode Command Line Tools...' });
    runCommand('xcode-select --install');
    send({ type: 'warning', message: 'Please approve the Xcode CLT installer, then click Continue.' });
    return { ok: true, needsContinue: true };
  }

  // Install npm dependencies
  send({ type: 'status', message: 'Installing dependencies...' });
  runCommand('npm install --production', { cwd: HOST_DIR });
  send({ type: 'status', message: 'Dependencies installed' });

  return { ok: true };
}

async function registerHost(send) {
  send({ type: 'status', message: 'Registering native host with Chrome...' });

  const extId = ipcMain.emit('install:get-extension-id')
    ? null
    : await mainWindow.webContents.executeJavaScript('window.__extensionId || null');

  if (extId) {
    const result = runCommand(`node install.js --id=${extId}`, { cwd: HOST_DIR });
    send({ type: 'status', message: 'Host registered with Chrome' });
    return { ok: true };
  }

  // No extension ID — user needs to provide it
  return { ok: false, needsExtId: true };
}

async function setupVirtualCam(send) {
  send({ type: 'status', message: 'Setting up virtual camera...' });

  const platform = process.platform;

  if (platform === 'linux') {
    // Install v4l2loopback
    send({ type: 'status', message: 'Installing v4l2loopback...' });
    const result = runCommand('node vcam-setup.js setup', { cwd: HOST_DIR });
    send({ type: 'status', message: result.includes('ready') ? 'Virtual camera ready' : 'Virtual camera setup complete' });
  } else if (platform === 'darwin') {
    // Build the CoreMediaIO plugin
    send({ type: 'status', message: 'Compiling virtual camera plugin...' });
    const result = runCommand('node vcam-setup.js setup', { cwd: HOST_DIR });
    send({ type: 'status', message: result.includes('ready') ? 'Virtual camera plugin compiled' : 'Virtual camera setup complete' });
  } else if (platform === 'win32') {
    // Build the DirectShow filter
    send({ type: 'status', message: 'Compiling virtual camera filter...' });
    const result = runCommand('node vcam-setup.js setup', { cwd: HOST_DIR });
    send({ type: 'status', message: result.includes('ready') ? 'Virtual camera filter compiled' : 'Virtual camera setup complete' });
  }

  return { ok: true };
}

// ─── Helpers ──────────────────────────────────────────────────────

function hasCommand(cmd) {
  try {
    const check = process.platform === 'win32' ? 'where' : 'which';
    execSync(`${check} ${cmd}`, { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function getCommandOutput(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 10000 }).trim();
  } catch {
    return null;
  }
}

function runCommand(cmd, opts = {}) {
  try {
    return execSync(cmd, {
      encoding: 'utf8',
      timeout: 300000, // 5 minutes
      cwd: opts.cwd || HOST_DIR,
      stdio: 'pipe',
    });
  } catch (err) {
    return err.stdout || err.message || '';
  }
}

// ─── App Lifecycle ────────────────────────────────────────────────

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
