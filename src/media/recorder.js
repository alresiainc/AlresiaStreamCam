/**
 * Alresia StreamCam — Recorder
 * Local recording using the MediaRecorder API.
 * Records the compositor's output stream.
 */

class Recorder {
  /**
   * @param {MediaStream} stream - The compositor's output stream
   * @param {object} options
   * @param {string} options.mimeType - e.g. 'video/webm;codecs=vp9'
   * @param {number} options.videoBitsPerSecond
   * @param {number} options.audioBitsPerSecond
   * @param {number} options.maxFramerate
   */
  constructor(stream, options = {}) {
    this.stream = stream;
    this.recorder = null;
    this.state = RecordingState.IDLE;
    this.chunks = [];
    this.startTime = null;
    this.pauseTime = null;
    this.totalPausedMs = 0;

    this.mimeType = options.mimeType || DEFAULT_SETTINGS.recording.mimeType;
    this.videoBitsPerSecond = options.videoBitsPerSecond || DEFAULT_SETTINGS.recording.videoBitsPerSecond;
    this.audioBitsPerSecond = options.audioBitsPerSecond || DEFAULT_SETTINGS.recording.audioBitsPerSecond;

    this._onDataCallbacks = [];
    this._onStopCallbacks = [];
  }

  /** Check if recording is supported in this browser. */
  static isSupported(mimeType) {
    return typeof MediaRecorder !== 'undefined' &&
      (mimeType ? MediaRecorder.isTypeSupported(mimeType) : true);
  }

  /** Find the best supported MIME type. */
  static bestMimeType() {
    const candidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=vp8',
      'video/webm',
    ];
    for (const mime of candidates) {
      if (MediaRecorder.isTypeSupported(mime)) return mime;
    }
    return 'video/webm';
  }

  /**
   * Start recording.
   * @param {number} [timeslice] - Milliseconds between dataavailable events (default 1000)
   */
  start(timeslice = 1000) {
    if (this.state === RecordingState.RECORDING) return;

    this.chunks = [];
    this.startTime = performance.now();
    this.totalPausedMs = 0;

    this.recorder = new MediaRecorder(this.stream, {
      mimeType: this.mimeType,
      videoBitsPerSecond: this.videoBitsPerSecond,
      audioBitsPerSecond: this.audioBitsPerSecond,
    });

    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        this.chunks.push(e.data);
        for (const cb of this._onDataCallbacks) {
          cb(e.data, this.chunks);
        }
      }
    };

    this.recorder.onstop = () => {
      this.state = RecordingState.IDLE;
      for (const cb of this._onStopCallbacks) {
        cb(this.chunks);
      }
    };

    this.recorder.onerror = (e) => {
      console.error('[Recorder] Error:', e.error);
      this.state = RecordingState.IDLE;
    };

    this.recorder.start(timeslice);
    this.state = RecordingState.RECORDING;
    bus.emit(Events.RECORDING_STARTED);
  }

  /**
   * Stop recording.
   * Returns a promise that resolves with the chunks when stopped.
   * @returns {Promise<Blob[]>}
   */
  stop() {
    return new Promise((resolve) => {
      if (this.state === RecordingState.IDLE) {
        resolve([]);
        return;
      }

      this.onceStop((chunks) => {
        resolve(chunks);
      });

      this.recorder.stop();
      bus.emit(Events.RECORDING_STOPPED);
    });
  }

  /**
   * Pause recording (if supported).
   */
  pause() {
    if (this.state !== RecordingState.RECORDING) return;
    if (this.recorder && this.recorder.pause) {
      this.recorder.pause();
      this.state = RecordingState.PAUSED;
      this.pauseTime = performance.now();
      bus.emit(Events.RECORDING_PAUSED);
    }
  }

  /**
   * Resume recording.
   */
  resume() {
    if (this.state !== RecordingState.PAUSED) return;
    if (this.recorder && this.recorder.resume) {
      this.recorder.resume();
      this.state = RecordingState.RECORDING;
      if (this.pauseTime) {
        this.totalPausedMs += performance.now() - this.pauseTime;
        this.pauseTime = null;
      }
    }
  }

  /**
   * Get the current recording duration in milliseconds.
   */
  getDuration() {
    if (!this.startTime) return 0;
    const elapsed = performance.now() - this.startTime;
    return elapsed - this.totalPausedMs;
  }

  /**
   * Get recording status.
   */
  getStatus() {
    return {
      state: this.state,
      duration: this.getDuration(),
      chunkCount: this.chunks.length,
      mimeType: this.mimeType,
    };
  }

  /**
   * Register a callback for data chunks.
   * @param {Function} callback - (data: Blob, allChunks: Blob[]) => void
   */
  onData(callback) {
    this._onDataCallbacks.push(callback);
  }

  /**
   * Register a callback for when recording stops.
   * @param {Function} callback - (chunks: Blob[]) => void
   */
  onceStop(callback) {
    this._onStopCallbacks.push(callback);
  }

  /**
   * Create a download link for the recorded video.
   * @param {string} [filename] - Default filename
   * @returns {string} Object URL
   */
  createDownloadURL(filename) {
    const blob = new Blob(this.chunks, { type: this.mimeType });
    const url = URL.createObjectURL(blob);
    return url;
  }

  /**
   * Trigger a download of the recorded video.
   * @param {string} [filename] - Default filename
   */
  download(filename) {
    const url = this.createDownloadURL();
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || `streamcam-${new Date().toISOString().slice(0, 19).replace(/[:-]/g, '')}.webm`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  /** Clean up resources. */
  destroy() {
    if (this.state !== RecordingState.IDLE) {
      this.recorder?.stop();
    }
    this._onDataCallbacks = [];
    this._onStopCallbacks = [];
    this.chunks = [];
  }
}
