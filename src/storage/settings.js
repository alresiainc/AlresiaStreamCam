/**
 * Alresia StreamCam — Settings Storage
 * Read/write extension settings to chrome.storage.local.
 */

const SettingsStorage = (() => {
  const STORAGE_KEY = 'streamcam_settings';

  /**
   * Deep merge two objects. Source values override target values.
   * Arrays are replaced, not merged.
   */
  function deepMerge(target, source) {
    const result = { ...target };
    for (const key of Object.keys(source)) {
      if (
        source[key] &&
        typeof source[key] === 'object' &&
        !Array.isArray(source[key]) &&
        target[key] &&
        typeof target[key] === 'object' &&
        !Array.isArray(target[key])
      ) {
        result[key] = deepMerge(target[key], source[key]);
      } else {
        result[key] = source[key];
      }
    }
    return result;
  }

  /** Load settings from storage, merging with defaults. */
  async function get(defaults) {
    return new Promise((resolve) => {
      chrome.storage.local.get(STORAGE_KEY, (data) => {
        const stored = data[STORAGE_KEY] || {};
        resolve(deepMerge(defaults, stored));
      });
    });
  }

  /** Save settings to storage (full overwrite). */
  async function set(settings) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [STORAGE_KEY]: settings }, resolve);
    });
  }

  /** Update a single top-level key. Merges if the value is an object. */
  async function update(key, value, defaults) {
    const current = await get(defaults);
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      current[key] &&
      typeof current[key] === 'object' &&
      !Array.isArray(current[key])
    ) {
      current[key] = deepMerge(current[key], value);
    } else {
      current[key] = value;
    }
    await set(current);
    return current;
  }

  return Object.freeze({ get, set, update });
})();

// ─── Scene Storage ────────────────────────────────────────────────────

const SceneStorage = (() => {
  const SCENES_KEY = 'streamcam_scenes';
  const ACTIVE_KEY = 'streamcam_active_scene';

  async function getScenes() {
    return new Promise((resolve) => {
      chrome.storage.local.get(SCENES_KEY, (data) => {
        resolve(data[SCENES_KEY] || []);
      });
    });
  }

  async function saveScenes(scenes) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [SCENES_KEY]: scenes }, resolve);
    });
  }

  async function getActiveSceneId() {
    return new Promise((resolve) => {
      chrome.storage.local.get(ACTIVE_KEY, (data) => {
        resolve(data[ACTIVE_KEY] || 'default');
      });
    });
  }

  async function setActiveSceneId(id) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [ACTIVE_KEY]: id }, resolve);
    });
  }

  return Object.freeze({ getScenes, saveScenes, getActiveSceneId, setActiveSceneId });
})();
