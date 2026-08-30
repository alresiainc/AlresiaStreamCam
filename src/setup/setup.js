/**
 * StreamCam Setup Page
 *
 * Two paths:
 * 1. Download the proper native installer (.dmg / .exe / .deb / .AppImage)
 * 2. Copy a one-liner terminal command as fallback
 */

'use strict';

const extId = chrome.runtime.id;

// ─── Platform Detection ───────────────────────────────────────────

function detectPlatform() {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('mac')) return 'macos';
  if (ua.includes('win')) return 'windows';
  if (ua.includes('linux')) return 'linux';
  return 'unknown';
}

function getInstallerName(platform) {
  switch (platform) {
    case 'macos': return { file: 'StreamCam-Installer.dmg', label: 'macOS (.dmg)', icon: '🍎' };
    case 'windows': return { file: 'StreamCam-Installer-Setup.exe', label: 'Windows (.exe)', icon: '🪟' };
    case 'linux': return { file: 'StreamCam-Installer.AppImage', label: 'Linux (.AppImage)', icon: '🐧' };
    default: return null;
  }
}

function getTerminalCommand(platform) {
  return `cd native-host && npm install && node install.js --id=${extId}`;
}

// ─── UI ───────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  const platform = detectPlatform();
  const installer = getInstallerName(platform);

  // Platform badge
  const badge = document.getElementById('platformBadge');
  if (installer) {
    badge.textContent = `${installer.icon} ${installer.label}`;
  } else {
    badge.textContent = 'Platform not detected';
  }

  // ── Installer Download Button ──────────────────────────────
  const downloadBtn = document.getElementById('downloadBtn');
  const statusMsg = document.getElementById('statusMsg');
  const checkBtn = document.getElementById('checkBtn');

  // Check if installer exists in the extension
  const installerUrl = installer
    ? chrome.runtime.getURL(`native-host/installers/${installer.file}`)
    : null;

  // For now, show a link to releases or the terminal fallback
  // The proper installer would be hosted as a release artifact
  downloadBtn.addEventListener('click', () => {
    if (installerUrl) {
      // Try to download from extension
      chrome.downloads.download({
        url: installerUrl,
        filename: installer.file,
        saveAs: false,
      }).then(() => {
        statusMsg.textContent = '✓ Downloaded! Check your Downloads folder, then double-click the file.';
        statusMsg.className = 'status-msg ok';
        checkBtn.style.display = 'inline-block';
      }).catch(() => {
        // Installer not bundled — show release link
        statusMsg.innerHTML = `Installer not bundled yet. Use the terminal command below, or <a href="https://github.com/nicepkg/streamcam/releases" target="_blank" style="color:#f5a623;">check releases</a> for the latest installer.`;
        statusMsg.className = 'status-msg err';
      });
    }
  });

  // ── Terminal Command (fallback) ────────────────────────────
  const cmdBlock = document.getElementById('cmdBlock');
  const cmd = getTerminalCommand(platform);
  cmdBlock.textContent = cmd;

  // Add copy label back
  const copyLabel = document.createElement('span');
  copyLabel.className = 'copy-label';
  copyLabel.textContent = 'click to copy';
  cmdBlock.appendChild(copyLabel);

  cmdBlock.addEventListener('click', () => {
    navigator.clipboard.writeText(cmd).then(() => {
      cmdBlock.classList.add('copied');
      copyLabel.textContent = 'copied!';
      setTimeout(() => {
        cmdBlock.classList.remove('copied');
        copyLabel.textContent = 'click to copy';
      }, 2000);
    }).catch(() => {
      // Fallback
      const range = document.createRange();
      range.selectNodeContents(cmdBlock);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
    });
  });

  // ── Check Connection ───────────────────────────────────────
  checkBtn.addEventListener('click', async () => {
    checkBtn.disabled = true;
    checkBtn.textContent = 'Checking…';
    statusMsg.textContent = '';
    statusMsg.className = 'status-msg';

    try {
      const conn = await chrome.runtime.sendMessage({ type: 'native:connect' });
      if (conn && conn.ok) {
        statusMsg.textContent = '✓ Connected! You can close this tab and restart Chrome.';
        statusMsg.className = 'status-msg ok';
      } else {
        statusMsg.textContent = `✗ ${conn?.error || 'Not connected. Run the installer and restart Chrome.'}`;
        statusMsg.className = 'status-msg err';
      }
    } catch (err) {
      statusMsg.textContent = `✗ ${err.message}`;
      statusMsg.className = 'status-msg err';
    }

    checkBtn.disabled = false;
    checkBtn.textContent = 'Check Connection';
  });

  // ── Note ───────────────────────────────────────────────────
  const noteEl = document.getElementById('noteText');
  noteEl.innerHTML = `Extension ID: <code>${extId}</code>`;
});
