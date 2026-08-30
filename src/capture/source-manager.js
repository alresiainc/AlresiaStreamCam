/**
 * Alresia StreamCam — Source Manager
 * Manages the lifecycle of all video sources (camera, tab, screen, window).
 * Normalizes different capture APIs into a unified VideoSource interface.
 */

class VideoSource {
  constructor({ id, type, name, meta = {} }) {
    this.id = id;
    this.type = type;       // VideoSourceType
    this.name = name;
    this.meta = meta;       // Extra data (tabId, deviceId, etc.)
    this.stream = null;
    this.state = SourceState.IDLE;
    this.videoElement = null;
    this.error = null;
  }

  /** Get the active video track, if any. */
  getVideoTrack() {
    return this.stream?.getVideoTracks()[0] || null;
  }

  /** Get the active audio track, if any. */
  getAudioTrack() {
    return this.stream?.getAudioTracks()[0] || null;
  }

  /** Create and return a <video> element fed by this source's stream. */
  getVideoElement() {
    if (this.videoElement) return this.videoElement;
    if (!this.stream) return null;

    const video = document.createElement('video');
    video.srcObject = this.stream;
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.id = `source-video-${this.id}`;
    // Don't add to DOM — keep it hidden for compositor use
    this.videoElement = video;
    return video;
  }

  /** Stop all tracks and clean up. */
  stop() {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => {
        t.stop();
        t.enabled = false;
      });
      this.stream = null;
    }
    if (this.videoElement) {
      this.videoElement.srcObject = null;
      this.videoElement = null;
    }
    this.state = SourceState.IDLE;
    this.error = null;
  }

  /** Serialize for storage/transport. */
  toJSON() {
    return {
      id: this.id,
      type: this.type,
      name: this.name,
      state: this.state,
      meta: this.meta,
    };
  }
}

// ─── Source Manager ───────────────────────────────────────────────────

class SourceManager {
  constructor() {
    /** @type {Map<string, VideoSource>} */
    this.sources = new Map();
    this._nextId = 1;
  }

  /** Generate a unique source ID. */
  _generateId(type) {
    return `${type.toLowerCase()}_${Date.now()}_${this._nextId++}`;
  }

  /**
   * Add a camera source.
   * @param {string} deviceId - Media device ID (empty string for default)
   * @param {string} label - Display name
   * @returns {Promise<VideoSource>}
   */
  async addCamera(deviceId = '', label = '') {
    const constraints = {
      video: deviceId ? { deviceId: { exact: deviceId } } : true,
      audio: true,
    };

    const source = new VideoSource({
      id: this._generateId(VideoSourceType.CAMERA),
      type: VideoSourceType.CAMERA,
      name: label || 'Camera',
      meta: { deviceId },
    });

    source.state = SourceState.REQUESTING;

    try {
      source.stream = await navigator.mediaDevices.getUserMedia(constraints);
      source.state = SourceState.ACTIVE;

      // Auto-handle track ended (camera unplugged, permission revoked)
      source.stream.getTracks().forEach((track) => {
        track.addEventListener('ended', () => {
          source.state = SourceState.ERROR;
          source.error = 'Track ended unexpectedly';
          bus.emit(Events.SOURCE_TRACK_ENDED, source);
        });
      });

      this.sources.set(source.id, source);
      bus.emit(Events.SOURCE_ADDED, source);
      return source;
    } catch (err) {
      source.state = SourceState.ERROR;
      source.error = err.message;
      throw err;
    }
  }

  /**
   * Add a standalone microphone source (audio-only, no video track).
   * @param {string} [deviceId] - Media device ID (empty string for default)
   * @param {string} [label] - Display name
   * @returns {Promise<VideoSource>}
   */
  async addMicrophone(deviceId = '', label = '') {
    const source = new VideoSource({
      id: this._generateId(VideoSourceType.MICROPHONE),
      type: VideoSourceType.MICROPHONE,
      name: label || 'Microphone',
      meta: { deviceId },
    });

    source.state = SourceState.REQUESTING;

    try {
      source.stream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
        video: false,
      });
      source.state = SourceState.ACTIVE;

      source.stream.getTracks().forEach((track) => {
        track.addEventListener('ended', () => {
          source.state = SourceState.ERROR;
          source.error = 'Microphone disconnected';
          bus.emit(Events.SOURCE_TRACK_ENDED, source);
        });
      });

