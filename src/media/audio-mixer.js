/**
 * Alresia StreamCam — Audio Mixer
 * Mixes audio tracks from any number of sources (microphone, camera mic,
 * tab/screen "share audio") into a single output track, using the Web
 * Audio API. Each source gets its own gain node so it can be muted or
 * have its volume adjusted independently without touching the others.
 *
 * The compositor handles video (canvas → captureStream); this is its
 * audio counterpart, and the two output tracks are combined into one
 * MediaStream for recording.
 */

class AudioMixer {
  constructor() {
    /** @type {AudioContext|null} */
    this.audioContext = null;
    /** @type {MediaStreamAudioDestinationNode|null} */
    this.destinationNode = null;
    /** @type {Map<string, {sourceNode: MediaStreamAudioSourceNode, gainNode: GainNode}>} */
    this.nodes = new Map();
  }

  _ensureContext() {
    if (!this.audioContext) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      this.audioContext = new Ctor();
      this.destinationNode = this.audioContext.createMediaStreamDestination();
    }
    if (this.audioContext.state === 'suspended') {
      // Browsers suspend AudioContext until a user gesture — every button
      // click in the studio counts, so this quietly self-heals.
      this.audioContext.resume().catch(() => { /* best-effort */ });
    }
  }

  /** The single mixed-down output stream (one audio track). */
  getOutputStream() {
    this._ensureContext();
    return this.destinationNode.stream;
  }

  /**
   * Route a source's audio into the mix.
   * @param {string} sourceId
   * @param {MediaStream} stream - must contain at least one audio track
   * @param {{muted?: boolean, volume?: number}} [opts]
   */
  addSource(sourceId, stream, opts = {}) {
    if (!stream || stream.getAudioTracks().length === 0) return;
    if (this.nodes.has(sourceId)) {
      this.setMuted(sourceId, !!opts.muted);
      return;
    }

    this._ensureContext();

    try {
      // Use an audio-only MediaStream so createMediaStreamSource doesn't
      // also latch onto a video track that has nothing to do with audio.
      const audioOnly = new MediaStream(stream.getAudioTracks());
      const sourceNode = this.audioContext.createMediaStreamSource(audioOnly);
      const gainNode = this.audioContext.createGain();
      gainNode.gain.value = opts.muted ? 0 : (opts.volume ?? 1);

      sourceNode.connect(gainNode).connect(this.destinationNode);
      this.nodes.set(sourceId, { sourceNode, gainNode });
    } catch (err) {
      console.error('[AudioMixer] Failed to add source:', sourceId, err);
    }
  }

  /** Disconnect and drop a source from the mix. */
  removeSource(sourceId) {
    const entry = this.nodes.get(sourceId);
    if (!entry) return;
    try {
      entry.sourceNode.disconnect();
      entry.gainNode.disconnect();
    } catch { /* already disconnected */ }
    this.nodes.delete(sourceId);
  }

  /** Mute/unmute a source without removing it from the graph. */
  setMuted(sourceId, muted) {
    const entry = this.nodes.get(sourceId);
    if (!entry) return;
    entry.gainNode.gain.value = muted ? 0 : 1;
  }

  /** Set a source's volume (0–1+). */
  setVolume(sourceId, volume) {
    const entry = this.nodes.get(sourceId);
    if (!entry) return;
    entry.gainNode.gain.value = volume;
  }

  hasSource(sourceId) {
    return this.nodes.has(sourceId);
  }

  /** Whether the mix currently has at least one contributing source. */
  get isEmpty() {
    return this.nodes.size === 0;
  }

  /** Drop every source (used when switching scenes). */
  clear() {
    for (const id of Array.from(this.nodes.keys())) this.removeSource(id);
  }

  /** Full teardown. */
  destroy() {
    this.clear();
    if (this.audioContext) {
      this.audioContext.close().catch(() => { /* ignore */ });
      this.audioContext = null;
      this.destinationNode = null;
    }
  }
}
