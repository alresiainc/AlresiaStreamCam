/**
 * Alresia StreamCam — Stream Manager
 * Manages one or more simultaneous RTMP destinations via the native
 * messaging host. Each destination runs its own FFmpeg process on the
 * host side (keyed by destinationId); a single shared "frame pump" reads
 * the compositor canvas and fans downsized raw frames out to every
 * destination that's currently live.
 *
 * NOTE ON QUALITY: to keep native-messaging payloads reliable across
 * machines without extra native dependencies, the frame pump ships
 * downscaled raw RGBA frames (not hardware-encoded WebCodecs chunks).
 * FFmpeg on the host side does the actual video encoding. This trades
 * outgoing resolution/framerate for reliability — full-resolution
 * hardware encoding is a future upgrade, not a correctness issue.
 */

const STREAM_PROVIDERS = [
  { id: 'youtube', name: 'YouTube', url: 'rtmp://a.rtmp.youtube.com/live2' },
  { id: 'twitch', name: 'Twitch', url: 'rtmp://live.twitch.tv/app' },
  { id: 'facebook', name: 'Facebook Live', url: 'rtmps://live-api-s.facebook.com:443/rtmp' },
  { id: 'kick', name: 'Kick', url: 'rtmps://fa723fc1b171.global-contribute.live-video.net/app' },
  { id: 'tiktok', name: 'TikTok', url: 'rtmp://push.tiktokcdn.com/live' },
  { id: 'custom', name: 'Custom RTMP…', url: '' },
];

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

class StreamManager {
  constructor() {
    /** @type {Map<string, object>} destinationId → destination */
    this.destinations = new Map();
    this._nextNum = 1;
    this._frameSource = null; // { canvas, width, height, fps }
    this._frameTimer = null;
    this._scratchCanvas = null;
    this._scratchCtx = null;
  }

  // ─── Destination management ──────────────────────────────────────

  /**
   * Register a new destination (not yet live).
   * @param {{provider?: string, name?: string, url?: string, streamKey?: string, id?: string}} opts
   */
  addDestination(opts = {}) {
    const provider = STREAM_PROVIDERS.find((p) => p.id === opts.provider) || STREAM_PROVIDERS[0];
    const id = opts.id || `dest_${Date.now()}_${this._nextNum++}`;
    const dest = {
      id,
      provider: provider.id,
      name: opts.name || provider.name,
      url: opts.url != null ? opts.url : provider.url,
      streamKey: opts.streamKey || '',
      state: StreamState.IDLE,
    };
    this.destinations.set(id, dest);
    return dest;
  }

  async removeDestination(id) {
    const dest = this.destinations.get(id);
    if (!dest) return;
    if (dest.state === StreamState.STREAMING || dest.state === StreamState.CONNECTING) {
      await this.stop(id);
    }
    this.destinations.delete(id);
  }

  updateDestination(id, patch) {
    const dest = this.destinations.get(id);
    if (!dest) return null;
    Object.assign(dest, patch);
    return dest;
  }

  getAll() {
    return Array.from(this.destinations.values());
  }

  get anyLive() {
    return this.getAll().some((d) => d.state === StreamState.STREAMING);
  }

  /** Serialize destinations for persistence (no live state). */
  toJSON() {
    return this.getAll().map(({ id, provider, name, url, streamKey }) => ({ id, provider, name, url, streamKey }));
  }

  /** Point the frame pump at the live preview canvas. */
  setFrameSource(canvas, { width = 480, height = 270, fps = 6 } = {}) {
    this._frameSource = { canvas, width, height, fps };
  }

  // ─── Start / stop ────────────────────────────────────────────────

