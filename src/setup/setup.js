/**
 * StreamCam Setup Page
 *
 * Auto-detects platform, downloads the correct installer from GitHub,
 * and guides the user through a one-click setup.
 */

'use strict';

const extId = chrome.runtime.id;
const GITHUB_REPO = 'alresiainc/AlresiaStreamCam';
const RELEASE_TAG = 'v1.0.0';

// ─── Platform Detection ───────────────────────────────────────────

function detectPlatform() {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('mac')) return 'macos';
  if (ua.includes('win')) return 'windows';
  if (ua.includes('linux')) return 'linux';
  return 'unknown';
}

function getInstallerInfo(platform) {
  const baseUrl = `https://github.com/${GITHUB_REPO}/releases/download/${RELEASE_TAG}`;
  switch (platform) {
    case 'macos':
      return {
        name: 'StreamCam Installer.dmg',
        url: `${baseUrl}/StreamCam.Installer-1.0.0.dmg`,
        icon: '🍎',
        label: 'macOS',
        hint: 'Double-click the .dmg, then drag to Applications',
      };
    case 'windows':
      return {
        name: 'StreamCam Installer Setup.exe',
        url: `${baseUrl}/StreamCam.Installer.Setup.1.0.0.exe`,
        icon: '🪟',
        label: 'Windows',
        hint: 'Run the .exe and follow the wizard',
      };
    case 'linux':
      return {
        name: 'StreamCam Installer.AppImage',
        url: `${baseUrl}/StreamCam.Installer-1.0.0.AppImage`,
        icon: '🐧',
        label: 'Linux',
        hint: 'Make it executable and run, or use the .deb for Debian/Ubuntu',
      };
    default:
      return null;
  }
}

// ─── UI ───────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  const platform = detectPlatform();
  const installer = getInstallerInfo(platform);
  const statusMsg = document.getElementById('statusMsg');
  const checkBtn = document.getElementById('checkBtn');

  // Platform badge
  const badge = document.getElementById('platformBadge');
  if (installer) {
    badge.textContent = `${installer.icon} ${installer.label}`;
  } else {
    badge.textContent = 'Platform not detected';
    return;
  }

  // Installer name + hint
  const titleEl = document.getElementById('installerTitle');
  const descEl = document.getElementById('installerDesc');
  if (titleEl) titleEl.textContent = `Download ${installer.name}`;
  if (descEl) descEl.textContent = installer.hint;

  // Download button — opens GitHub release page with the correct file
  const downloadBtn = document.getElementById('downloadBtn');
  downloadBtn.addEventListener('click', () => {
    // Try to download directly via chrome.downloads
    chrome.downloads.download({
      url: installer.url,
      filename: installer.name,
      saveAs: false,
    }).then(() => {
      statusMsg.textContent = `✓ Downloaded! Open your Downloads folder and run the installer.`;
      statusMsg.className = 'status-msg ok';
      checkBtn.style.display = 'inline-block';
    }).catch(() => {
      // Fallback: open the release page in a new tab
      chrome.tabs.create({ url: installer.url });
      statusMsg.textContent = `Opening download page... If nothing downloads, right-click and "Save As" the file.`;
      statusMsg.className = 'status-msg ok';
      checkBtn.style.display = 'inline-block';
    });
  });

  // Check Connection button
  checkBtn.addEventListener('click', async () => {
    checkBtn.disabled = true;
    checkBtn.textContent = 'Checking…';
    statusMsg.textContent = '';
    statusMsg.className = 'status-msg';

    try {
      const conn = await chrome.runtime.sendMessage({ type: 'native:connect' });
      if (conn && conn.ok) {
        statusMsg.textContent = '✓ Connected! Restart Chrome and try Virtual Cam again.';
        statusMsg.className = 'status-msg ok';
      } else {
        statusMsg.textContent = `✗ ${conn?.error || 'Not connected yet. Run the installer and restart Chrome.'}`;
        statusMsg.className = 'status-msg err';
      }
    } catch (err) {
      statusMsg.textContent = `✗ ${err.message}`;
      statusMsg.className = 'status-msg err';
    }

    checkBtn.disabled = false;
    checkBtn.textContent = 'Check Connection';
  });

  // Terminal fallback
  const cmdBlock = document.getElementById('cmdBlock');
  if (cmdBlock) {
    const cmd = `cd native-host && npm install && node install.js --id=${extId}`;
    cmdBlock.textContent = '';
    const textSpan = document.createElement('span');
    textSpan.textContent = cmd;
    cmdBlock.appendChild(textSpan);
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
      });
    });
  }

  // Extension ID note
  const noteEl = document.getElementById('noteText');
  if (noteEl) noteEl.innerHTML = `Extension ID: <code>${extId}</code>`;
});
