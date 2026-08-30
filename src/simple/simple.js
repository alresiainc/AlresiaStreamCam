/**
 * Alresia StreamCam — Simple Mode Controller
 * One source at a time, no scenes, no compositor. The chosen source's
 * raw MediaStream is played straight into a <video> element and fed
 * directly to the recorder and stream manager — there's nothing to
 * composite, so there's nothing extra to configure.
 */

(() => {
  'use strict';

  const log = new Logger('Simple', LogLevel.INFO);

  // ─── Core Modules ────────────────────────────────────────────────

  const sourceManager = new SourceManager();
  const streamManager = new StreamManager();
  const vcamManager = new VirtualCamManager();
  let recorder = null;
  let recordingTimer = null;
  let currentSource = null;
  let singleDestinationId = null;

  // ─── DOM Elements ────────────────────────────────────────────────

  const els = {
    tallyRail: document.getElementById('tallyRail'),
    tbRecBadge: document.getElementById('tbRecBadge'),
    tbLiveBadge: document.getElementById('tbLiveBadge'),
    advancedLink: document.getElementById('advancedLink'),

    pickerScreen: document.getElementById('pickerScreen'),
    pickCamera: document.getElementById('pickCamera'),
    pickScreen: document.getElementById('pickScreen'),
    pickWindow: document.getElementById('pickWindow'),
    pickTab: document.getElementById('pickTab'),

    liveScreen: document.getElementById('liveScreen'),
    video: document.getElementById('simpleVideo'),
    sourceBadge: document.getElementById('sourceBadge'),
    changeSourceBtn: document.getElementById('changeSourceBtn'),

    recordBtn: document.getElementById('recordBtn'),
    vcamBtn: document.getElementById('vcamBtn'),
    streamToggleBtn: document.getElementById('streamToggleBtn'),
    recordTimer: document.getElementById('recordTimer'),
    recordTime: document.getElementById('recordTime'),

    streamPanel: document.getElementById('streamPanel'),
    streamPanelClose: document.getElementById('streamPanelClose'),
    streamProvider: document.getElementById('streamProvider'),
    streamUrl: document.getElementById('streamUrl'),
    streamKey: document.getElementById('streamKey'),
    goLiveBtn: document.getElementById('goLiveBtn'),
    streamStatusText: document.getElementById('streamStatusText'),

    toast: document.getElementById('toast'),
  };

  // ─── Small helpers ───────────────────────────────────────────────

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
  }

  function showToast(message, type = 'info') {
    els.toast.textContent = message;
    els.toast.style.borderColor = type === 'error' ? 'var(--signal)' : type === 'success' ? 'var(--live)' : 'var(--line)';
    els.toast.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => els.toast.classList.remove('show'), 3200);
  }

  function updateTally() {
    const isRecording = !!(recorder && recorder.state === RecordingState.RECORDING);
    const isLive = streamManager.getAll().some((d) => d.state === StreamState.STREAMING);

    els.tbRecBadge.classList.toggle('show', isRecording);
    els.tbLiveBadge.classList.toggle('show', isLive);

    if (isRecording && isLive) els.tallyRail.dataset.state = 'both';
    else if (isRecording) els.tallyRail.dataset.state = 'recording';
    else if (isLive) els.tallyRail.dataset.state = 'live';
    else els.tallyRail.dataset.state = 'idle';

    persistStatus();
  }

  /** Snapshot the current state to storage so the popup can show it live. */
  async function persistStatus() {
    try {
      await chrome.storage.local.set({
        simpleModeStatus: {
          hasSource: !!currentSource,
          sourceType: currentSource ? currentSource.type : null,
          sourceName: currentSource ? currentSource.name : null,
          recording: !!(recorder && recorder.state === RecordingState.RECORDING),
          streaming: streamManager.getAll().some((d) => d.state === StreamState.STREAMING),
          vcamActive: vcamManager.state === VcamState.ACTIVE,
          updatedAt: Date.now(),
        },
      });
    } catch { /* best-effort */ }
  }

  // ─── Source selection ────────────────────────────────────────────

  async function selectCamera() {
    try {
      const source = await sourceManager.addCamera();
      useSource(source);
    } catch (err) {
      showToast(`Camera access failed: ${err.message}`, 'error');
    }
  }

  function selectScreen() {
    chrome.desktopCapture.chooseDesktopMedia(
      ['screen', 'window', 'audio'],
      (streamId, options) => {
        if (!streamId) return;
        sourceManager
          .addFromDesktopCapture(streamId, {
            type: VideoSourceType.SCREEN,
            name: 'Screen',
            audio: !!(options && options.canRequestAudioTrack),
          })
          .then(useSource)
          .catch((err) => showToast(`Screen capture failed: ${err.message}`, 'error'));
      }
    );
  }

  function selectWindow() {
    chrome.desktopCapture.chooseDesktopMedia(
      ['window', 'audio'],
      (streamId, options) => {
        if (!streamId) return;
        sourceManager
          .addFromDesktopCapture(streamId, {
            type: VideoSourceType.WINDOW,
            name: 'Window',
            audio: !!(options && options.canRequestAudioTrack),
          })
          .then(useSource)
          .catch((err) => showToast(`Window capture failed: ${err.message}`, 'error'));
      }
    );
  }

  function selectTab() {
    chrome.desktopCapture.chooseDesktopMedia(
      ['tab'],
      (streamId, options) => {
        if (!streamId) return;
        sourceManager
          .addFromDesktopCapture(streamId, {
            type: VideoSourceType.TAB,
            name: 'Browser Tab',
            audio: !!(options && options.canRequestAudioTrack),
          })
          .then(useSource)
          .catch((err) => showToast(`Tab capture failed: ${err.message}`, 'error'));
      }
    );
  }

  function useSource(source) {
    currentSource = source;
    els.video.srcObject = source.stream;
    els.sourceBadge.textContent = escapeHtml(source.name);

    els.pickerScreen.classList.add('hidden');
    els.liveScreen.classList.remove('hidden');

    // Point the stream manager's frame pump straight at the preview video —
    // drawImage() accepts a <video> element just as well as a <canvas>.
    streamManager.setFrameSource(els.video, { width: 480, height: 270, fps: 6 });
    vcamManager.setFrameSource(els.video, { width: 960, height: 540, fps: 15 });

    source.stream.getTracks().forEach((track) => {
      track.addEventListener('ended', () => {
        showToast(`${source.name} disconnected`, 'error');
        changeSource();
      });
    });

    persistStatus();
    showToast(`Using: ${source.name}`, 'success');
  }

  async function changeSource() {
    if (recorder) stopRecording();
    await streamManager.stopAll();
    if (vcamManager.state === VcamState.ACTIVE) await vcamManager.stop();

    if (currentSource) {
      sourceManager.remove(currentSource.id);
      currentSource = null;
    }

    els.video.srcObject = null;
    els.liveScreen.classList.add('hidden');
    els.pickerScreen.classList.remove('hidden');
    els.streamPanel.classList.add('hidden');
    els.vcamBtn.classList.remove('active');
    els.vcamBtn.querySelector('span').textContent = 'Virtual Cam';
    updateTally();
  }

  // ─── Recording ───────────────────────────────────────────────────

  function startRecording() {
    if (!currentSource || !currentSource.stream) {
      showToast('Pick a source first', 'error');
      return;
    }

    recorder = new Recorder(currentSource.stream, {
      mimeType: Recorder.bestMimeType(),
      videoBitsPerSecond: 5_000_000,
    });
    recorder.start(1000);

    els.recordBtn.classList.add('active');
    els.recordBtn.querySelector('span').textContent = 'Stop';
    els.recordTimer.classList.remove('hidden');

    startRecordTimer();
    updateTally();
    showToast('Recording started');
  }

  function stopRecording() {
    if (!recorder) return;

    // Capture the instance before nulling the outer reference — the
    // .then() below fires asynchronously, after that assignment.
    const activeRecorder = recorder;
    const mimeType = recorder.mimeType;
    const name = `Recording ${new Date().toLocaleTimeString()}`;

    activeRecorder.stop().then(async (chunks) => {
      if (chunks.length === 0) {
        showToast('Recording was empty', 'error');
        return;
      }
      const blob = new Blob(chunks, { type: mimeType });
      try {
        await RecordingsDB.save(blob, name);
        showToast('Recording saved — open Advanced Mode to find it');
      } catch (err) {
        activeRecorder.download(`${name}.webm`);
        showToast('Recording downloaded (storage failed)');
      }
    }).catch((err) => {
      showToast(`Recording failed to save: ${err.message}`, 'error');
    });

    els.recordBtn.classList.remove('active');
    els.recordBtn.querySelector('span').textContent = 'Record';
    els.recordTimer.classList.add('hidden');

    stopRecordTimer();
    recorder = null;
    updateTally();
  }

  function startRecordTimer() {
    const start = Date.now();
    recordingTimer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - start) / 1000);
      const h = String(Math.floor(elapsed / 3600)).padStart(2, '0');
      const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
      const s = String(elapsed % 60).padStart(2, '0');
      els.recordTime.textContent = `${h}:${m}:${s}`;
    }, 1000);
  }

  function stopRecordTimer() {
    clearInterval(recordingTimer);
    recordingTimer = null;
    els.recordTime.textContent = '00:00:00';
  }

  // ─── Virtual Camera ──────────────────────────────────────────────
  // Cross-platform virtual camera support:
  //   Linux:   v4l2loopback (auto-installed by native host on first use)
  //   macOS:   CoreMediaIO plugin (compiled from source)
  //   Windows: DirectShow filter (compiled from source)

  async function toggleVirtualCam() {
    if (vcamManager.state === VcamState.ACTIVE) {
      await vcamManager.stop();
      els.vcamBtn.classList.remove('active');
      els.vcamBtn.querySelector('span').textContent = 'Virtual Cam';
      updateTally();
      return;
    }

    if (!currentSource) {
      showToast('Pick a source first', 'error');
      return;
    }

    if (vcamManager.state === VcamState.UNSUPPORTED) {
      showToast(vcamManager.error || 'Virtual camera is not available on this machine', 'error');
      return;
    }

    if (vcamManager.state === VcamState.NEEDS_BUILD) {
      showToast(vcamManager.error || 'Virtual camera needs to be compiled from source. Run the installer first.', 'error');
      return;
    }

    els.vcamBtn.disabled = true;
    els.vcamBtn.querySelector('span').textContent = 'Checking…';
    const result = await vcamManager.check();
    if (!result.ok) {
      els.vcamBtn.disabled = false;
      els.vcamBtn.querySelector('span').textContent = 'Virtual Cam';
      showToast(`Virtual camera check failed: ${result.error}`, 'error');
    }
    // The real verdict arrives async via Events.VCAM_CHECKED
  }

  // ─── Streaming (single destination) ─────────────────────────────

  function ensureDestination() {
    if (singleDestinationId && streamManager.destinations.has(singleDestinationId)) {
      return streamManager.destinations.get(singleDestinationId);
    }
    const dest = streamManager.addDestination({ provider: 'youtube' });
    singleDestinationId = dest.id;
    return dest;
  }

  function populateProviders() {
    els.streamProvider.innerHTML = STREAM_PROVIDERS
      .map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`)
      .join('');
  }

  function toggleStreamPanel() {
    const dest = ensureDestination();
    if (dest.state === StreamState.STREAMING) {
      stopLive();
      return;
    }
    els.streamPanel.classList.toggle('hidden');
    if (!els.streamPanel.classList.contains('hidden')) {
      els.streamProvider.value = dest.provider;
      els.streamUrl.value = dest.url || '';
      els.streamKey.value = dest.streamKey || '';
    }
  }

  async function goLive() {
    const dest = ensureDestination();
    dest.provider = els.streamProvider.value;
    dest.url = els.streamUrl.value.trim();
    dest.streamKey = els.streamKey.value.trim();

    if (!dest.url || !dest.streamKey) {
      showToast('Enter a server URL and stream key first', 'error');
      return;
    }
    if (!currentSource) {
      showToast('Pick a source first', 'error');
      return;
    }

    els.goLiveBtn.disabled = true;
    els.goLiveBtn.querySelector('span').textContent = 'Connecting…';

    const result = await streamManager.start(dest.id, { codec: 'vp8', videoBitrate: 2_000_000 });

    els.goLiveBtn.disabled = false;

    if (result.ok) {
      els.streamToggleBtn.classList.add('streaming');
      els.goLiveBtn.querySelector('span').textContent = 'Stop Streaming';
      els.streamStatusText.textContent = `Live on ${dest.name || dest.provider}`;
      els.streamStatusText.style.color = 'var(--live)';
      showToast('You are live');
    } else {
      els.goLiveBtn.querySelector('span').textContent = 'Go Live';
      els.streamStatusText.textContent = result.error;
      els.streamStatusText.style.color = 'var(--signal)';
      showToast(`Stream error: ${result.error}`, 'error');
    }
    updateTally();
  }

  async function stopLive() {
    if (!singleDestinationId) return;
    await streamManager.stop(singleDestinationId);
    els.streamToggleBtn.classList.remove('streaming');
    els.goLiveBtn.querySelector('span').textContent = 'Go Live';
    els.streamStatusText.textContent = '';
    els.streamPanel.classList.add('hidden');
    showToast('Stopped streaming');
    updateTally();
  }

  // ─── Deep links from the popup ───────────────────────────────────

  function handleUrlParams() {
    const params = new URLSearchParams(window.location.search);
    const autoSource = params.get('autoSource');

    if (autoSource === 'camera') selectCamera();
    else if (autoSource === 'screen') selectScreen();
    else if (autoSource === 'window') selectWindow();
    else if (autoSource === 'tab') selectTab();

    if (params.get('autoVCam') === '1') {
      toggleVirtualCam();
    }
    if (params.get('autoStream') === '1') {
      // Give the source picker/useSource() a beat if a source is also auto-selecting
      setTimeout(() => {
        if (els.streamPanel.classList.contains('hidden')) toggleStreamPanel();
      }, 300);
    }
  }

  // ─── Event Binding ───────────────────────────────────────────────

  function bindEvents() {
    els.pickCamera.addEventListener('click', selectCamera);
    els.pickScreen.addEventListener('click', selectScreen);
    els.pickWindow.addEventListener('click', selectWindow);
    els.pickTab.addEventListener('click', selectTab);

    els.changeSourceBtn.addEventListener('click', changeSource);

    els.recordBtn.addEventListener('click', () => {
      if (recorder) stopRecording();
      else startRecording();
    });

    els.vcamBtn.addEventListener('click', toggleVirtualCam);

    els.streamToggleBtn.addEventListener('click', toggleStreamPanel);
    els.streamPanelClose.addEventListener('click', () => els.streamPanel.classList.add('hidden'));
    els.goLiveBtn.addEventListener('click', () => {
      const dest = singleDestinationId && streamManager.destinations.get(singleDestinationId);
      if (dest && dest.state === StreamState.STREAMING) stopLive();
      else goLive();
    });

    els.advancedLink.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.runtime.sendMessage({ type: 'openPage', path: 'src/studio.html' });
    });

    bus.on(Events.STREAM_ERROR, (payload) => {
      const message = (payload && payload.error) || payload || 'Unknown error';
      showToast(`Stream error: ${message}`, 'error');
      updateTally();
    });

    bus.on(Events.VCAM_CHECKED, async ({ supported, reason }) => {
      els.vcamBtn.disabled = false;
      if (supported) {
        els.vcamBtn.querySelector('span').textContent = 'Starting…';
        const result = await vcamManager.start();
        els.vcamBtn.disabled = false;
        if (!result.ok) {
          els.vcamBtn.querySelector('span').textContent = 'Virtual Cam';
          showToast(`Virtual camera error: ${result.error}`, 'error');
        }
      } else {
        els.vcamBtn.querySelector('span').textContent = 'Virtual Cam';
        showToast(reason || 'Virtual camera is not available on this machine', 'error');
      }
    });

    bus.on(Events.VCAM_STARTED, () => {
      els.vcamBtn.classList.add('active');
      els.vcamBtn.disabled = false;
      els.vcamBtn.querySelector('span').textContent = 'Stop VCam';
      showToast('Virtual camera is live');
      updateTally();
    });

    bus.on(Events.VCAM_STOPPED, () => {
      els.vcamBtn.classList.remove('active');
      els.vcamBtn.querySelector('span').textContent = 'Virtual Cam';
      updateTally();
    });

    bus.on(Events.VCAM_ERROR, (error) => {
      showToast(`Virtual camera error: ${error}`, 'error');
      els.vcamBtn.classList.remove('active');
      els.vcamBtn.disabled = false;
      els.vcamBtn.querySelector('span').textContent = 'Virtual Cam';
      updateTally();
    });

    window.addEventListener('beforeunload', () => {
      streamManager.stopAll();
      if (vcamManager.state === VcamState.ACTIVE) vcamManager.stop();
    });
  }

  // ─── Init ────────────────────────────────────────────────────────

  function init() {
    populateProviders();
    bindEvents();
    handleUrlParams();
    persistStatus();
    log.info('Simple Mode initialized');
  }

  init();
})();
