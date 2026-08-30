#!/usr/bin/env node

/**
 * Alresia StreamCam — Native Messaging Host
 *
 * Receives encoded video/audio chunks from the Chrome extension
 * via native messaging and pipes them to FFmpeg for RTMP output.
 * Also handles cross-platform virtual camera setup:
 *   - Linux: auto-installs v4l2loopback kernel module
 *   - macOS/Windows: compiles native plugin from C source
 *
 * Protocol:
 *   Extension → Host: JSON messages with base64-encoded binary data
 *   Host → Extension: JSON status messages
 *
 * Usage:
 *   The Chrome extension connects via chrome.runtime.connectNative()
 *   This script reads JSON messages from stdin and writes to stdout.
 */

'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const vcamSetup = require('./vcam-setup');

// ─── Configuration ────────────────────────────────────────────────

const MSG_MAX_SIZE = 6 * 1024 * 1024; // 6MB — leaves headroom for virtual-cam frames, which run a bit larger than the RTMP relay's

// ─── State ────────────────────────────────────────────────────────

/** Map of destinationId → { process, config } — one FFmpeg process per live destination */
const streams = new Map();
let inputBuffer = Buffer.alloc(0);
let messageLength = -1;

// ─── Logging ──────────────────────────────────────────────────────

function log(msg) {
  process.stderr.write(`[StreamCam-Host] ${msg}\n`);
}

// ─── Message Reading ──────────────────────────────────────────────

// Native messaging protocol: 4-byte little-endian length prefix + JSON payload
process.stdin.on('data', (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);

  while (true) {
    // If we don't have the length yet, read 4 bytes
    if (messageLength === -1) {
      if (inputBuffer.length < 4) return; // wait for more data
      messageLength = inputBuffer.readUInt32LE(0);
      inputBuffer = inputBuffer.slice(4);

      if (messageLength > MSG_MAX_SIZE) {
        log(`Message too large: ${messageLength} bytes`);
        messageLength = -1;
        continue;
      }
    }

    // Check if we have the full message
    if (inputBuffer.length < messageLength) return; // wait for more data

    // Extract and parse the message
    const msgStr = inputBuffer.slice(0, messageLength).toString('utf8');
    inputBuffer = inputBuffer.slice(messageLength);
    messageLength = -1;

    try {
      const msg = JSON.parse(msgStr);
      handleMessage(msg);
    } catch (err) {
      log(`Failed to parse message: ${err.message}`);
    }
  }
});

// ─── Message Handler ──────────────────────────────────────────────

function handleMessage(msg) {
  switch (msg.type) {
    case 'START_STREAM':
      startStream(msg.config);
      break;

    case 'STOP_STREAM':
      stopStream(msg.destinationId);
      break;

    case 'VIDEO_CHUNK':
      handleVideoChunk(msg);
      break;

    case 'AUDIO_CHUNK':
      handleAudioChunk(msg);
      break;

    case 'CHECK_VCAM':
      checkVirtualCam();
      break;

    case 'START_VCAM':
      startVirtualCam(msg.config);
      break;

    case 'STOP_VCAM':
      stopStream('vcam');
      break;

    case 'SETUP_VCAM':
      setupVcamAuto();
      break;

    case 'PING':
      sendStatus(null, 'PONG');
      break;

    default:
      log(`Unknown message type: ${msg.type}`);
  }
}

// ─── Stream Management ────────────────────────────────────────────
// Each destination gets its own FFmpeg process, keyed by destinationId,
// so multiple RTMP destinations can run at the same time.

