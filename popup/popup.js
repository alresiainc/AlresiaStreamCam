/**
 * Alresia StreamCam — Popup
 * The toolbar dropdown is Simple Mode's remote control: pick a source,
 * flip on virtual cam or streaming, jump to Advanced Mode. The actual
 * capture/recording/streaming runs in the Simple Mode tab (popups get
 * torn down the instant they lose focus — which happens immediately
 * when a screen/window/tab picker opens — so it can't hold a live
 * MediaStream itself). This popup just launches or focuses that tab
 * and mirrors its last known status.
 */

document.addEventListener('DOMContentLoaded', async () => {
  const selectSourceBtn = document.getElementById('selectSourceBtn');
  const selectSourceLabel = document.getElementById('selectSourceLabel');
  const sourcePicker = document.getElementById('sourcePicker');
  const vcamBtn = document.getElementById('vcamBtn');
  const streamBtn = document.getElementById('streamBtn');
  const advancedLink = document.getElementById('advancedLink');
  const settingsLink = document.getElementById('settingsLink');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');

  function openSimple(query = '') {
    chrome.runtime.sendMessage({ type: 'openPage', path: 'src/simple.html', query });
    window.close();
  }

  function openAdvanced(query = '') {
    chrome.runtime.sendMessage({ type: 'openPage', path: 'src/studio.html', query });
    window.close();
  }

  // ─── Select Source ─────────────────────────────────────────────
  // A source already active? Jump straight into Simple Mode instead of
  // showing the picker again — "Select Source" doubles as "Open".

  selectSourceBtn.addEventListener('click', () => {
    if (selectSourceBtn.dataset.hasSource === '1') {
      openSimple();
      return;
    }
    sourcePicker.classList.toggle('hidden');
  });

  sourcePicker.querySelectorAll('.source-pick-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      openSimple(`?autoSource=${btn.dataset.source}`);
    });
  });

  // ─── Virtual Cam / Stream ──────────────────────────────────────

  vcamBtn.addEventListener('click', () => openSimple('?autoVCam=1'));
  streamBtn.addEventListener('click', () => openSimple('?autoStream=1'));

  // ─── Advanced Mode / Settings ──────────────────────────────────

  advancedLink.addEventListener('click', () => openAdvanced());
  settingsLink.addEventListener('click', () => openAdvanced('?tab=settings'));

  // ─── Status (mirrors the last snapshot Simple Mode wrote) ───────

  try {
    const { simpleModeStatus } = await chrome.storage.local.get('simpleModeStatus');

    if (simpleModeStatus && simpleModeStatus.hasSource) {
      selectSourceBtn.dataset.hasSource = '1';
      selectSourceLabel.textContent = `Open (${simpleModeStatus.sourceName || simpleModeStatus.sourceType})`;

      if (simpleModeStatus.streaming) {
        statusDot.className = 'status-dot error'; // reuse red for "live"
        statusText.textContent = 'Live now';
      } else if (simpleModeStatus.recording) {
        statusDot.className = 'status-dot error';
        statusText.textContent = 'Recording';
      } else if (simpleModeStatus.vcamActive) {
        statusDot.className = 'status-dot active';
        statusText.textContent = 'Virtual camera live';
      } else {
        statusDot.className = 'status-dot active';
        statusText.textContent = `Ready — ${simpleModeStatus.sourceName || simpleModeStatus.sourceType}`;
      }
    } else {
      statusDot.className = 'status-dot idle';
      statusText.textContent = 'No source selected';
    }
  } catch {
    statusDot.className = 'status-dot idle';
    statusText.textContent = 'No source selected';
  }
});
