/**
 * Alresia StreamCam — Service Worker (Manifest V3)
 *
 * Responsibilities:
 *  - Message router between popup, studio, and native host
 *  - Tab/screen capture permission orchestration
 *  - Settings + scene storage
 *  - Native messaging host management
 *  - Recording state coordination
 */

importScripts(
  '../types/constants.js',
  '../utils/logger.js',
  '../utils/event-bus.js',
  '../storage/settings.js'
);

const log = bgLog;

// ─── Active Ports ─────────────────────────────────────────────────────

/** Map of studio page ports: tabId → port */
const studioPorts = new Map();

/** Native messaging host port (persistent connection) */
let nativeHostPort = null;

// ─── Storage Helpers ──────────────────────────────────────────────────

function get(keys) {
  return chrome.storage.local.get(keys);
}

function set(obj) {
  return chrome.storage.local.set(obj);
}

// ─── Message Router ───────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    const reply = await handleMessage(message, sender);
    sendResponse(reply);
  })().catch((err) => {
    log.error('Message handler error:', err);
    sendResponse({ ok: false, error: String(err && err.message || err) });
  });
  return true; // async response
});

async function handleMessage(msg, sender) {
  switch (msg.type) {
    // ── Desktop Capture ─────────────────────────────────────────────
    case 'capture:desktop': {
      // Must be called from the studio page (has DOM access for picker)
      const port = getStudioPort(sender.tab?.id);
      if (port) {
        port.postMessage({ type: 'capture:desktop:request', sources: msg.sources });
        return { ok: true };
      }
      return { ok: false, error: 'Studio page not connected' };
    }

    // ── Camera List ─────────────────────────────────────────────────
    case 'capture:enumerate-cameras': {
      // Service worker can't enumerate devices — needs a page context
      const port = getStudioPort(sender.tab?.id);
      if (port) {
        port.postMessage({ type: 'capture:enumerate-cameras:request' });
        return { ok: true };
      }
      return { ok: false, error: 'Studio page not connected' };
    }

    // ── Settings ─────────────────────────────────────────────────────
    case 'settings:get': {
      const settings = await SettingsStorage.get(DEFAULT_SETTINGS);
      return { ok: true, settings };
    }

    case 'settings:set': {
      const next = await SettingsStorage.update(msg.key, msg.value, DEFAULT_SETTINGS);
      return { ok: true, settings: next };
    }

    // ── Scenes ───────────────────────────────────────────────────────
    case 'scenes:getAll': {
      const scenes = await SceneStorage.getScenes();
      const activeId = await SceneStorage.getActiveSceneId();
      return { ok: true, scenes, activeId };
    }

    case 'scenes:save': {
      await SceneStorage.saveScenes(msg.scenes);
      if (msg.activeId) await SceneStorage.setActiveSceneId(msg.activeId);
      return { ok: true };
    }

    case 'scenes:setActive': {
      await SceneStorage.setActiveSceneId(msg.id);
      return { ok: true };
    }

    // ── Native Host ──────────────────────────────────────────────────
    case 'native:connect': {
      return handleNativeConnect();
    }

    case 'native:disconnect': {
      return handleNativeDisconnect();
    }

    case 'native:sendMessage': {
      return handleNativeMessage(msg.data);
    }

    case 'native:status': {
      return {
        ok: true,
        connected: nativeHostPort !== null,
        hostId: DEFAULT_SETTINGS.nativeHost.name,
      };
    }

    // ── Stream Control ───────────────────────────────────────────────
    case 'stream:start': {
      return handleStreamStart(msg.config);
    }

    case 'stream:stop': {
      return handleStreamStop(msg.destinationId);
    }

    // ── Virtual Camera ──────────────────────────────────────────────
    case 'vcam:check': {
      if (!nativeHostPort) {
        const conn = await handleNativeConnect();
        if (!conn.ok) return conn;
      }
      try {
        nativeHostPort.postMessage({ type: 'CHECK_VCAM' });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err.message || err) };
      }
    }

    case 'vcam:start': {
      if (!nativeHostPort) {
        const conn = await handleNativeConnect();
        if (!conn.ok) return conn;
      }
      try {
        nativeHostPort.postMessage({ type: 'START_VCAM', config: msg.config });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err.message || err) };
      }
    }

    case 'vcam:stop': {
      if (!nativeHostPort) return { ok: true };
      try {
        nativeHostPort.postMessage({ type: 'STOP_VCAM' });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err.message || err) };
      }
    }

    case 'stream:sendFrame': {
      if (nativeHostPort) {
        try {
          nativeHostPort.postMessage({
            type: 'VIDEO_CHUNK',
            destinationId: msg.destinationId,
            data: msg.chunk.data,
            width: msg.chunk.width || null,
            height: msg.chunk.height || null,
          });
          return { ok: true };
        } catch (err) {
          return { ok: false, error: String(err.message || err) };
        }
      }
      return { ok: false, error: 'Native host not connected' };
    }

    // ── Page Navigation (used by the popup) ────────────────────────────
    case 'openPage': {
      await openOrFocusPage(msg.path, msg.query || '');
      return { ok: true };
    }

    default:
      return { ok: false, error: `Unknown message type: ${msg.type}` };
  }
}