function startStream(config) {
  const id = config && config.destinationId;
  if (!id) {
    log('START_STREAM missing destinationId — ignoring');
    return;
  }

  if (streams.has(id)) {
    log(`[${id}] Already streaming — restarting`);
    stopStream(id);
  }

  const { url, streamKey, width, height, fps, videoBitrate, codec, keyframeInterval } = config;
  const rtmpUrl = streamKey ? `${url}/${streamKey}` : url;

  const args = [
    // Input: read raw video from pipe
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
    '-s', `${width}x${height}`,
    '-r', String(fps),
    '-i', 'pipe:0',

    // Video encoding
    '-c:v', getCodec(codec),
    '-preset', 'ultrafast',
    '-b:v', String(videoBitrate || 2_000_000),
    '-g', String((fps || 6) * (keyframeInterval || 2)),
    '-pix_fmt', 'yuv420p',

    // Output: RTMP
    '-f', 'flv',
    rtmpUrl,
  ];

  log(`[${id}] Starting FFmpeg: ffmpeg ${args.join(' ')}`);

  try {
    const proc = spawn('ffmpeg', args, {
      stdio: ['pipe', 'ignore', 'pipe'],
    });

    streams.set(id, { process: proc, config });

    proc.on('error', (err) => {
      const friendly = err.code === 'ENOENT'
        ? 'ffmpeg is not installed or not on PATH. Install it (brew install ffmpeg / apt install ffmpeg / winget install ffmpeg) and restart Chrome.'
        : `FFmpeg error: ${err.message}`;
      log(`[${id}] ${friendly}`);
      sendStatus(id, 'ERROR', friendly);
      streams.delete(id);
    });

    proc.on('close', (code) => {
      log(`[${id}] FFmpeg exited with code ${code}`);
      const wasTracked = streams.delete(id);
      if (!wasTracked) return; // already stopped intentionally
      if (code !== 0 && code !== null) {
        sendStatus(id, 'ERROR', `FFmpeg exited with code ${code}`);
      } else {
        sendStatus(id, 'DISCONNECTED');
      }
    });

    // Capture FFmpeg stderr for logging
    let stderrBuf = '';
    proc.stderr.on('data', (data) => {
      stderrBuf += data.toString();
      // Log periodic status lines
      if (stderrBuf.includes('frame=') || stderrBuf.includes('error')) {
        const lines = stderrBuf.split('\n').filter((l) => l.trim());
        const lastLine = lines[lines.length - 1] || '';
        if (lastLine.length < 200) {
          log(`[${id}] FFmpeg: ${lastLine}`);
        }
        stderrBuf = '';
      }
    });

    sendStatus(id, 'CONNECTED');
    log(`[${id}] Stream started`);
  } catch (err) {
    log(`[${id}] Failed to start FFmpeg: ${err.message}`);
    sendStatus(id, 'ERROR', `Failed to start FFmpeg: ${err.message}`);
  }
}

function stopStream(id) {
  if (!id) {
    // No id — stop everything (used on shutdown)
    for (const key of Array.from(streams.keys())) stopStream(key);
    return;
  }

  const entry = streams.get(id);
  if (entry) {
    log(`[${id}] Stopping FFmpeg...`);
    streams.delete(id); // delete first so the 'close' handler treats this as intentional
    try {
      entry.process.stdin.end();
      entry.process.kill('SIGTERM');
    } catch { /* ignore */ }
  }
  sendStatus(id, 'DISCONNECTED');
  log(`[${id}] Stream stopped`);
}

function handleVideoChunk(msg) {
  // Route to virtual camera on macOS/Windows (not through FFmpeg)
  if (msg.destinationId === 'vcam' && vcamSocket) {
    try {
      const data = Buffer.from(msg.data, 'base64');
      // Extract width/height from the message config if available
      const w = (msg.width || 960);
      const h = (msg.height || 540);
      sendFrameToVcamNative(data, w, h);
    } catch (err) {
      log(`[vcam] Failed to send frame to native binary: ${err.message}`);
    }
    return;
  }

  // Linux vcam or RTMP streaming — route to FFmpeg
  const entry = streams.get(msg.destinationId);
  if (!entry) return;

  try {
    const data = Buffer.from(msg.data, 'base64');
    entry.process.stdin.write(data);
  } catch (err) {
    log(`[${msg.destinationId}] Failed to write video chunk: ${err.message}`);
  }
}

function getCodec(codec) {
  switch (codec) {
    case 'h264': return 'libx264';
    case 'vp9': return 'libvpx-vp9';
    case 'vp8':
    default: return 'libvpx';
  }
}

// ─── Virtual Camera (Cross-Platform) ──────────────────────────────
// Our own virtual camera — no OBS dependency.
//
// Linux:   v4l2loopback kernel module (auto-installed), FFmpeg writes to /dev/videoN
// macOS:   Compiled CoreMediaIO DAL plugin, receives frames via Unix socket
// Windows: Compiled DirectShow source filter, receives frames via named pipe
//
// On macOS/Windows, the compiled binary runs as a background process and
// receives raw RGBA frames from this host over a socket/pipe. The binary
// registers as a system-wide virtual camera that all video apps can see.

const net = require('net'); // for Unix socket on macOS
let vcamAutoSetupDone = false;
let vcamNativeProcess = null;  // child process running our compiled binary
let vcamSocket = null;         // socket connection to the binary (macOS/Windows)
let vcamFrameHeader = null;    // reusable frame header buffer