  /**
   * Start streaming a specific destination.
   * @param {string} id
   * @param {{codec?: string, videoBitrate?: number, keyframeInterval?: number}} opts
   */
  async start(id, opts = {}) {
    const dest = this.destinations.get(id);
    if (!dest) return { ok: false, error: 'Unknown destination' };
    if (dest.state === StreamState.STREAMING) return { ok: false, error: 'Already live' };
    if (!dest.url || !dest.streamKey) return { ok: false, error: 'Missing server URL or stream key' };

    const frame = this._frameSource;
    if (!frame) return { ok: false, error: 'Preview is not ready yet' };

    dest.state = StreamState.CONNECTING;

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'stream:start',
        config: {
          destinationId: id,
          url: dest.url,
          streamKey: dest.streamKey,
          width: frame.width,
          height: frame.height,
          fps: frame.fps,
          videoBitrate: opts.videoBitrate || 2_000_000,
          codec: opts.codec || 'vp8',
          keyframeInterval: opts.keyframeInterval || 2,
        },
      });

      if (!response || !response.ok) {
        dest.state = StreamState.ERROR;
        return { ok: false, error: response?.error || 'Could not reach the native host' };
      }

      dest.state = StreamState.STREAMING;
      this._ensureFramePump();
      bus.emit(Events.STREAM_CONNECTED, dest);
      return { ok: true };
    } catch (err) {
      dest.state = StreamState.ERROR;
      return { ok: false, error: String(err && err.message || err) };
    }
  }

  /** Stop a specific destination. */
  async stop(id) {
    const dest = this.destinations.get(id);
    if (!dest) return { ok: true };

    try {
      await chrome.runtime.sendMessage({ type: 'stream:stop', destinationId: id });
    } catch { /* ignore */ }

    dest.state = StreamState.IDLE;
    bus.emit(Events.STREAM_DISCONNECTED, dest);
    this._maybeStopFramePump();
    return { ok: true };
  }

  /** Stop every live destination (used when the studio unloads). */
  async stopAll() {
    const live = this.getAll().filter((d) => d.state === StreamState.STREAMING || d.state === StreamState.CONNECTING);
    for (const dest of live) {
      await this.stop(dest.id);
    }
  }

  /**
   * Handle a STATUS message that came back from the native host.
   * Called by the service worker relay.
   */
  handleHostMessage(msg) {
    if (msg.type !== 'STATUS') return;
    if (msg.destinationId === 'vcam') return; // handled by VirtualCamManager instead
    const dest = msg.destinationId ? this.destinations.get(msg.destinationId) : null;

    if (msg.status === 'CONNECTED') {
      if (dest) dest.state = StreamState.STREAMING;
      bus.emit(Events.STREAM_CONNECTED, dest);
    } else if (msg.status === 'DISCONNECTED') {
      if (dest) dest.state = StreamState.IDLE;
      bus.emit(Events.STREAM_DISCONNECTED, dest);
      this._maybeStopFramePump();
    } else if (msg.status === 'ERROR') {
      if (dest) dest.state = StreamState.ERROR;
      bus.emit(Events.STREAM_ERROR, { destination: dest, error: msg.error });
      this._maybeStopFramePump();
    }
  }

  // ─── Frame pump ──────────────────────────────────────────────────
  // A single interval grabs the compositor canvas, downsizes it, and
  // ships the raw frame to every currently-live destination.

  _ensureFramePump() {
    if (this._frameTimer || !this._frameSource) return;

    const { canvas, width, height, fps } = this._frameSource;
    if (!this._scratchCanvas) {
      this._scratchCanvas = document.createElement('canvas');
    }
    this._scratchCanvas.width = width;
    this._scratchCanvas.height = height;
    this._scratchCtx = this._scratchCanvas.getContext('2d', { willReadFrequently: true });

    const intervalMs = Math.max(1000 / (fps || 6), 66);

    this._frameTimer = setInterval(() => {
      const liveIds = this.getAll()
        .filter((d) => d.state === StreamState.STREAMING)
        .map((d) => d.id);
      if (liveIds.length === 0) return;

      try {
        this._scratchCtx.drawImage(canvas, 0, 0, width, height);
        const imageData = this._scratchCtx.getImageData(0, 0, width, height);
        const base64 = arrayBufferToBase64(imageData.data.buffer);

        for (const id of liveIds) {
          chrome.runtime.sendMessage({
            type: 'stream:sendFrame',
            destinationId: id,
            chunk: { data: base64, type: 'video' },
          }).catch(() => { /* best-effort */ });
        }
      } catch (err) {
        console.error('[StreamManager] frame pump error:', err);
      }
    }, intervalMs);
  }

  _maybeStopFramePump() {
    if (this.anyLive) return;
    if (this._frameTimer) {
      clearInterval(this._frameTimer);
      this._frameTimer = null;
    }
  }

  // ─── Legacy single-destination helpers (kept for the native host ping) ──

  async connectNativeHost() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'native:connect' });
      return !!(response && response.ok);
    } catch {
      return false;
    }
  }

  async disconnectNativeHost() {
    try {
      await chrome.runtime.sendMessage({ type: 'native:disconnect' });
    } catch { /* ignore */ }
  }
}
