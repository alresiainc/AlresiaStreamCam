/**
 * Alresia StreamCam — Virtual Camera Manager
 * Drives the native host's virtual-camera output across platforms:
 *
 * Linux:   FFmpeg writing raw frames to a v4l2loopback device
 *          (auto-installed on first use by the native host)
 * macOS:   CoreMediaIO DAL plugin (compiled from source)
 *          Receives frames via Unix domain socket
 * Windows: DirectShow source filter (compiled from source)
 *          Receives frames via named pipe
 *
 * On macOS/Windows, our own native plugin registers as "StreamCam
 * Virtual Camera" — a system-wide webcam visible in all video apps.
 * Frames are piped from the extension via the native host.
 *
 * On Linux, the same raw-frame relay as RTMP streaming is used —
 * 'stream:sendFrame' messages keyed under 'vcam' instead of a
 * destination id.
 */

const VcamState = Object.freeze({
  IDLE: 'IDLE',
  CHECKING: 'CHECKING',
  CONNECTING: 'CONNECTING',
  ACTIVE: 'ACTIVE',
  ERROR: 'ERROR',
  UNSUPPORTED: 'UNSUPPORTED',
  NEEDS_BUILD: 'NEEDS_BUILD', // macOS/Windows: native plugin needs compilation
});

class VirtualCamManager {
  constructor() {
    this.state = VcamState.IDLE;
    this.device = null;
    this.error = null;
    this.platform = null;     // 'linux', 'macos', 'windows'
    this.method = null;       // 'v4l2loopback', 'obs_virtualcam'
    this.downloadUrl = null;  // download URL for build tools if needed
    this._frameSource = null; // { source, width, height, fps } — source is a <canvas> or <video>
    this._frameTimer = null;
    this._scratchCanvas = null;
    this._scratchCtx = null;
  }

  /** Point the frame pump at whatever's being previewed — canvas or video. */
  setFrameSource(source, { width = 960, height = 540, fps = 15 } = {}) {
    this._frameSource = { source, width, height, fps };
  }

  /** Ask the native host whether virtual cam is available on this machine. */
  async check() {
    this.state = VcamState.CHECKING;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'vcam:check' });
      if (!res || !res.ok) {
        this.state = VcamState.ERROR;
        this.error = res?.error || 'Could not reach the native host';
        return { ok: false, error: this.error };
      }
      // The actual supported/unsupported verdict arrives asynchronously via
      // handleHostMessage() ('VCAM_STATUS') — this call just confirms the
      // request reached the host.
      return { ok: true };
    } catch (err) {
      this.state = VcamState.ERROR;
      this.error = String(err && err.message || err);
      return { ok: false, error: this.error };
    }
  }

  async start() {
    if (this.state === VcamState.ACTIVE) return { ok: false, error: 'Already running' };

    const frame = this._frameSource;
    if (!frame) return { ok: false, error: 'Preview is not ready yet' };

    this.state = VcamState.CONNECTING;

    try {
      const res = await chrome.runtime.sendMessage({
        type: 'vcam:start',
        config: { width: frame.width, height: frame.height, fps: frame.fps },
      });

      if (!res || !res.ok) {
        this.state = VcamState.ERROR;
        this.error = res?.error || 'Could not reach the native host';
        return { ok: false, error: this.error };
      }

      // CONNECTED/ERROR confirmation arrives asynchronously via
      // handleHostMessage(); start the pump now so frames are ready
      // the moment FFmpeg opens the device.
      this._ensureFramePump();
      return { ok: true };
    } catch (err) {
      this.state = VcamState.ERROR;
      this.error = String(err && err.message || err);
      return { ok: false, error: this.error };
    }
  }

  async stop() {
    try {
      await chrome.runtime.sendMessage({ type: 'vcam:stop' });
    } catch { /* best-effort */ }
    this.state = VcamState.IDLE;
    this._maybeStopFramePump();
  }

  /** Handle a STATUS/VCAM_STATUS/VCAM_SETUP_RESULT message relayed from the native host. */
  handleHostMessage(msg) {
    // Handle auto-setup result from the native host
    if (msg.type === 'VCAM_SETUP_RESULT') {
      this.platform = msg.platform;
      if (msg.status === 'ready') {
        this.method = msg.method || 'v4l2loopback';
        this.device = msg.device;
        this.error = null;
      } else if (msg.status === 'needs_setup' || msg.status === 'needs_build_tools') {
        this.state = VcamState.NEEDS_BUILD;
        this.error = msg.reason;
      }
      return;
    }

    if (msg.type === 'VCAM_STATUS') {
      this.platform = msg.platform || this.platform;

      if (msg.supported) {
        this.state = VcamState.IDLE;
        this.device = msg.device;
        this.method = msg.method || 'v4l2loopback';
        this.error = null;
      } else {
        if (msg.downloadUrl) {
          this.state = VcamState.NEEDS_BUILD;
          this.downloadUrl = msg.downloadUrl;
        } else {
          this.state = VcamState.UNSUPPORTED;
        }
        this.error = msg.reason;
      }
      bus.emit(Events.VCAM_CHECKED, {
        supported: msg.supported,
        reason: msg.reason,
        device: msg.device,
        platform: msg.platform,
        method: msg.method,
        downloadUrl: msg.downloadUrl,
      });
      return;
    }

    if (msg.type === 'STATUS' && msg.destinationId === 'vcam') {
      if (msg.status === 'CONNECTED') {
        this.state = VcamState.ACTIVE;
        this.device = msg.device || this.device;
        this.platform = msg.platform || this.platform;
        this.method = msg.method || this.method;
        this.error = null;
        bus.emit(Events.VCAM_STARTED, {
          device: this.device,
          platform: this.platform,
          method: this.method,
        });
      } else if (msg.status === 'DISCONNECTED') {
        this.state = VcamState.IDLE;
        this._maybeStopFramePump();
        bus.emit(Events.VCAM_STOPPED);
      } else if (msg.status === 'ERROR') {
        this.state = VcamState.ERROR;
        this.error = msg.error;
        this._maybeStopFramePump();
        bus.emit(Events.VCAM_ERROR, msg.error);
      }
    }
  }

  _ensureFramePump() {
    if (this._frameTimer || !this._frameSource) return;

    const { source, width, height, fps } = this._frameSource;
    if (!this._scratchCanvas) this._scratchCanvas = document.createElement('canvas');
    this._scratchCanvas.width = width;
    this._scratchCanvas.height = height;
    this._scratchCtx = this._scratchCanvas.getContext('2d', { willReadFrequently: true });

    const intervalMs = Math.max(1000 / (fps || 15), 33);

    this._frameTimer = setInterval(() => {
      if (this.state !== VcamState.ACTIVE && this.state !== VcamState.CONNECTING) return;

      try {
        this._scratchCtx.drawImage(source, 0, 0, width, height);
        const imageData = this._scratchCtx.getImageData(0, 0, width, height);
        const base64 = vcamArrayBufferToBase64(imageData.data.buffer);

        chrome.runtime.sendMessage({
          type: 'stream:sendFrame', // shared relay path with RTMP streaming
          destinationId: 'vcam',
          chunk: { data: base64, type: 'video', width, height },
        }).catch(() => { /* best-effort */ });
      } catch (err) {
        console.error('[VirtualCamManager] frame pump error:', err);
      }
    }, intervalMs);
  }

  _maybeStopFramePump() {
    if (this._frameTimer) {
      clearInterval(this._frameTimer);
      this._frameTimer = null;
    }
  }
}

function vcamArrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
