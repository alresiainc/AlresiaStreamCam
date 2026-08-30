/**
 * StreamCam Installer — Renderer Process
 *
 * Drives the step-by-step installation wizard.
 */

'use strict';

const { ipcRenderer } = require('electron');

// ─── State ────────────────────────────────────────────────────────

let currentStep = 0;
let extId = null;

// ─── UI Helpers ───────────────────────────────────────────────────

function setStepState(num, state, statusText) {
  const step = document.getElementById(`step${num}`);
  step.className = `step ${state}`;
  if (statusText) {
    document.getElementById(`step${num}Status`).textContent = statusText;
  }
}

function setProgress(pct) {
  document.getElementById('progressFill').style.width = `${pct}%`;
}

function showToast(msg, duration = 3000) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), duration);
}

function setStep3Desc(text) {
  document.getElementById('step3Desc').textContent = text;
}

// ─── Listen for Progress Updates ──────────────────────────────────

ipcRenderer.on('install:progress', (event, msg) => {
  if (msg.type === 'status') {
    setStepState(currentStep, 'active', msg.message);
  } else if (msg.type === 'warning') {
    showToast(msg.message, 5000);
  } else if (msg.type === 'error') {
    setStepState(currentStep, 'error', msg.message);
  }
});

// ─── Installation Flow ────────────────────────────────────────────

async function startInstall() {
  const startBtn = document.getElementById('startBtn');
  startBtn.disabled = true;
  startBtn.textContent = 'Installing…';

  // Get system info
  const info = await ipcRenderer.invoke('install:get-info');
  console.log('System info:', info);

  // Update step 3 description based on platform
  if (info.platform === 'linux') {
    setStep3Desc('v4l2loopback kernel module (auto-installed)');
  } else if (info.platform === 'macos') {
    setStep3Desc('CoreMediaIO plugin (compiled from source)');
  } else if (info.platform === 'windows') {
    setStep3Desc('DirectShow filter (compiled from source)');
  }

  // ── Step 1: Install Dependencies ────────────────────────────
  currentStep = 1;
  setStepState(1, 'active', 'Starting...');
  setProgress(10);

  const depsResult = await ipcRenderer.invoke('install:run', 'deps');
  if (!depsResult.ok) {
    setStepState(1, 'error', depsResult.error);
    startBtn.disabled = false;
    startBtn.textContent = 'Retry Installation';
    return;
  }

  if (depsResult.needsContinue) {
    // macOS Xcode CLT — user needs to approve
    showToast('Please approve the Xcode CLT installer, then click Continue', 8000);
    startBtn.disabled = false;
    startBtn.textContent = 'Continue Installation';
    startBtn.onclick = () => {
      startBtn.onclick = startInstall;
      startInstall();
    };
    return;
  }

  setStepState(1, 'done', 'Complete');
  setProgress(33);

  // ── Step 2: Register Host ───────────────────────────────────
  currentStep = 2;
  setStepState(2, 'active', 'Checking for extension ID...');

  // Try to detect extension ID
  extId = await ipcRenderer.invoke('install:get-extension-id');

  if (!extId) {
    // Show input for extension ID
    const input = document.getElementById('extIdInput');
    input.style.display = 'block';
    input.focus();
    setStepState(2, 'active', 'Enter your extension ID from chrome://extensions');

    document.getElementById('startBtn').style.display = 'none';
    document.getElementById('doneBtn').style.display = 'inline-block';
    document.getElementById('doneBtn').textContent = 'Register Host';
    document.getElementById('doneBtn').onclick = registerWithExtId;
    return;
  }

  setStepState(2, 'active', `Found extension ID: ${extId}`);

  const hostResult = await ipcRenderer.invoke('install:run', 'host');
  if (!hostResult.ok) {
    if (hostResult.needsExtId) {
      const input = document.getElementById('extIdInput');
      input.style.display = 'block';
      input.focus();
      setStepState(2, 'active', 'Enter your extension ID from chrome://extensions');
      document.getElementById('startBtn').style.display = 'none';
      document.getElementById('doneBtn').style.display = 'inline-block';
      document.getElementById('doneBtn').textContent = 'Register Host';
      document.getElementById('doneBtn').onclick = registerWithExtId;
      return;
    }
    setStepState(2, 'error', hostResult.error);
    return;
  }

  setStepState(2, 'done', 'Host registered with Chrome');
  setProgress(66);

  // ── Step 3: Virtual Camera ──────────────────────────────────
  currentStep = 3;
  setStepState(3, 'active', 'Setting up...');

  const vcamResult = await ipcRenderer.invoke('install:run', 'vcam');
  if (!vcamResult.ok) {
    setStepState(3, 'error', vcamResult.error);
  } else {
    setStepState(3, 'done', 'Virtual camera ready');
  }

  setProgress(100);

  // ── Done ────────────────────────────────────────────────────
  document.getElementById('startBtn').style.display = 'none';
  document.getElementById('doneBtn').style.display = 'inline-block';
  document.getElementById('doneBtn').textContent = 'Done — Restart Chrome';
  document.getElementById('doneBtn').onclick = finishInstall;
  document.getElementById('openExtBtn').style.display = 'inline-block';
}

async function registerWithExtId() {
  const input = document.getElementById('extIdInput');
  extId = input.value.trim();

  if (!extId || !/^[a-p]{32}$/.test(extId)) {
    showToast('Please enter a valid 32-character extension ID');
    return;
  }

  input.disabled = true;
  setStepState(2, 'active', `Registering with ID: ${extId}...`);

  // Write the ID and run the installer
  const result = await ipcRenderer.invoke('install:run', 'host');
  if (!result.ok) {
    setStepState(2, 'error', result.error);
    return;
  }

  setStepState(2, 'done', 'Host registered');
  setProgress(66);

  // Continue to step 3
  currentStep = 3;
  setStepState(3, 'active', 'Setting up...');
  const vcamResult = await ipcRenderer.invoke('install:run', 'vcam');
  if (vcamResult.ok) {
    setStepState(3, 'done', 'Virtual camera ready');
  }
  setProgress(100);

  document.getElementById('startBtn').style.display = 'none';
  document.getElementById('doneBtn').style.display = 'inline-block';
  document.getElementById('doneBtn').textContent = 'Done — Restart Chrome';
  document.getElementById('doneBtn').onclick = finishInstall;
  document.getElementById('openExtBtn').style.display = 'inline-block';
}

function finishInstall() {
  document.getElementById('mainContent').style.display = 'none';
  document.getElementById('doneScreen').classList.add('visible');
}

function openExtensions() {
  ipcRenderer.invoke('install:open-extensions');
}