/**
 * Auto-setup virtual camera. Called on first CHECK_VCAM or START_VCAM.
 * On Linux: installs v4l2loopback + loads kernel module.
 * On macOS/Windows: compiles our native plugin from source.
 */
function setupVcamAuto() {
  if (vcamAutoSetupDone) return;

  const platform = vcamSetup.detectPlatform();
  log(`[vcam] Auto-setup for platform: ${platform}`);

  const result = vcamSetup.autoSetup();
  vcamAutoSetupDone = true;

  sendMessage({
    type: 'VCAM_SETUP_RESULT',
    platform: result.platform,
    status: result.status,
    device: result.device || null,
    method: result.method || null,
    reason: result.reason || null,
    command: result.command || null,
    manual: result.manual || null,
  });

  log(`[vcam] Auto-setup result: ${result.status}`);
}

/**
 * Check virtual camera availability (auto-triggers setup on first call).
 */
function checkVirtualCam() {
  const platform = vcamSetup.detectPlatform();

  if (platform === 'unsupported') {
    sendMessage({
      type: 'VCAM_STATUS',
      supported: false,
      reason: `Virtual camera is not supported on ${process.platform}.`,
    });
    return;
  }

  // Linux: check v4l2loopback
  if (platform === 'linux') {
    if (!vcamAutoSetupDone) {
      const result = vcamSetup.autoSetup();
      vcamAutoSetupDone = true;
    }
    const device = vcamSetup.findV4l2LoopbackDevice();
    if (device) {
      sendMessage({ type: 'VCAM_STATUS', supported: true, device, platform: 'linux', method: 'v4l2loopback' });
    } else {
      sendMessage({
        type: 'VCAM_STATUS', supported: false, platform: 'linux',
        reason: 'No v4l2loopback device found. Auto-setup may need sudo.',
      });
    }
    return;
  }

  // macOS/Windows: compile from source if needed, then report readiness
  const result = platform === 'macos' ? vcamSetup.setupMacOS() : vcamSetup.setupWindows();

  if (result.status === 'ready') {
    sendMessage({
      type: 'VCAM_STATUS', supported: true, platform,
      method: result.method,
      device: result.device || 'StreamCam Virtual Camera',
    });
  } else {
    sendMessage({
      type: 'VCAM_STATUS', supported: false, platform,
      reason: result.reason,
      command: result.command || null,
      manual: result.manual || null,
    });
  }
}

/**
 * Find a v4l2loopback device on Linux.
 */
function findV4l2LoopbackDevice() {
  return vcamSetup.findV4l2LoopbackDevice();
}

// ─── Native Binary Management (macOS/Windows) ────────────────────

/**
 * Start the native virtual camera binary on macOS/Windows.
 * The binary creates a virtual camera device and listens for frames
 * on a Unix socket (macOS) or named pipe (Windows).
 */
function startVcamNativeBinary(platform) {
  if (vcamNativeProcess) {
    log('[vcam] Native binary already running');
    return true;
  }

  // On macOS, the plugin is a .plugin bundle — we load it via DynamicLoader
  // On Windows, the DLL is registered as a DirectShow filter
  // Both listen for frames on a socket/pipe

  const socketPath = vcamSetup.getSocketPath();
  if (!socketPath) {
    log('[vcam] No socket path for this platform');
    return false;
  }

  log(`[vcam] Starting native binary for ${platform}, socket: ${socketPath}`);

  // For macOS, we spawn a helper that loads the plugin and listens
  // For Windows, the DLL is already registered — we just connect to the pipe
  if (platform === 'macos') {
    // The macOS plugin is loaded by the system when an app queries cameras.
    // We just need to connect to its socket and send frames.
    // But the plugin only starts its socket listener when loaded.
    // So we spawn a tiny helper that dlopen()s the plugin to keep it alive.
    const pluginPath = vcamSetup.getBinaryPath();
    if (!pluginPath) {
      log('[vcam] Plugin not compiled yet');
      return false;
    }

    // Write a tiny loader script
    const loaderScript = `#!/bin/bash
# Keep the plugin loaded so its socket listener runs
dlopen_result=$(python3 -c "import ctypes; ctypes.CDLL('${pluginPath}')" 2>&1)
if [ $? -ne 0 ]; then
  echo "Failed to load plugin: $dlopen_result" >&2
  exit 1
fi
# Keep the process alive
while true; do sleep 60; done
`;
    const loaderPath = path.join(__dirname, 'platform', 'macos', 'loader.sh');
    fs.writeFileSync(loaderPath, loaderScript);
    fs.chmodSync(loaderPath, 0o755);

    try {
      vcamNativeProcess = spawn('bash', [loaderPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });
      vcamNativeProcess.on('error', (err) => {
        log(`[vcam] Loader error: ${err.message}`);
        vcamNativeProcess = null;
      });
      vcamNativeProcess.on('close', () => {
        log('[vcam] Loader exited');
        vcamNativeProcess = null;
      });
      log('[vcam] macOS plugin loader started');
    } catch (err) {
      log(`[vcam] Failed to start loader: ${err.message}`);
      return false;
    }
  }

  return true;
}