      this.sources.set(source.id, source);
      bus.emit(Events.SOURCE_ADDED, source);
      return source;
    } catch (err) {
      source.state = SourceState.ERROR;
      source.error = err.message;
      throw err;
    }
  }

  /**
   * Add a browser tab capture source obtained via chrome.desktopCapture
   * (source type 'tab'). Kept for backward compatibility with any code
   * that already has a streamId from the desktop-capture picker; new
   * call sites should just use addFromDesktopCapture directly.
   * @param {string} streamId - The streamId from chrome.desktopCapture
   * @param {object} meta - { tabTitle }
   * @returns {Promise<VideoSource>}
   */
  async addTab(streamId, meta = {}) {
    return this.addFromDesktopCapture(streamId, {
      type: VideoSourceType.TAB,
      name: meta.tabTitle || 'Browser Tab',
      audio: true,
    });
  }

  /**
   * Add a screen or window capture source.
   * Uses chrome.desktopCapture.chooseDesktopMedia() which shows the picker.
   * Must be called from a page context (not service worker).
   * @param {object} meta - { streamId, name }
   * @returns {Promise<VideoSource>}
   */
  async addScreen(streamId, meta = {}) {
    return this.addFromDesktopCapture(streamId, { type: VideoSourceType.SCREEN, name: meta.name || 'Screen', audio: false });
  }

  /**
   * Add a source from chrome.desktopCapture — used for screen, window, AND
   * tab captures. Chrome's native picker (chosen source types passed to
   * chrome.desktopCapture.chooseDesktopMedia) determines what shows up;
   * every resulting streamId is consumed the same way, via
   * chromeMediaSource: 'desktop', regardless of what the person picked.
   * @param {string} streamId
   * @param {{type?: string, name?: string, audio?: boolean}} opts
   * @returns {Promise<VideoSource>}
   */
  async addFromDesktopCapture(streamId, opts = {}) {
    const type = opts.type || VideoSourceType.SCREEN;
    const source = new VideoSource({
      id: this._generateId(type),
      type,
      name: opts.name || 'Screen',
      meta: { streamId },
    });

    source.state = SourceState.REQUESTING;

    try {
      const constraints = {
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: streamId,
          },
        },
        audio: opts.audio
          ? {
              mandatory: {
                chromeMediaSource: 'desktop',
                chromeMediaSourceId: streamId,
              },
            }
          : false,
      };

      source.stream = await navigator.mediaDevices.getUserMedia(constraints);

      source.state = SourceState.ACTIVE;

      source.stream.getTracks().forEach((track) => {
        track.addEventListener('ended', () => {
          source.state = SourceState.ERROR;
          source.error = 'Capture ended';
          bus.emit(Events.SOURCE_TRACK_ENDED, source);
        });
      });

      this.sources.set(source.id, source);
      bus.emit(Events.SOURCE_ADDED, source);
      return source;
    } catch (err) {
      source.state = SourceState.ERROR;
      source.error = err.message;
      throw err;
    }
  }

  /**
   * Remove a source by ID.
   * @param {string} id
   */
  remove(id) {
    const source = this.sources.get(id);
    if (!source) return;
    source.stop();
    this.sources.delete(id);
    bus.emit(Events.SOURCE_REMOVED, source);
  }

  /** Remove all sources. */
  removeAll() {
    for (const [id] of this.sources) {
      this.remove(id);
    }
  }

  /** Get a source by ID. */
  get(id) {
    return this.sources.get(id) || null;
  }

  /** Get all sources. */
  getAll() {
    return Array.from(this.sources.values());
  }

  /** Get active sources only. */
  getActive() {
    return this.getAll().filter((s) => s.state === SourceState.ACTIVE);
  }

  /**
   * Request camera device enumeration.
   * Must be called from a page context.
   * @returns {Promise<MediaDeviceInfo[]>}
   */
  static async enumerateCameras() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter((d) => d.kind === 'videoinput');
    } catch {
      return [];
    }
  }

  /**
   * Request tab list for the current window.
   * Uses chrome.tabs API (works from service worker or content script).
   * @returns {Promise<Array<{id, title, url, favIconUrl}>>}
   */
  static async enumerateTabs() {
    try {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      return tabs
        .filter((t) => t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://'))
        .map((t) => ({
          id: t.id,
          title: t.title || 'Untitled Tab',
          url: t.url,
          favIconUrl: t.favIconUrl,
        }));
    } catch {
      return [];
    }
  }
}
