/**
 * StreamCam Setup — Download installer, run it, done.
 */

'use strict';

const extId = chrome.runtime.id;
const RELEASE_TAG = 'v1.0.0';
const REPO = 'alresiainc/AlresiaStreamCam';

function detectPlatform() {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('mac')) return 'macos';
  if (ua.includes('win')) return 'windows';
  if (ua.includes('linux')) return 'linux';
  return 'unknown';
}

function getInstaller(platform) {
  const base = `https://github.com/${REPO}/releases/download/${RELEASE_TAG}`;
  switch (platform) {
    case 'macos':
      return {
        file: 'StreamCam-Installer.command',
        url: `${base}/StreamCam-Installer.command`,
        icon: '🍎',
        name: 'macOS',
        instructions: [
          'After downloading, go to your Downloads folder',
          'Right-click the file → select "Open"',
          'Click "Open" in the security prompt',
          'Follow the terminal instructions',
        ],
      };
    case 'windows':
      return {
        file: 'StreamCam-Installer-Windows.zip',
        url: `${base}/StreamCam-Installer-Windows.zip`,
        icon: '🪟',
        name: 'Windows',
        instructions: [
          'Extract the ZIP file',
          'Double-click install.bat',
          'Follow the prompts',
        ],
      };
    case 'linux':
      return {
        file: 'streamcam_1.0.0_amd64.deb',
        url: `${base}/streamcam_1.0.0_amd64.deb`,
        icon: '🐧',
        name: 'Linux',
        instructions: [
          'Open a terminal',
          'Run: sudo dpkg -i streamcam_1.0.0_amd64.deb',
          'Or open the .deb file with Software Center',
        ],
      };
    default:
      return null;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const platform = detectPlatform();
  const installer = getInstaller(platform);
  const badge = document.getElementById('platformBadge');
  const downloadBtn = document.getElementById('downloadBtn');
  const downloadLabel = document.getElementById('downloadLabel');
  const checkBtn = document.getElementById('checkBtn');
  const statusMsg = document.getElementById('statusMsg');
  const stepsList = document.getElementById('stepsList');

  if (!installer) {
    badge.textContent = 'Unknown platform';
    downloadBtn.disabled = true;
    return;
  }

  badge.textContent = `${installer.icon} ${installer.name}`;
  downloadLabel.textContent = `Download for ${installer.name}`;

  // Show steps
  installer.instructions.forEach((step, i) => {
    const li = document.createElement('li');
    li.textContent = step;
    stepsList.appendChild(li);
  });

  // Download handler
  downloadBtn.addEventListener('click', () => {
    downloadBtn.disabled = true;
    downloadLabel.textContent = 'Downloading…';

    chrome.downloads.download({
      url: installer.url,
      filename: installer.file,
      saveAs: false,
    }).then(() => {
      statusMsg.textContent = '✓ Downloaded! Follow the steps below.';
      statusMsg.className = 'status ok';
      checkBtn.style.display = 'block';
      downloadLabel.textContent = 'Downloaded ✓';
    }).catch(() => {
      // Fallback: open in new tab
      chrome.tabs.create({ url: installer.url });
      statusMsg.textContent = 'Opening download page…';
      statusMsg.className = 'status ok';
      checkBtn.style.display = 'block';
      downloadLabel.textContent = 'Download';
      downloadBtn.disabled = false;
    });
  });

  // Check connection
  checkBtn.addEventListener('click', async () => {
    checkBtn.disabled = true;
    checkBtn.textContent = 'Checking…';
    statusMsg.textContent = '';
    statusMsg.className = 'status';

    try {
      const conn = await chrome.runtime.sendMessage({ type: 'native:connect' });
      if (conn && conn.ok) {
        statusMsg.textContent = '✓ Connected! Restart Chrome and try again.';
        statusMsg.className = 'status ok';
      } else {
        statusMsg.textContent = 'Not connected yet. Make sure you ran the installer and restarted Chrome.';
        statusMsg.className = 'status err';
      }
    } catch (err) {
      statusMsg.textContent = err.message;
      statusMsg.className = 'status err';
    }

    checkBtn.disabled = false;
    checkBtn.textContent = 'I installed it — check connection';
  });
});