/**
 * Connect to the native binary's socket/pipe for frame transport.
 */
function connectVcamSocket() {
  if (vcamSocket) return Promise.resolve(vcamSocket);

  const platform = vcamSetup.detectPlatform();
  const socketPath = vcamSetup.getSocketPath();

  if (!socketPath) return Promise.reject(new Error('No socket path')); 

  return new Promise((resolve, reject) => {
    if (platform === 'windows') {
      // Windows: connect to named pipe
      // Use net.createConnection with the pipe path
      const sock = net.createConnection(socketPath, () => {
        vcamSocket = sock;
        log('[vcam] Connected to named pipe');
        resolve(sock);
      });
      sock.on('error', (err) => {
        log(`[vcam] Pipe connection error: ${err.message}`);
        vcamSocket = null;
        reject(err);
      });
    } else {
      // macOS/Linux: connect to Unix socket
      const sock = net.createConnection(socketPath, () => {
        vcamSocket = sock;
        log('[vcam] Connected to Unix socket');
        resolve(sock);
      });
      sock.on('error', (err) => {
        log(`[vcam] Socket connection error: ${err.message}`);
        vcamSocket = null;
        reject(err);
      });
    }
  });
}

/**
 * Send a raw RGBA frame to the native binary via socket/pipe.
 * Frame format: [width:4][height:4][pixel_format:4][data_size:4][data:N]
 * All integers are little-endian uint32.
 */
function sendFrameToVcamNative(data, width, height) {
  if (!vcamSocket) return false;

  const header = Buffer.alloc(16);
  header.writeUInt32LE(width, 0);
  header.writeUInt32LE(height, 4);
  header.writeUInt32LE(0x41524742, 8); // 'RGBA' in little-endian
  header.writeUInt32LE(data.length, 12);

  try {
    vcamSocket.write(header);
    vcamSocket.write(data);
    return true;
  } catch (err) {
    log(`[vcam] Frame send error: ${err.message}`);
    vcamSocket = null;
    return false;
  }
}

/**
 * Start virtual camera output.
 * On Linux: writes raw frames to v4l2loopback device via FFmpeg.
 * On macOS/Windows: sends frames to our compiled native plugin via socket.
 */
function startVirtualCam(config) {
  const platform = vcamSetup.detectPlatform();

  if (platform === 'linux') {
    startVcamLinux(config);
  } else if (platform === 'macos' || platform === 'windows') {
    startVcamNative(config, platform);
  } else {
    sendStatus('vcam', 'ERROR', `Virtual camera is not supported on ${platform}.`);
  }
}

/**
 * Linux: write frames to v4l2loopback via FFmpeg.
 */