// ─── Native Host Connection ───────────────────────────────────────────

function handleNativeConnect() {
  if (nativeHostPort) {
    return Promise.resolve({ ok: true, alreadyConnected: true });
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    try {
      const hostId = DEFAULT_SETTINGS.nativeHost.name;
      const port = chrome.runtime.connectNative(hostId);
      nativeHostPort = port;

      port.onMessage.addListener((msg) => {
        log.info('Native host message:', msg);
        for (const [, p] of studioPorts) {
          p.postMessage({ type: 'native:hostMessage', data: msg });
        }
        // A PONG (or any STATUS) confirms the host process is genuinely alive
        if (msg.type === 'STATUS' && msg.status === 'PONG') {
          finish({ ok: true });
        }
      });

      port.onDisconnect.addListener(() => {
        const err = chrome.runtime.lastError;
        const errMsg = err?.message || '';
        log.warn('Native host disconnected:', errMsg);
        nativeHostPort = null;
        for (const [, p] of studioPorts) {
          p.postMessage({ type: 'native:hostDisconnected', error: errMsg });
        }

        // Detect "host not found" specifically — this means the native
        // messaging manifest isn't registered with Chrome yet.
        const isNotFound = /not found|not installed|not registered/i.test(errMsg);
        if (isNotFound) {
          // Auto-open the setup page so the user can install the host
          openOrFocusPage('src/setup/setup.html');
          finish({
            ok: false,
            setupRequired: true,
            error: 'Native host is not installed. Opening setup page…',
          });
        } else {
          finish({
            ok: false,
            error: errMsg || 'Native host disconnected unexpectedly.',
          });
        }
      });

      // Confirm the host is actually alive with a PING; older host builds
      // that don't answer PING shouldn't be treated as broken, so fall
      // back to "connected" after a short grace period if nothing failed.
      port.postMessage({ type: 'PING' });
      setTimeout(() => finish({ ok: true, unconfirmed: true }), 1500);
    } catch (err) {
      log.error('Failed to connect to native host:', err);
      nativeHostPort = null;

      // If connectNative itself throws, it's definitely not installed
      const errMsg = String(err.message || err);
      if (/not found|not installed|not registered|specified/i.test(errMsg)) {
        openOrFocusPage('src/setup/setup.html');
        finish({
          ok: false,
          setupRequired: true,
          error: 'Native host is not installed. Opening setup page…',
        });
      } else {
        finish({ ok: false, error: errMsg });
      }
    }
  });
}

function handleNativeDisconnect() {
  if (nativeHostPort) {
    try {
      nativeHostPort.disconnect();
    } catch { /* ignore */ }
    nativeHostPort = null;
  }
  return { ok: true };
}

