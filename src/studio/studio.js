/**
 * Alresia StreamCam — Studio Controller
 * Main entry point for the studio page.
 * Wires together source management, compositor, scenes, recording, and streaming.
 */

(() => {
  'use strict';

  const log = new Logger('Studio', LogLevel.INFO);

  // ─── Core Modules ──────────────────────────────────────────────

  const previewCanvas = document.getElementById('previewCanvas');
  const sourceManager = new SourceManager();
  const compositor = new Compositor(previewCanvas, {
    width: 1920,
    height: 1080,
    framerate: 30,
  });
  const audioMixer = new AudioMixer();
  const sceneManager = new SceneManager(sourceManager, compositor, audioMixer);
  const streamManager = new StreamManager();
  const vcamManager = new VirtualCamManager();
  let recorder = null;
  let recordingTimer = null;

  // ─── DOM Elements ──────────────────────────────────────────────

  const els = {
    sourceList: document.getElementById('sourceList'),
    sourceEmpty: document.getElementById('sourceEmpty'),
    previewEmpty: document.getElementById('previewEmpty'),
    fpsDisplay: document.getElementById('fpsDisplay'),
    resolutionSelect: document.getElementById('resolutionSelect'),

    // Source buttons
    addCameraBtn: document.getElementById('addCameraBtn'),
    addTabBtn: document.getElementById('addTabBtn'),
    addScreenBtn: document.getElementById('addScreenBtn'),
    addWindowBtn: document.getElementById('addWindowBtn'),
    addMicrophoneBtn: document.getElementById('addMicrophoneBtn'),
    removeAllBtn: document.getElementById('removeAllBtn'),

    // Record
    recordBtn: document.getElementById('recordBtn'),
    recordStatus: document.getElementById('recordStatus'),
    recordTimer: document.getElementById('recordTimer'),
    recordTime: document.getElementById('recordTime'),

    // Stream destinations
    destinationsList: document.getElementById('destinationsList'),
    addDestinationBtn: document.getElementById('addDestinationBtn'),

    // Virtual Camera
    vcamBtn: document.getElementById('vcamBtn'),
    vcamNote: document.getElementById('vcamNote'),

    // Scenes
    sceneList: document.getElementById('sceneList'),
    addSceneBtn: document.getElementById('addSceneBtn'),

    // Recordings
    recordingsList: document.getElementById('recordingsList'),

    // Settings
    settingsBtn: document.getElementById('settingsBtn'),
    simpleLink: document.getElementById('simpleLink'),
    settingsOverlay: document.getElementById('settingsOverlay'),
    settingsClose: document.getElementById('settingsClose'),
    settingsCancel: document.getElementById('settingsCancel'),
    settingsSave: document.getElementById('settingsSave'),
    setRecordBitrate: document.getElementById('setRecordBitrate'),
    setStreamCodec: document.getElementById('setStreamCodec'),
    setStreamBitrate: document.getElementById('setStreamBitrate'),

    // Status signals
    tallyRail: document.getElementById('tallyRail'),
    tbRecBadge: document.getElementById('tbRecBadge'),
    tbLiveBadge: document.getElementById('tbLiveBadge'),

    toast: document.getElementById('toast'),
  };

  let currentSettings = null;

  // ─── Tally / status signal ─────────────────────────────────────

  function updateTally() {
    const isRecording = !!(recorder && recorder.state === RecordingState.RECORDING);
    const isLive = streamManager.getAll().some((d) => d.state === StreamState.STREAMING);

    els.tbRecBadge.classList.toggle('show', isRecording);
    els.tbLiveBadge.classList.toggle('show', isLive);

    if (isRecording && isLive) {
      els.tallyRail.dataset.state = 'both';
    } else if (isRecording) {
      els.tallyRail.dataset.state = 'recording';
    } else if (isLive) {
      els.tallyRail.dataset.state = 'live';
    } else {
      els.tallyRail.dataset.state = 'idle';
    }
  }

  // Recordings persist to shared IndexedDB storage — see RecordingsDB
  // (src/storage/recordings-db.js), loaded before this script.

  // ─── Initialize ────────────────────────────────────────────────

  async function init() {
    log.info('Initializing studio...');

    // Load scenes from storage
    const { scenes, activeId } = await chrome.runtime.sendMessage({ type: 'scenes:getAll' });
    sceneManager.init(scenes, activeId);

    // Load settings
    const { settings } = await chrome.runtime.sendMessage({ type: 'settings:get' });
    currentSettings = settings;
    loadSettings(settings);

    // Connect to service worker
    connectServiceWorker();

    // Start compositor rendering
    compositor.start();

    // Load saved stream destinations (or seed one default)
    const savedDestinations = currentSettings.destinations || [];
    if (savedDestinations.length > 0) {
      for (const d of savedDestinations) {
        streamManager.addDestination(d);
      }
    } else {
      streamManager.addDestination({ provider: 'youtube' });
    }
    streamManager.setFrameSource(previewCanvas, { width: 480, height: 270, fps: 6 });
    vcamManager.setFrameSource(previewCanvas, { width: 960, height: 540, fps: 15 });
    renderDestinations();

    // Bind UI events
    bindEvents();

    // Start FPS counter
    startFpsCounter();

    // Render scenes list
    renderSceneList();

    // Load recordings list
    renderRecordingsList();

    // Set initial tally state
    updateTally();

    // Handle quick-action deep links from the popup
    handleUrlParams();

    log.info('Studio initialized');
  }

  // ─── Deep links from the popup (Quick Record / Quick Stream / Settings) ──

  function handleUrlParams() {
    const params = new URLSearchParams(window.location.search);

    if (params.get('tab') === 'settings') {
      openSettingsModal();
    }

    if (params.get('autoRecord') === '1') {
      if (compositor.layers.some((l) => l.visible)) {
        startRecording();
      } else {
        showToast('Add a source first, then hit Record', 'error');
      }
    }

    if (params.get('autoStream') === '1') {
      const first = streamManager.getAll()[0];
      if (first && first.url && first.streamKey) {
        startDestination(first.id);
      } else {
        showToast('Add your RTMP URL and stream key, then hit Go Live', 'error');
      }
    }
  }

  // ─── Settings ──────────────────────────────────────────────────

  function loadSettings(settings) {
    if (settings.recording?.mimeType) {
      // Verify MIME type support
      if (!Recorder.isSupported(settings.recording.mimeType)) {
        settings.recording.mimeType = Recorder.bestMimeType();
      }
    }

    // Set resolution selector
    const res = `${compositor.width}x${compositor.height}`;
    els.resolutionSelect.value = res;

    // Reflect into the settings modal fields
    if (settings.recording?.videoBitsPerSecond) {
      els.setRecordBitrate.value = String(settings.recording.videoBitsPerSecond);
    }
    if (settings.streaming?.codec) {
      els.setStreamCodec.value = settings.streaming.codec;
    }
    if (settings.streaming?.videoBitrate) {
      els.setStreamBitrate.value = String(settings.streaming.videoBitrate);
    }
  }

  // ─── Settings Modal ────────────────────────────────────────────

  function openSettingsModal() {
    els.settingsOverlay.classList.remove('hidden');
  }

  function closeSettingsModal() {
    els.settingsOverlay.classList.add('hidden');
  }

  async function saveSettingsModal() {
    try {
      let res = await chrome.runtime.sendMessage({
        type: 'settings:set',
        key: 'recording',
        value: { videoBitsPerSecond: Number(els.setRecordBitrate.value) },
      });
      res = await chrome.runtime.sendMessage({
        type: 'settings:set',
        key: 'streaming',
        value: {
          codec: els.setStreamCodec.value,
          videoBitrate: Number(els.setStreamBitrate.value),
        },
      });
      currentSettings = res?.settings || currentSettings;
      showToast('Settings saved');
    } catch (err) {
      showToast(`Could not save settings: ${err.message}`, 'error');
    } finally {
      closeSettingsModal();
    }
  }

  // ─── Service Worker Connection ─────────────────────────────────

  function connectServiceWorker() {
    const port = chrome.runtime.connect({ name: 'studio' });

    port.onMessage.addListener((msg) => {
      handleServiceWorkerMessage(msg);
    });

    port.onDisconnect.addListener(() => {
      log.warn('Service worker disconnected');
    });
  }

  function handleServiceWorkerMessage(msg) {
    switch (msg.type) {
      case 'capture:desktop:request':
        // Desktop capture picker requested — invoke from this page context
        chrome.desktopCapture.chooseDesktopMedia(
          msg.sources || ['screen', 'window'],
          (streamId) => {
            if (streamId) {
              sourceManager.addFromDesktopCapture(streamId, { type: VideoSourceType.SCREEN, name: 'Screen' })
                .then((source) => {
                  addSourceToScene(source);
                })
                .catch((err) => {
                  showToast(`Screen capture failed: ${err.message}`, 'error');
                });
            }
          }
        );
        break;

      case 'native:hostMessage':
        streamManager.handleHostMessage(msg.data);
        vcamManager.handleHostMessage(msg.data);
        break;

      case 'native:hostDisconnected':
        if (msg.error && /not found|not installed/i.test(msg.error)) {
          showToast('Native host not installed — setup page opened', 'error');
        } else {
          showToast('Native host disconnected', 'error');
        }
        break;
    }
  }

  // ─── Source Management ─────────────────────────────────────────

  async function addCamera() {
    try {
      const source = await sourceManager.addCamera();
      addSourceToScene(source);
      showToast(`Added camera: ${source.name}`);
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        showToast('Camera permission denied', 'error');
      } else {
        showToast(`Camera error: ${err.message}`, 'error');
      }
    }
  }

  /**
   * Add a browser tab as a source.
   *
   * IMPORTANT: chrome.tabCapture (capture() or getMediaStreamId) can only
   * ever target the tab that is currently active AND that the extension
   * was just "invoked" on (via activeTab / a click on the toolbar icon
   * for that exact tab). There is no supported way for an extension page
   * to list and capture an arbitrary background tab through tabCapture —
   * that's a deliberate Chrome privacy restriction, not a bug on our end.
   *
   * chrome.desktopCapture doesn't have that restriction: passing 'tab' as
   * a source shows Chrome's own native picker with a "Chrome Tab" list of
   * every open tab, and the person picks one directly — no custom list,
   * no activeTab gymnastics, and it works regardless of which tab is
   * currently focused.
   */
  function addTab() {
    chrome.desktopCapture.chooseDesktopMedia(
      ['tab'],
      (streamId, options) => {
        if (!streamId) return; // user cancelled the picker

        sourceManager
          .addFromDesktopCapture(streamId, {
            type: VideoSourceType.TAB,
            name: 'Browser Tab',
            audio: !!(options && options.canRequestAudioTrack),
          })
          .then((source) => {
            addSourceToScene(source);
            showToast(`Capturing: ${source.name}`);
          })
          .catch((err) => {
            showToast(`Tab capture failed: ${err.message}`, 'error');
          });
      }
    );
  }

  /**
   * Direct screen/window capture — calls chrome.desktopCapture from this page.
   * Must be triggered by a user gesture (button click).
   */
  function requestScreenCapture() {
    chrome.desktopCapture.chooseDesktopMedia(
      ['screen', 'window', 'audio'],
      (streamId, options) => {
        if (!streamId) return; // user cancelled
        sourceManager
          .addFromDesktopCapture(streamId, {
            type: VideoSourceType.SCREEN,
            name: 'Screen / Window',
            audio: !!(options && options.canRequestAudioTrack),
          })
          .then((source) => {
            addSourceToScene(source);
            showToast(`Added: ${source.name}`);
          })
          .catch((err) => {
            showToast(`Screen capture failed: ${err.message}`, 'error');
          });
      }
    );
  }

  /**
   * Capture a specific application window only.
   */
  function requestWindowCapture() {
    chrome.desktopCapture.chooseDesktopMedia(
      ['window', 'audio'],
      (streamId, options) => {
        if (!streamId) return;
        sourceManager
          .addFromDesktopCapture(streamId, {
            type: VideoSourceType.WINDOW,
            name: 'Application Window',
            audio: !!(options && options.canRequestAudioTrack),
          })
          .then((source) => {
            addSourceToScene(source);
            showToast(`Added: ${source.name}`);
          })
          .catch((err) => {
            showToast(`Window capture failed: ${err.message}`, 'error');
          });
      }
    );
  }

  /**
   * Add a standalone microphone source — audio-only, contributes to the
   * mix independently of whatever video source is currently on air.
   */
  async function addMicrophone() {
    try {
      const source = await sourceManager.addMicrophone();
      addSourceToScene(source);
      showToast('Microphone added');
    } catch (err) {
      showToast(`Microphone access failed: ${err.message}`, 'error');
    }
  }

  function addSourceToScene(source) {
    sceneManager.addSourceToActive(source.id);
    updatePreviewEmpty();
    renderSourceList();
    renderSceneList();
  }

  function removeSource(sourceId) {
    sceneManager.removeSourceFromActive(sourceId);
    sourceManager.remove(sourceId);
    sceneManager.onSourceRemoved(sourceId);
    updatePreviewEmpty();
    renderSourceList();
    renderSceneList();
  }

  /** Clear every source belonging to the ACTIVE scene only. */
  function removeAllSources() {
    const scene = sceneManager.getActive();
    if (!scene || scene.layers.length === 0) return;

    const ids = scene.layers.map((l) => l.sourceId);
    for (const id of ids) {
      sceneManager.removeSourceFromActive(id);
      sourceManager.remove(id);
      sceneManager.onSourceRemoved(id);
    }
    compositor.clearLayers();
    updatePreviewEmpty();
    renderSourceList();
    renderSceneList();
  }

  /**
   * Click on a source row: switch the on-air source within the active
   * scene. Clicking the currently on-air source hides it, leaving the
   * preview empty — clicking any other source brings it up exclusively.
   * Microphones have no video, so clicking one just toggles its mute
   * state instead.
   */
  function selectSource(sourceId) {
    const source = sourceManager.get(sourceId);
    if (source && source.type === VideoSourceType.MICROPHONE) {
      toggleSourceAudio(sourceId);
      return;
    }

    const scene = sceneManager.getActive();
    const layer = scene?.layers.find((l) => l.sourceId === sourceId);
    if (!layer) return;

    if (layer.visible) {
      sceneManager.hide(sourceId);
    } else {
      sceneManager.showOnly(sourceId);
    }
    renderSourceList();
    updatePreviewEmpty();
  }

  /** Mute/unmute a source's contribution to the audio mix. */
  function toggleSourceAudio(sourceId) {
    const scene = sceneManager.getActive();
    const layer = scene?.layers.find((l) => l.sourceId === sourceId);
    if (!layer) return;
    sceneManager.setAudioMuted(sourceId, !layer.audioMuted);
    renderSourceList();
  }

  // ─── Source List Rendering ─────────────────────────────────────

  function renderSourceList() {
    const scene = sceneManager.getActive();
    const layers = scene?.layers || [];
    const hasSources = layers.length > 0;

    els.sourceEmpty.classList.toggle('hidden', hasSources);

    // Remove existing source items (keep the empty state div)
    const existingItems = els.sourceList.querySelectorAll('.source-item');
    existingItems.forEach((item) => item.remove());

    for (const layer of layers) {
      const source = sourceManager.get(layer.sourceId);
      if (!source) continue; // stale reference — shouldn't normally happen

      const isAudioOnly = source.type === VideoSourceType.MICROPHONE;
      const hasAudio = !!(source.stream && source.stream.getAudioTracks().length > 0);
      const audioMuted = !!layer.audioMuted;
      const isOnAir = !isAudioOnly && layer.visible;

      const item = document.createElement('div');
      item.className = `source-item${isOnAir ? ' active' : ''}${isAudioOnly && !audioMuted ? ' audio-live' : ''}`;
      item.dataset.sourceId = source.id;
      item.setAttribute('role', 'button');
      item.tabIndex = 0;
      item.title = isAudioOnly
        ? (audioMuted ? 'Muted — click to unmute' : 'Click to mute')
        : (isOnAir ? 'On air — click to hide' : 'Click to bring on air');

      const iconClass = source.type.toLowerCase();
      const icon = getIcon(source.type);
      const statusClass = source.state !== SourceState.ACTIVE
        ? (source.state === SourceState.ERROR ? 'error' : 'idle')
        : isAudioOnly
          ? (audioMuted ? 'idle' : 'active')
          : (isOnAir ? 'active' : 'idle');

      const subtitle = isAudioOnly
        ? `${source.type}${audioMuted ? ' · MUTED' : ' · LIVE'}`
        : `${source.type}${isOnAir ? ' · ON AIR' : ''}`;

      const muteButton = hasAudio
        ? `
        <button class="source-mute-btn${audioMuted ? ' muted' : ''}" title="${audioMuted ? 'Unmute audio' : 'Mute audio'}" data-id="${source.id}">
          ${audioMuted
            ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="m23 9-6 6M17 9l6 6"/></svg>'
            : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>'}
        </button>`
        : '';

      item.innerHTML = `
        <div class="source-icon ${iconClass}">${icon}</div>
        <div class="source-info">
          <div class="source-name">${escapeHtml(source.name)}</div>
          <div class="source-type">${subtitle}</div>
        </div>
        <div class="source-status ${statusClass}"></div>
        ${muteButton}
        <button class="source-remove-btn" title="Remove" data-id="${source.id}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      `;

      // Click (or Enter/Space) selects this source as the exclusive on-air
      // source for the active scene (or toggles mute, for microphones) —
      // clicking the on-air one hides it.
      item.addEventListener('click', (e) => {
        if (e.target.closest('.source-remove-btn') || e.target.closest('.source-mute-btn')) return;
        selectSource(source.id);
      });
      item.addEventListener('keydown', (e) => {
        if (e.target.closest('.source-remove-btn') || e.target.closest('.source-mute-btn')) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          selectSource(source.id);
        }
      });

      // Mute button (only present when the source actually has audio)
      const muteBtn = item.querySelector('.source-mute-btn');
      if (muteBtn) {
        muteBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          toggleSourceAudio(source.id);
        });
      }

      // Remove button
      item.querySelector('.source-remove-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        removeSource(source.id);
      });

      els.sourceList.appendChild(item);
    }
  }

  function getIcon(type) {
    switch (type) {
      case VideoSourceType.CAMERA:
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/></svg>';
      case VideoSourceType.TAB:
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M13 2v7h7"/></svg>';
      case VideoSourceType.SCREEN:
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>';
      case VideoSourceType.WINDOW:
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M2 8h20"/></svg>';
      case VideoSourceType.MICROPHONE:
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 19v3"/></svg>';
      default:
        return '❓';
    }
  }

  // ─── Preview Empty State ───────────────────────────────────────

  function updatePreviewEmpty() {
    const hasVisibleLayers = compositor.layers.some((l) => l.visible);
    els.previewEmpty.classList.toggle('hidden', hasVisibleLayers);
  }

  // ─── Recording ─────────────────────────────────────────────────

  /**
   * Build the combined output stream for recording: the compositor's
   * video track plus the audio mixer's single mixed-down audio track
   * (mic, camera mic, tab/screen audio — whatever's unmuted and in the
   * active scene). The canvas alone (compositor.getOutputStream()) never
   * carries audio, which is why recordings were silent before.
   */
  function getRecordingStream() {
    const videoStream = compositor.getOutputStream();
    const videoTrack = videoStream ? videoStream.getVideoTracks()[0] : null;

    const tracks = [];
    if (videoTrack) tracks.push(videoTrack);

    if (!audioMixer.isEmpty) {
      const audioTrack = audioMixer.getOutputStream().getAudioTracks()[0];
      if (audioTrack) tracks.push(audioTrack);
    }

    return new MediaStream(tracks);
  }

  function startRecording() {
    const stream = getRecordingStream();
    if (!stream || stream.getTracks().length === 0) {
      showToast('No source to record', 'error');
      return;
    }

    const settings = {
      mimeType: Recorder.bestMimeType(),
      videoBitsPerSecond: currentSettings?.recording?.videoBitsPerSecond || 5_000_000,
    };

    recorder = new Recorder(stream, settings);
    recorder.start(1000);

    els.recordBtn.classList.add('active');
    els.recordBtn.querySelector('span').textContent = 'Stop';
    els.recordTimer.classList.remove('hidden');
    els.recordStatus.textContent = stream.getAudioTracks().length > 0 ? 'Recording (with audio)...' : 'Recording (video only)...';

    // Start timer
    startRecordTimer();
    updateTally();

    showToast('Recording started');
  }

  function stopRecording() {
    if (!recorder) return;

    // Capture the live Recorder instance and its mimeType BEFORE we null
    // out the outer `recorder` variable below — the .then() callback
    // fires asynchronously, after that assignment, so referencing the
    // outer variable inside it would read null and silently drop the
    // recording (that was the "recording not saving" bug).
    const activeRecorder = recorder;
    const mimeType = recorder.mimeType;
    const name = `Recording ${new Date().toLocaleTimeString()}`;

    activeRecorder.stop().then(async (chunks) => {
      if (chunks.length === 0) {
        showToast('Recording was empty', 'error');
        return;
      }

      // Create blob and save to IndexedDB
      const blob = new Blob(chunks, { type: mimeType });
      try {
        await RecordingsDB.save(blob, name);
        showToast('Recording saved — find it in the Recordings list below');
        renderRecordingsList();
      } catch (err) {
        console.error('Failed to save recording:', err);
        // Fallback: download directly
        activeRecorder.download(`${name}.webm`);
        showToast('Recording downloaded (storage failed)');
      }
    }).catch((err) => {
      console.error('Recording stop failed:', err);
      showToast(`Recording failed to save: ${err.message}`, 'error');
    });

    els.recordBtn.classList.remove('active');
    els.recordBtn.querySelector('span').textContent = 'Record';
    els.recordTimer.classList.add('hidden');
    els.recordStatus.textContent = '';

    stopRecordTimer();
    recorder = null;
    updateTally();
  }

  function startRecordTimer() {
    const update = () => {
      if (!recorder) return;
      const ms = recorder.getDuration();
      els.recordTime.textContent = formatDuration(ms);
    };
    recordingTimer = setInterval(update, 100);
  }

  function stopRecordTimer() {
    if (recordingTimer) {
      clearInterval(recordingTimer);
      recordingTimer = null;
    }
  }

  function formatDuration(ms) {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  // ─── Streaming: multi-destination ────────────────────────────────

  function renderDestinations() {
    const list = streamManager.getAll();
    els.destinationsList.innerHTML = '';

    if (list.length === 0) {
      els.destinationsList.innerHTML = '<div class="rec-empty">No destinations yet — add one below</div>';
      return;
    }

    for (const dest of list) {
      const card = document.createElement('div');
      card.className = `destination-card${dest.state === StreamState.STREAMING ? ' is-live' : ''}`;
      card.dataset.id = dest.id;

      const providerOptions = STREAM_PROVIDERS.map((p) =>
        `<option value="${p.id}" ${p.id === dest.provider ? 'selected' : ''}>${escapeHtml(p.name)}</option>`
      ).join('');

      const isLive = dest.state === StreamState.STREAMING;
      const isConnecting = dest.state === StreamState.CONNECTING;
      const statusLabel = isLive ? 'Live' : isConnecting ? 'Connecting…' : '';

      card.innerHTML = `
        <div class="destination-row">
          <select class="dest-provider">${providerOptions}</select>
          <button class="dest-remove" title="Remove destination">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </div>
        <div class="field">
          <label>Server URL</label>
          <input type="text" class="dest-url mono" placeholder="rtmp://" spellcheck="false" />
        </div>
        <div class="field">
          <label>Stream key</label>
          <input type="password" class="dest-key mono" placeholder="xxxx-xxxx-xxxx-xxxx" spellcheck="false" autocomplete="off" />
        </div>
        <div class="output-row">
          <button class="output-btn dest-go ${isLive ? 'streaming' : ''}" ${isConnecting ? 'disabled' : ''}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
            <span>${isLive ? 'Stop' : isConnecting ? 'Connecting…' : 'Go Live'}</span>
          </button>
          <span class="dest-status">${statusLabel}</span>
        </div>
      `;

      const urlInput = card.querySelector('.dest-url');
      const keyInput = card.querySelector('.dest-key');
      urlInput.value = dest.url || '';
      keyInput.value = dest.streamKey || '';
      urlInput.disabled = isLive || isConnecting;
      keyInput.disabled = isLive || isConnecting;
      card.querySelector('.dest-provider').disabled = isLive || isConnecting;

      card.querySelector('.dest-provider').addEventListener('change', (e) => {
        const provider = STREAM_PROVIDERS.find((p) => p.id === e.target.value);
        if (!provider) return;
        dest.provider = provider.id;
        dest.name = provider.name;
        if (provider.id !== 'custom') {
          dest.url = provider.url;
          urlInput.value = provider.url;
        }
        persistDestinations();
      });

      urlInput.addEventListener('change', () => { dest.url = urlInput.value.trim(); persistDestinations(); });
      keyInput.addEventListener('change', () => { dest.streamKey = keyInput.value.trim(); persistDestinations(); });

      card.querySelector('.dest-remove').addEventListener('click', async () => {
        await streamManager.removeDestination(dest.id);
        renderDestinations();
        persistDestinations();
        updateTally();
      });

      card.querySelector('.dest-go').addEventListener('click', () => {
        if (dest.state === StreamState.STREAMING) {
          stopDestination(dest.id);
        } else if (dest.state !== StreamState.CONNECTING) {
          startDestination(dest.id);
        }
      });

      els.destinationsList.appendChild(card);
    }
  }

  async function persistDestinations() {
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'settings:set',
        key: 'destinations',
        value: streamManager.toJSON(),
      });
      if (res?.settings) currentSettings = res.settings;
    } catch { /* best-effort persistence */ }
  }

  async function startDestination(id) {
    const dest = streamManager.destinations.get(id);
    if (!dest) return;
    if (!dest.url || !dest.streamKey) {
      showToast('Enter a server URL and stream key first', 'error');
      return;
    }

    renderDestinations(); // reflect "connecting" immediately
    const result = await streamManager.start(id, {
      codec: currentSettings?.streaming?.codec || 'vp8',
      videoBitrate: currentSettings?.streaming?.videoBitrate || 2_000_000,
    });

    if (result.ok) {
      showToast(`Live on ${dest.name || dest.provider}`);
    } else {
      showToast(`Stream error: ${result.error}`, 'error');
    }
    updateTally();
    renderDestinations();
  }

  async function stopDestination(id) {
    const dest = streamManager.destinations.get(id);
    await streamManager.stop(id);
    showToast(`Stopped ${dest?.name || 'stream'}`);
    updateTally();
    renderDestinations();
  }

  // ─── Virtual Camera ────────────────────────────────────────────
  // Cross-platform virtual camera support:
  //   Linux:   v4l2loopback (auto-installed by native host on first use)
  //   macOS:   CoreMediaIO plugin (compiled from source)
  //   Windows: DirectShow filter (compiled from source)

  async function handleVcamClick() {
    if (vcamManager.state === VcamState.ACTIVE) {
      await vcamManager.stop();
      return;
    }

    if (vcamManager.state === VcamState.UNSUPPORTED || vcamManager.state === VcamState.NEEDS_BUILD) {
      openVcamSetupModal(vcamManager.error, vcamManager.platform, vcamManager.downloadUrl);
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
    // The real verdict arrives async via Events.VCAM_CHECKED (native host reply)
  }

  async function startVcam() {
    els.vcamBtn.querySelector('span').textContent = 'Starting…';
    const result = await vcamManager.start();
    els.vcamBtn.disabled = false;
    if (!result.ok) {
      showToast(`Virtual camera error: ${result.error}`, 'error');
      els.vcamBtn.querySelector('span').textContent = 'Virtual Cam';
    }
    // Final CONNECTED confirmation arrives via Events.VCAM_STARTED
  }

  function openVcamSetupModal(reason, platform, downloadUrl) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const isLinux = platform === 'linux';
    const isMacWin = platform === 'macos' || platform === 'windows';

    let bodyHtml = '';

    if (isLinux) {
      // Linux: auto-setup may have failed, show manual fallback
      bodyHtml = `
        <p class="confirm-message">${escapeHtml(reason || 'Virtual camera setup needs attention.')}</p>
        <div class="settings-group">
          <div class="settings-group-title">Auto-setup failed — run this in a terminal</div>
          <div class="code-block mono">bash native-host/setup-virtual-cam.sh</div>
        </div>
        <p class="settings-note">This installs v4l2loopback (a kernel module) and labels the device "StreamCam Virtual Camera". It needs sudo.</p>
      `;
    } else if (isMacWin) {
      // macOS/Windows: our own compiled native plugin
      bodyHtml = `
        <p class="confirm-message">The virtual camera needs to be compiled from source.</p>
        <p class="settings-note">StreamCam ships its own virtual camera — no OBS needed. It compiles a small native plugin on first use.</p>
        ${reason ? `<p class="settings-note">${escapeHtml(reason)}</p>` : ''}
        ${downloadUrl ? `<p class="settings-note"><a href="${downloadUrl}" target="_blank" style="color: var(--accent);">${downloadUrl}</a></p>` : ''}
        <div class="settings-group">
          <div class="settings-group-title">Requirements</div>
          <ol style="margin: 0; padding-left: 20px; font-size: 13px; line-height: 1.6;">
            ${platform === 'macos' ? '<li>Xcode Command Line Tools (<code>xcode-select --install</code>)</li>' : '<li>Visual Studio Build Tools (or full Visual Studio)</li>'}
            <li>The plugin compiles automatically on first use</li>
            <li>Select "StreamCam Virtual Camera" in your video app</li>
          </ol>
        </div>
      `;
    } else {
      // Unknown platform
      bodyHtml = `
        <p class="confirm-message">${escapeHtml(reason || 'Virtual camera is not available on this platform.')}</p>
        <p class="settings-note">Install the required build tools, then re-run the installer.</p>
      `;
    }

    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <h3>Virtual Camera Setup</h3>
          <button class="modal-close" data-close>&times;</button>
        </div>
        <div class="modal-body">
          ${bodyHtml}
        </div>
        <div class="modal-footer">
          <button class="btn-secondary" data-close>Close</button>
          ${isLinux ? '<button class="btn-primary" id="vcamRetryBtn">I ran it — check again</button>' : ''}
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    const retryBtn = overlay.querySelector('#vcamRetryBtn');
    if (retryBtn) {
      retryBtn.addEventListener('click', async () => {
        close();
        await vcamManager.check();
      });
    }
  }

  // ─── Recordings List ─────────────────────────────────────────

  async function renderRecordingsList() {
    try {
      const recordings = await RecordingsDB.getAll();
      // Sort newest first
      recordings.sort((a, b) => b.createdAt - a.createdAt);

      if (recordings.length === 0) {
        els.recordingsList.innerHTML = '<div class="rec-empty">No recordings yet</div>';
        return;
      }

      els.recordingsList.innerHTML = '';

      for (const rec of recordings) {
        const item = document.createElement('div');
        item.className = 'recording-item';

        const sizeKB = Math.round(rec.size / 1024);
        const sizeStr = sizeKB > 1024 ? `${(sizeKB / 1024).toFixed(1)} MB` : `${sizeKB} KB`;
        const date = new Date(rec.createdAt).toLocaleString();

        item.innerHTML = `
          <span class="rec-icon">⏺</span>
          <div class="rec-info">
            <div class="rec-name">${escapeHtml(rec.name)}</div>
            <div class="rec-meta">${sizeStr} · ${date}</div>
          </div>
          <button class="rec-download-btn" data-id="${rec.id}">Download</button>
          <button class="rec-delete-btn" data-id="${rec.id}" title="Delete">✕</button>
        `;

        item.querySelector('.rec-download-btn').addEventListener('click', () => RecordingsDB.download(rec.id));
        item.querySelector('.rec-delete-btn').addEventListener('click', async () => {
          await RecordingsDB.remove(rec.id);
          renderRecordingsList();
          showToast('Recording deleted');
        });

        els.recordingsList.appendChild(item);
      }
    } catch (err) {
      els.recordingsList.innerHTML = '<div class="rec-empty">Could not load recordings</div>';
    }
  }

  // ─── Scenes ────────────────────────────────────────────────────

  function renderSceneList() {
    const scenes = sceneManager.getAll();
    const activeId = sceneManager.activeSceneId;

    els.sceneList.innerHTML = '';

    for (const scene of scenes) {
      const chip = document.createElement('div');
      chip.className = `scene-chip${scene.id === activeId ? ' active' : ''}`;
      chip.setAttribute('role', 'button');
      chip.tabIndex = 0;
      chip.innerHTML = `
        <span class="scene-chip-name">${escapeHtml(scene.name)}</span>
        <button class="scene-chip-menu" title="Scene options" aria-label="Scene options">
          <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>
        </button>
      `;

      const switchToScene = () => {
        sceneManager.switchTo(scene.id);
        renderSceneList();
        renderSourceList();
        updatePreviewEmpty();
      };

      chip.addEventListener('click', (e) => {
        if (e.target.closest('.scene-chip-menu')) return;
        switchToScene();
      });
      chip.addEventListener('keydown', (e) => {
        if (e.target.closest('.scene-chip-menu')) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          switchToScene();
        }
      });

      // Right-click anywhere on the chip opens the same options menu
      chip.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showSceneContextMenu(scene, e.clientX, e.clientY);
      });

      chip.querySelector('.scene-chip-menu').addEventListener('click', (e) => {
        e.stopPropagation();
        const rect = e.currentTarget.getBoundingClientRect();
        showSceneContextMenu(scene, rect.left, rect.bottom + 4);
      });

      els.sceneList.appendChild(chip);
    }
  }

  function createScene() {
    const scene = sceneManager.create();
    sceneManager.switchTo(scene.id);
    renderSceneList();
    renderSourceList();
    updatePreviewEmpty();
    showToast(`Created ${scene.name}`);
  }

  // ─── Scene context menu ──────────────────────────────────────────

  let _activeContextMenu = null;

  function closeContextMenu() {
    if (_activeContextMenu) {
      _activeContextMenu.remove();
      _activeContextMenu = null;
    }
  }

  function showSceneContextMenu(scene, x, y) {
    closeContextMenu();

    const canDelete = sceneManager.getAll().length > 1;
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.innerHTML = `
      <button data-action="rename">Rename</button>
      <button data-action="configure">Configure…</button>
      <button data-action="delete" class="danger" ${canDelete ? '' : 'disabled title="You need at least one scene"'}>Delete scene</button>
    `;
    document.body.appendChild(menu);

    // Keep the menu on-screen
    const rect = menu.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - rect.width - 8);
    const top = Math.min(y, window.innerHeight - rect.height - 8);
    menu.style.left = `${Math.max(8, left)}px`;
    menu.style.top = `${Math.max(8, top)}px`;

    _activeContextMenu = menu;

    menu.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn || btn.disabled) return;
      closeContextMenu();
      const action = btn.dataset.action;
      if (action === 'rename') renameSceneFlow(scene);
      else if (action === 'configure') openSceneSettingsModal(scene);
      else if (action === 'delete') deleteSceneFlow(scene);
    });

    // Close on outside click / Escape
    setTimeout(() => {
      document.addEventListener('click', closeContextMenu, { once: true });
      document.addEventListener('keydown', onContextMenuKeydown);
    }, 0);
  }

  function onContextMenuKeydown(e) {
    if (e.key === 'Escape') {
      closeContextMenu();
      document.removeEventListener('keydown', onContextMenuKeydown);
    }
  }

  async function renameSceneFlow(scene) {
    const name = await showPromptModal({ title: 'Rename scene', label: 'Scene name', value: scene.name });
    if (!name) return;
    sceneManager.rename(scene.id, name);
    renderSceneList();
  }

  async function deleteSceneFlow(scene) {
    if (sceneManager.getAll().length <= 1) {
      showToast('You need at least one scene', 'error');
      return;
    }
    const ok = await showConfirmModal({
      title: 'Delete scene?',
      message: `“${scene.name}” and its sources will be removed. This can't be undone.`,
      confirmLabel: 'Delete scene',
    });
    if (!ok) return;

    sceneManager.remove(scene.id);
    renderSceneList();
    renderSourceList();
    updatePreviewEmpty();
    showToast('Scene deleted');
  }

  function openSceneSettingsModal(scene) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const currentRes = scene.resolution ? `${scene.resolution.width}x${scene.resolution.height}` : '';
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <h3>Configure scene</h3>
          <button class="modal-close" data-close>&times;</button>
        </div>
        <div class="modal-body">
          <div class="field">
            <label>Scene name</label>
            <input type="text" id="sceneCfgName" value="${escapeHtml(scene.name)}" />
          </div>
          <div class="field">
            <label>Background color</label>
            <input type="color" id="sceneCfgColor" value="${scene.backgroundColor || '#000000'}" />
          </div>
          <div class="field">
            <label>Resolution</label>
            <select id="sceneCfgRes">
              <option value="" ${!currentRes ? 'selected' : ''}>Use output resolution</option>
              <option value="1920x1080" ${currentRes === '1920x1080' ? 'selected' : ''}>1920×1080</option>
              <option value="1280x720" ${currentRes === '1280x720' ? 'selected' : ''}>1280×720</option>
              <option value="2560x1440" ${currentRes === '2560x1440' ? 'selected' : ''}>2560×1440</option>
              <option value="3840x2160" ${currentRes === '3840x2160' ? 'selected' : ''}>3840×2160</option>
            </select>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-danger" id="sceneCfgDelete" ${sceneManager.getAll().length <= 1 ? 'disabled' : ''}>Delete scene</button>
          <button class="btn-secondary" data-close>Cancel</button>
          <button class="btn-primary" id="sceneCfgSave">Save changes</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    overlay.querySelector('#sceneCfgDelete').addEventListener('click', async () => {
      close();
      await deleteSceneFlow(scene);
    });

    overlay.querySelector('#sceneCfgSave').addEventListener('click', () => {
      const name = overlay.querySelector('#sceneCfgName').value.trim();
      const color = overlay.querySelector('#sceneCfgColor').value;
      const resValue = overlay.querySelector('#sceneCfgRes').value;
      const resolution = resValue ? { width: Number(resValue.split('x')[0]), height: Number(resValue.split('x')[1]) } : null;

      sceneManager.updateConfig(scene.id, { name: name || scene.name, backgroundColor: color, resolution });
      renderSceneList();
      showToast('Scene updated');
      close();
    });
  }

  // ─── Custom confirm / prompt modals (replace window.confirm/prompt) ───

  function showConfirmModal({ title, message, confirmLabel = 'Delete', cancelLabel = 'Cancel' }) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal confirm-modal">
          <div class="modal-header">
            <h3>${escapeHtml(title)}</h3>
            <button class="modal-close" data-close>&times;</button>
          </div>
          <div class="modal-body"><p class="confirm-message">${escapeHtml(message)}</p></div>
          <div class="modal-footer">
            <button class="btn-secondary" data-cancel>${escapeHtml(cancelLabel)}</button>
            <button class="btn-danger" data-ok>${escapeHtml(confirmLabel)}</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      const finish = (result) => { overlay.remove(); resolve(result); };
      overlay.querySelectorAll('[data-close], [data-cancel]').forEach((b) => b.addEventListener('click', () => finish(false)));
      overlay.querySelector('[data-ok]').addEventListener('click', () => finish(true));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(false); });
    });
  }

  function showPromptModal({ title, label, value = '' }) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal prompt-modal">
          <div class="modal-header">
            <h3>${escapeHtml(title)}</h3>
            <button class="modal-close" data-close>&times;</button>
          </div>
          <div class="modal-body">
            <div class="field">
              <label>${escapeHtml(label)}</label>
              <input type="text" id="promptInput" value="${escapeHtml(value)}" />
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn-secondary" data-cancel>Cancel</button>
            <button class="btn-primary" data-ok>Save</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      const input = overlay.querySelector('#promptInput');
      input.focus();
      input.select();

      const finish = (result) => { overlay.remove(); resolve(result); };
      overlay.querySelectorAll('[data-close], [data-cancel]').forEach((b) => b.addEventListener('click', () => finish(null)));
      overlay.querySelector('[data-ok]').addEventListener('click', () => finish(input.value.trim()));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') finish(input.value.trim());
        if (e.key === 'Escape') finish(null);
      });
      overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(null); });
    });
  }

  // ─── FPS Counter ───────────────────────────────────────────────

  function startFpsCounter() {
    setInterval(() => {
      els.fpsDisplay.textContent = `${compositor.currentFps} FPS`;
    }, 1000);
  }

  // ─── Toast ─────────────────────────────────────────────────────

  let toastTimer = null;

  function showToast(message, type = 'info') {
    els.toast.textContent = message;
    els.toast.className = 'show';

    if (type === 'error') {
      els.toast.style.borderColor = 'var(--signal)';
    } else if (type === 'success') {
      els.toast.style.borderColor = 'var(--live)';
    } else {
      els.toast.style.borderColor = 'var(--line)';
    }

    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      els.toast.className = '';
    }, 3000);
  }

  // ─── Utility ───────────────────────────────────────────────────

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ─── Event Binding ─────────────────────────────────────────────

  function bindEvents() {
    // Source buttons
    els.addCameraBtn.addEventListener('click', addCamera);
    els.addTabBtn.addEventListener('click', addTab);
    els.addScreenBtn.addEventListener('click', requestScreenCapture);
    els.addWindowBtn.addEventListener('click', requestWindowCapture);
    els.addMicrophoneBtn.addEventListener('click', addMicrophone);
    els.removeAllBtn.addEventListener('click', removeAllSources);

    // Record
    els.recordBtn.addEventListener('click', () => {
      if (recorder && recorder.state === RecordingState.RECORDING) {
        stopRecording();
      } else {
        startRecording();
      }
    });

    // Stream destinations
    els.addDestinationBtn.addEventListener('click', () => {
      streamManager.addDestination({ provider: 'youtube' });
      renderDestinations();
      persistDestinations();
    });

    // Virtual camera
    els.vcamBtn.addEventListener('click', handleVcamClick);

    bus.on(Events.VCAM_CHECKED, ({ supported, reason, platform, method, downloadUrl }) => {
      els.vcamBtn.disabled = false;
      if (supported) {
        startVcam();
      } else {
        els.vcamBtn.querySelector('span').textContent = 'Virtual Cam';
        els.vcamNote.textContent = reason || 'Virtual camera not available';
        openVcamSetupModal(reason, platform, downloadUrl);
      }
    });

    bus.on(Events.VCAM_STARTED, ({ device }) => {
      els.vcamBtn.classList.add('active');
      els.vcamBtn.querySelector('span').textContent = 'Stop Virtual Cam';
      els.vcamNote.textContent = `Live on ${device} — select "StreamCam Virtual Camera" in your video app`;
      showToast('Virtual camera is live');
    });

    bus.on(Events.VCAM_STOPPED, () => {
      els.vcamBtn.classList.remove('active');
      els.vcamBtn.querySelector('span').textContent = 'Virtual Cam';
      els.vcamNote.textContent = 'Click to check availability — Linux (auto-setup), macOS/Windows (compiles from source)';
    });

    bus.on(Events.VCAM_ERROR, (error) => {
      showToast(`Virtual camera error: ${error}`, 'error');
      els.vcamBtn.classList.remove('active');
      els.vcamBtn.disabled = false;
      els.vcamBtn.querySelector('span').textContent = 'Virtual Cam';
    });

    // Scenes
    els.addSceneBtn.addEventListener('click', createScene);

    // Resolution
    els.resolutionSelect.addEventListener('change', () => {
      const [w, h] = els.resolutionSelect.value.split('x').map(Number);
      compositor.resize(w, h);
    });

    // Settings button + modal
    els.settingsBtn.addEventListener('click', openSettingsModal);
    els.simpleLink.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.runtime.sendMessage({ type: 'openPage', path: 'src/simple.html' });
    });
    els.settingsClose.addEventListener('click', closeSettingsModal);
    els.settingsCancel.addEventListener('click', closeSettingsModal);
    els.settingsSave.addEventListener('click', saveSettingsModal);
    els.settingsOverlay.addEventListener('click', (e) => {
      if (e.target === els.settingsOverlay) closeSettingsModal();
    });

    // Listen for source track ended events
    bus.on(Events.SOURCE_TRACK_ENDED, (source) => {
      showToast(`${source.name} disconnected`, 'error');
      renderSourceList();
    });

    // Listen for scene updates
    bus.on(Events.SCENE_UPDATED, () => {
      sceneManager.save();
    });

    // Listen for stream events (payload is the destination, when known)
    bus.on(Events.STREAM_CONNECTED, () => {
      updateTally();
      renderDestinations();
    });

    bus.on(Events.STREAM_DISCONNECTED, () => {
      updateTally();
      renderDestinations();
    });

    bus.on(Events.STREAM_ERROR, (payload) => {
      const message = (payload && payload.error) || payload || 'Unknown error';
      showToast(`Stream error: ${message}`, 'error');
      updateTally();
      renderDestinations();
    });

    // Escape closes the settings modal
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !els.settingsOverlay.classList.contains('hidden')) {
        closeSettingsModal();
      }
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      // Ctrl+R: Toggle recording
      if (e.ctrlKey && e.key === 'r') {
        e.preventDefault();
        if (recorder && recorder.state === RecordingState.RECORDING) {
          stopRecording();
        } else {
          startRecording();
        }
      }
    });
  }

  // ─── Boot ──────────────────────────────────────────────────────

  init();
})();
