/**
 * Alresia StreamCam — Constants and type definitions
 * All enums and default values used across the extension.
 */

// ─── Video Source Types ───────────────────────────────────────────────

const VideoSourceType = Object.freeze({
  CAMERA: 'CAMERA',
  TAB: 'TAB',
  SCREEN: 'SCREEN',
  WINDOW: 'WINDOW',
  MEDIA: 'MEDIA',
  MICROPHONE: 'MICROPHONE',
});

const SourceState = Object.freeze({
  IDLE: 'IDLE',
  REQUESTING: 'REQUESTING',
  ACTIVE: 'ACTIVE',
  ERROR: 'ERROR',
});

// ─── Output Types ─────────────────────────────────────────────────────

const OutputType = Object.freeze({
  VIRTUAL_CAMERA: 'VIRTUAL_CAMERA',
  RTMP: 'RTMP',
  RECORDING: 'RECORDING',
});

const RecordingState = Object.freeze({
  IDLE: 'IDLE',
  RECORDING: 'RECORDING',
  PAUSED: 'PAUSED',
});

const StreamState = Object.freeze({
  IDLE: 'IDLE',
  CONNECTING: 'CONNECTING',
  STREAMING: 'STREAMING',
  RECONNECTING: 'RECONNECTING',
  ERROR: 'ERROR',
});

// ─── Scene ────────────────────────────────────────────────────────────

const DEFAULT_SCENE = {
  id: 'default',
  name: 'Scene 1',
  layers: [],  // Array of { sourceId, x, y, width, height, rotation, opacity, visible, locked }
  backgroundColor: '#000000',
  resolution: { width: 1920, height: 1080 },
};

// ─── Settings Defaults ────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  // Recording
  recording: {
    mimeType: 'video/webm;codecs=vp9',
    videoBitsPerSecond: 5_000_000,
    audioBitsPerSecond: 128_000,
    maxFramerate: 30,
  },

  // Streaming
  streaming: {
    codec: 'vp8',        // vp8, vp9, h264
    videoBitrate: 4_500_000,
    audioBitrate: 128_000,
    framerate: 30,
    keyframeInterval: 2, // seconds
  },

  // Saved stream destinations (provider, url, key) — no live state persisted
  destinations: [],

  // Virtual camera
  virtualCamera: {
    enabled: false,
    resolution: { width: 1280, height: 720 },
    framerate: 30,
  },

  // UI
  ui: {
    showPreviewFps: true,
    previewScale: 'fit',  // fit, fill, 100
    sourcePanelWidth: 260,
    rightPanelWidth: 280,
  },

  // Native host
  nativeHost: {
    name: 'com.alresia.streamcam.host',
    installCheckInterval: 5000,
  },
};

// ─── Compositor Defaults ──────────────────────────────────────────────

const COMPOSITOR_DEFAULTS = {
  width: 1920,
  height: 1080,
  framerate: 30,
  backgroundColor: '#000000',
};

// ─── Native Messaging Protocol ────────────────────────────────────────

const NativeMessageType = Object.freeze({
  // Extension → Host
  VIDEO_CHUNK: 0x01,
  AUDIO_CHUNK: 0x02,
  CONFIG: 0x10,
  START_STREAM: 0x20,
  STOP_STREAM: 0x21,
  START_VCAM: 0x30,
  STOP_VCAM: 0x31,
  PING: 0x40,

  // Host → Extension
  STATUS: 0x80,
  CONNECTED: 0x81,
  DISCONNECTED: 0x82,
  ERROR: 0xFF,
});

// ─── Event Names ──────────────────────────────────────────────────────

const Events = Object.freeze({
  // Source events
  SOURCE_ADDED: 'source:added',
  SOURCE_REMOVED: 'source:removed',
  SOURCE_STATE_CHANGED: 'source:stateChanged',
  SOURCE_TRACK_ENDED: 'source:trackEnded',

  // Scene events
  SCENE_CREATED: 'scene:created',
  SCENE_REMOVED: 'scene:removed',
  SCENE_SWITCHED: 'scene:switched',
  SCENE_UPDATED: 'scene:updated',

  // Compositor events
  COMPOSITOR_STARTED: 'compositor:started',
  COMPOSITOR_STOPPED: 'compositor:stopped',
  COMPOSITOR_FRAME: 'compositor:frame',

  // Recording events
  RECORDING_STARTED: 'recording:started',
  RECORDING_STOPPED: 'recording:stopped',
  RECORDING_PAUSED: 'recording:paused',
  RECORDING_DATA: 'recording:data',

  // Streaming events
  STREAM_CONNECTED: 'stream:connected',
  STREAM_DISCONNECTED: 'stream:disconnected',
  STREAM_ERROR: 'stream:error',

  // Virtual camera events
  VCAM_CHECKED: 'vcam:checked',
  VCAM_STARTED: 'vcam:started',
  VCAM_STOPPED: 'vcam:stopped',
  VCAM_ERROR: 'vcam:error',

  // UI events
  UI_PREVIEW_RESIZE: 'ui:previewResize',
  UI_SETTING_CHANGED: 'ui:settingChanged',
});