function handleNativeMessage(data) {
  if (!nativeHostPort) {
    return { ok: false, error: 'Native host not connected' };
  }
  try {
    nativeHostPort.postMessage(data);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

// ─── Stream Control ───────────────────────────────────────────────────

async function handleStreamStart(config) {
  if (!nativeHostPort) {
    const conn = await handleNativeConnect();
    if (!conn.ok) return conn;
  }

  try {
    nativeHostPort.postMessage({
      type: 'START_STREAM',
      config: {
        destinationId: config.destinationId,
        url: config.url,
        streamKey: config.streamKey,
        width: config.width || 480,
        height: config.height || 270,
        fps: config.fps || 6,
        videoBitrate: config.videoBitrate || 2_000_000,
        audioBitrate: config.audioBitrate || 128_000,
        codec: config.codec || 'vp8',
        keyframeInterval: config.keyframeInterval || 2,
      },
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

async function handleStreamStop(destinationId) {
  if (!nativeHostPort) return { ok: true };
  try {
    nativeHostPort.postMessage({ type: 'STOP_STREAM', destinationId });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

// ─── Port Management ──────────────────────────────────────────────────

function getStudioPort(tabId) {
  if (tabId) return studioPorts.get(tabId);
  // Return any available port
  for (const [, port] of studioPorts) return port;
  return null;
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'studio') {
    const tabId = port.sender?.tab?.id;
    if (tabId) {
      studioPorts.set(tabId, port);
      log.info('Studio page connected, tab:', tabId);

      port.onDisconnect.addListener(() => {
        studioPorts.delete(tabId);
        log.info('Studio page disconnected, tab:', tabId);
      });
    }
  }
});

// ─── Lifecycle ────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
  // Initialize default settings if first install
  const { streamcam_settings } = await get('streamcam_settings');
  if (!streamcam_settings) {
    await set({ streamcam_settings: DEFAULT_SETTINGS });
    log.info('Default settings initialized');
  }

  // Initialize default scene if first install
  const { streamcam_scenes } = await get('streamcam_scenes');
  if (!streamcam_scenes || streamcam_scenes.length === 0) {
    await set({
      streamcam_scenes: [{ ...DEFAULT_SCENE }],
      streamcam_active_scene: 'default',
    });
    log.info('Default scene initialized');
  }

  if (details.reason === 'install') {
    log.info('Extension installed — opening studio');
    chrome.tabs.create({ url: chrome.runtime.getURL('src/studio.html') });
  }
});

chrome.runtime.onStartup.addListener(() => {
  log.info('Extension started');
});

// ─── Toolbar Click → Open Simple Mode (default when there's no popup) ──
// With default_popup set in the manifest, this listener won't normally
// fire (Chrome shows the popup instead) — kept as a harmless fallback.

chrome.action.onClicked.addListener(() => {
  openOrFocusPage('src/simple.html');
});

/**
 * Open an extension page in its own tab — never hijacks whatever tab the
 * person was on. If that exact page is already open, just focus it
 * instead of spawning duplicates. `query` is appended as a query string
 * so deep links (e.g. auto-selecting a source) keep working even when
 * we focus an existing tab rather than creating a new one — in that
 * case we navigate the existing tab to the new query string.
 * @param {string} relativePath - e.g. 'src/simple.html'
 * @param {string} [query] - e.g. '?autoSource=camera'
 */
async function openOrFocusPage(relativePath, query = '') {
  const baseUrl = chrome.runtime.getURL(relativePath);
  const fullUrl = `${baseUrl}${query}`;
  const existing = await chrome.tabs.query({ url: `${baseUrl}*` });

  if (existing.length > 0) {
    const tab = existing[0];
    await chrome.tabs.update(tab.id, { active: true, url: fullUrl });
    if (tab.windowId != null) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    return;
  }

  await chrome.tabs.create({ url: fullUrl });
}

log.info('Service worker loaded');