function startVcamLinux(config) {
  if (!vcamAutoSetupDone) {
    const setupResult = vcamSetup.autoSetup();
    vcamAutoSetupDone = true;
    if (setupResult.status !== 'ready') {
      sendStatus('vcam', 'ERROR', setupResult.reason || 'Virtual camera setup failed.');
      return;
    }
  }

  const device = findV4l2LoopbackDevice();
  if (!device) {
    sendStatus('vcam', 'ERROR', 'No v4l2loopback device found. Auto-setup may have failed.');
    return;
  }

  if (streams.has('vcam')) {
    log('[vcam] Already running — restarting');
    stopStream('vcam');
  }

  const { width, height, fps } = config;
  const args = [
    '-f', 'rawvideo', '-pix_fmt', 'rgba',
    '-s', `${width}x${height}`, '-r', String(fps),
    '-i', 'pipe:0',
    '-pix_fmt', 'yuv420p', '-f', 'v4l2', device,
  ];

  log(`[vcam] Starting FFmpeg: ffmpeg ${args.join(' ')}`);

  try {
    const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
    streams.set('vcam', { process: proc, config });

    proc.on('error', (err) => {
      const friendly = err.code === 'ENOENT'
        ? 'ffmpeg is not installed or not on PATH.'
        : `FFmpeg error: ${err.message}`;
      log(`[vcam] ${friendly}`);
      sendStatus('vcam', 'ERROR', friendly);
      streams.delete('vcam');
    });

    proc.on('close', (code) => {
      const wasTracked = streams.delete('vcam');
      if (!wasTracked) return;
      sendStatus('vcam', code !== 0 && code !== null ? 'ERROR' : 'DISCONNECTED',
        code !== 0 && code !== null ? `FFmpeg exited with code ${code}` : null);
    });

    let stderrBuf = '';
    proc.stderr.on('data', (data) => {
      stderrBuf += data.toString();
      if (stderrBuf.includes('frame=') || stderrBuf.includes('error')) {
        const lines = stderrBuf.split('\n').filter((l) => l.trim());
        const lastLine = lines[lines.length - 1] || '';
        if (lastLine.length < 200) log(`[vcam] FFmpeg: ${lastLine}`);
        stderrBuf = '';
      }
    });

    sendMessage({ type: 'STATUS', destinationId: 'vcam', status: 'CONNECTED', device });
    log(`[vcam] Started on ${device}`);
  } catch (err) {
    log(`[vcam] Failed to start FFmpeg: ${err.message}`);
    sendStatus('vcam', 'ERROR', `Failed to start FFmpeg: ${err.message}`);
  }
}

/**
 * macOS/Windows: start our compiled native plugin and connect via socket.
 */
function startVcamNative(config, platform) {
  // Auto-compile if needed
  if (!vcamAutoSetupDone) {
    const setupResult = vcamSetup.autoSetup();
    vcamAutoSetupDone = true;
    if (setupResult.status !== 'ready') {
      sendStatus('vcam', 'ERROR', setupResult.reason || 'Virtual camera setup failed.');
      return;
    }
  }

  // Start the native binary (if needed)
  startVcamNativeBinary(platform);

  // Connect to the socket/pipe
  connectVcamSocket().then(() => {
    sendMessage({
      type: 'STATUS', destinationId: 'vcam', status: 'CONNECTED',
      platform, method: vcamSetup.detectPlatform() === 'macos' ? 'coremediaio' : 'directshow',
      device: 'StreamCam Virtual Camera',
    });
    log(`[vcam] Started on ${platform} via native plugin`);
  }).catch((err) => {
    log(`[vcam] Failed to connect to native binary: ${err.message}`);
    sendStatus('vcam', 'ERROR', `Failed to connect to virtual camera: ${err.message}`);
  });
}

function handleAudioChunk(msg) {
  // Audio is not currently piped into FFmpeg — video-only streaming for now.
}

// ─── Communication with Extension ─────────────────────────────────

function sendMessage(msg) {
  const json = JSON.stringify(msg);
  const buf = Buffer.from(json, 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(buf.length, 0);
  process.stdout.write(header);
  process.stdout.write(buf);
}

function sendStatus(destinationId, status, error) {
  sendMessage({ type: 'STATUS', destinationId, status, error: error || null });
}

// ─── Cleanup ──────────────────────────────────────────────────────

process.on('SIGTERM', () => {
  log('Received SIGTERM');
  stopStream(null);
  process.exit(0);
});

process.on('SIGINT', () => {
  log('Received SIGINT');
  stopStream(null);
  process.exit(0);
});

process.on('disconnect', () => {
  log('Disconnected from extension');
  stopStream(null);
  process.exit(0);
});

log('Native host started');
log(`Node.js ${process.version}`);
log(`Platform: ${process.platform} (${vcamSetup.detectPlatform()})`);
log(`Working directory: ${process.cwd()}`);

// One-time startup check — surfaces the #1 cause of "streaming doesn't
// work" (ffmpeg missing) in the host's own log immediately, rather than
// waiting for the first START_STREAM to fail.
(function checkFfmpegOnStartup() {
  const { spawnSync } = require('child_process');
  const result = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  if (result.error || result.status !== 0) {
    log('WARNING: ffmpeg was not found on PATH. RTMP streaming will fail until it is installed.');
  } else {
    log('ffmpeg found on PATH — ready to stream.');
  }
})();
