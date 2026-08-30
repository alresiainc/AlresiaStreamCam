/**
 * Alresia StreamCam — Scene Manager
 * Manages multiple scenes, each with its own source layout configuration.
 * Persisted to chrome.storage via SceneStorage.
 */

class SceneManager {
  constructor(sourceManager, compositor, audioMixer = null) {
    this.sourceManager = sourceManager;
    this.compositor = compositor;
    this.audioMixer = audioMixer;

    /** @type {Scene[]} */
    this.scenes = [];
    this.activeSceneId = null;
    this._nextSceneNum = 1;
  }

  /**
   * Initialize from storage.
   * @param {Scene[]} savedScenes
   * @param {string} activeId
   */
  init(savedScenes = [], activeId = 'default') {
    if (savedScenes.length === 0) {
      // Create default scene
      this.scenes = [{
        id: 'default',
        name: 'Scene 1',
        layers: [],
        backgroundColor: '#000000',
        resolution: { width: 1920, height: 1080 },
      }];
    } else {
      // Migrate old 'sources' key to 'layers' if needed
      this.scenes = savedScenes.map((s) => ({
        ...s,
        layers: s.layers || s.sources || [],
      }));
    }

    this._nextSceneNum = this.scenes.length + 1;
    this.switchTo(activeId || this.scenes[0].id);
  }

  /**
   * Get the active scene.
   * @returns {Scene|null}
   */
  getActive() {
    return this.scenes.find((s) => s.id === this.activeSceneId) || null;
  }

  /**
   * Switch to a scene by ID.
   * Rebuilds the compositor layers from the scene config.
   * @param {string} sceneId
   */
  switchTo(sceneId) {
    const scene = this.scenes.find((s) => s.id === sceneId);
    if (!scene) return false;

    this.activeSceneId = sceneId;

    // FULLY clear compositor — no leftover layers from previous scene
    this.compositor.clearLayers();
    this.compositor.outputStream = null; // reset captureStream so it rebuilds
    if (this.audioMixer) this.audioMixer.clear();

    // Rebuild layers ONLY from this scene's config
    for (const layerConfig of scene.layers) {
      const source = this.sourceManager.get(layerConfig.sourceId);
      if (source && source.state === SourceState.ACTIVE) {
        const isAudioOnly = source.type === VideoSourceType.MICROPHONE;

        if (!isAudioOnly) {
          this.compositor.addLayer(source, {
            x: layerConfig.x ?? 0,
            y: layerConfig.y ?? 0,
            width: layerConfig.width ?? this.compositor.width,
            height: layerConfig.height ?? this.compositor.height,
            rotation: layerConfig.rotation ?? 0,
            opacity: layerConfig.opacity ?? 1,
            visible: layerConfig.visible ?? true,
            flipX: layerConfig.flipX ?? false,
            flipY: layerConfig.flipY ?? false,
          });
        }

        if (this.audioMixer && source.stream && source.stream.getAudioTracks().length > 0) {
          this.audioMixer.addSource(source.id, source.stream, { muted: layerConfig.audioMuted ?? false });
        }
      }
    }

    // Enforce single-visible-source semantics: if more than one layer came
    // back visible (e.g. legacy/migrated data), keep only the first and
    // hide the rest so the preview isn't a silent full-frame stack.
    const visibleLayers = scene.layers.filter((l) => l.visible);
    if (visibleLayers.length > 1) {
      visibleLayers.slice(1).forEach((l) => {
        l.visible = false;
        this.compositor.updateLayer(l.sourceId, { visible: false });
      });
    }

    // Update compositor background and resolution for this scene
    this.compositor.setBackgroundColor(scene.backgroundColor || '#000000');
    if (scene.resolution) {
      this.compositor.resize(scene.resolution.width, scene.resolution.height);
    }

    bus.emit(Events.SCENE_SWITCHED, scene);
    return true;
  }

  /**
   * Create a new scene.
   * @param {string} [name]
   * @returns {Scene}
   */
  create(name) {
    const id = `scene_${Date.now()}`;
    const scene = {
      id,
      name: name || `Scene ${this._nextSceneNum++}`,
      layers: [],
      backgroundColor: '#000000',
      resolution: { width: 1920, height: 1080 },
    };
    this.scenes.push(scene);
    bus.emit(Events.SCENE_CREATED, scene);
    return scene;
  }

  /**
   * Remove a scene by ID. Cannot remove the last scene.
   * @param {string} sceneId
   * @returns {boolean}
   */
  remove(sceneId) {
    if (this.scenes.length <= 1) return false;
    const idx = this.scenes.findIndex((s) => s.id === sceneId);
    if (idx === -1) return false;

    const [removed] = this.scenes.splice(idx, 1);

    // If the removed scene was active, switch to the first available
    if (this.activeSceneId === sceneId) {
      this.switchTo(this.scenes[0].id);
    }

    bus.emit(Events.SCENE_REMOVED, removed);
    return true;
  }

  /**
   * Rename a scene.
   * @param {string} sceneId
   * @param {string} newName
   */
  rename(sceneId, newName) {
    const scene = this.scenes.find((s) => s.id === sceneId);
    if (!scene) return false;
    scene.name = newName;
    bus.emit(Events.SCENE_UPDATED, scene);
    this.save();
    return true;
  }

  /**
   * Update a scene's configuration (name, background color, resolution).
   * Applies live if this is the active scene.
   * @param {string} sceneId
   * @param {{name?: string, backgroundColor?: string, resolution?: {width:number,height:number}|null}} patch
   */
  updateConfig(sceneId, patch = {}) {
    const scene = this.scenes.find((s) => s.id === sceneId);
    if (!scene) return false;

    if (patch.name != null && patch.name.trim()) scene.name = patch.name.trim();
    if (patch.backgroundColor != null) scene.backgroundColor = patch.backgroundColor;
    if (patch.resolution !== undefined) scene.resolution = patch.resolution;

    if (scene.id === this.activeSceneId) {
      this.compositor.setBackgroundColor(scene.backgroundColor || '#000000');
      if (scene.resolution) {
        this.compositor.resize(scene.resolution.width, scene.resolution.height);
      }
    }

    bus.emit(Events.SCENE_UPDATED, scene);
    this.save();
    return true;
  }

  /**
   * Add a source to the active scene.
   * Creates a default layer layout.
   * @param {string} sourceId
   * @param {object} [layout] - Optional initial layout
   */
  addSourceToActive(sourceId, layout = {}) {
    const scene = this.getActive();
    if (!scene) return null;

    // Don't add duplicates to this scene
    if (scene.layers.find((l) => l.sourceId === sourceId)) return null;

    const source = this.sourceManager.get(sourceId);
    if (!source) return null;

    const isAudioOnly = source.type === VideoSourceType.MICROPHONE;

    // Default layout: fill the canvas for this scene
    const layerConfig = {
      sourceId,
      x: layout.x ?? 0,
      y: layout.y ?? 0,
      width: layout.width ?? (scene.resolution?.width || 1920),
      height: layout.height ?? (scene.resolution?.height || 1080),
      rotation: layout.rotation ?? 0,
      opacity: layout.opacity ?? 1,
      // Audio-only sources (microphones) have no video to show/hide —
      // "visible" is meaningless for them, so they never compete with
      // camera/screen/tab layers for on-air status.
      visible: isAudioOnly ? false : (layout.visible ?? true),
      flipX: layout.flipX ?? false,
      flipY: layout.flipY ?? false,
      locked: false,
      blendMode: layout.blendMode || 'source-over',
      audioMuted: layout.audioMuted ?? false,
    };

    scene.layers.push(layerConfig);

    // Add to compositor / audio mixer ONLY if this is the active scene
    if (scene.id === this.activeSceneId) {
      if (!isAudioOnly) {
        this.compositor.addLayer(source, layerConfig);
      }
      if (this.audioMixer && source.stream && source.stream.getAudioTracks().length > 0) {
        this.audioMixer.addSource(sourceId, source.stream, { muted: layerConfig.audioMuted });
      }
    }

    bus.emit(Events.SCENE_UPDATED, scene);
    this.save();

    // Newly patched-in VIDEO sources go exclusively on-air, like plugging
    // a fresh input into a switcher bus — it replaces whatever was
    // showing. Microphones don't participate in that exclusivity.
    if (!isAudioOnly) {
      this.showOnly(sourceId);
    }

    return layerConfig;
  }

  /**
   * Remove a source from the active scene.
   * @param {string} sourceId
   */
  removeSourceFromActive(sourceId) {
    const scene = this.getActive();
    if (!scene) return;

    scene.layers = scene.layers.filter((l) => l.sourceId !== sourceId);

    // Remove from compositor / audio mixer if it's in the active scene
    if (scene.id === this.activeSceneId) {
      this.compositor.removeLayer(sourceId);
      if (this.audioMixer) this.audioMixer.removeSource(sourceId);
    }

    bus.emit(Events.SCENE_UPDATED, scene);
    this.save();
  }

  /**
   * Update a layer in the active scene.
   * @param {string} sourceId
   * @param {object} props
   */
  updateLayerInActive(sourceId, props) {
    const scene = this.getActive();
    if (!scene) return;

    const layer = scene.layers.find((l) => l.sourceId === sourceId);
    if (!layer) return;

    Object.assign(layer, props);
    this.compositor.updateLayer(sourceId, props);

    bus.emit(Events.SCENE_UPDATED, scene);
  }

  /**
   * Make a single source in the active scene exclusively visible — like
   * switching a camera bus. Every other layer in the scene is hidden.
   * @param {string} sourceId
   */
  showOnly(sourceId) {
    const scene = this.getActive();
    if (!scene) return;

    let changed = false;
    for (const layer of scene.layers) {
      const layerSource = this.sourceManager.get(layer.sourceId);
      // Microphones have no video — they don't compete for on-air status.
      if (layerSource && layerSource.type === VideoSourceType.MICROPHONE) continue;

      const shouldBeVisible = layer.sourceId === sourceId;
      if (layer.visible !== shouldBeVisible) {
        layer.visible = shouldBeVisible;
        this.compositor.updateLayer(layer.sourceId, { visible: shouldBeVisible });
        changed = true;
      }
    }
    if (changed) {
      bus.emit(Events.SCENE_UPDATED, scene);
      this.save();
    }
  }

  /**
   * Hide a single source in the active scene without affecting the others.
   * @param {string} sourceId
   */
  hide(sourceId) {
    const scene = this.getActive();
    if (!scene) return;

    const layer = scene.layers.find((l) => l.sourceId === sourceId);
    if (!layer || !layer.visible) return;

    layer.visible = false;
    this.compositor.updateLayer(sourceId, { visible: false });
    bus.emit(Events.SCENE_UPDATED, scene);
    this.save();
  }

  /**
   * Mute or unmute a source's contribution to the audio mix, without
   * affecting its video visibility (if any).
   * @param {string} sourceId
   * @param {boolean} muted
   */
  setAudioMuted(sourceId, muted) {
    const scene = this.getActive();
    if (!scene) return;

    const layer = scene.layers.find((l) => l.sourceId === sourceId);
    if (!layer) return;

    layer.audioMuted = muted;
    if (this.audioMixer) this.audioMixer.setMuted(sourceId, muted);

    bus.emit(Events.SCENE_UPDATED, scene);
    this.save();
  }

  /**
   * Get all scenes.
   * @returns {Scene[]}
   */
  getAll() {
    return this.scenes;
  }

  /**
   * Save all scenes to storage.
   */
  async save() {
    await SceneStorage.saveScenes(this.scenes);
    await SceneStorage.setActiveSceneId(this.activeSceneId);
  }

  /**
   * When a source is removed, clean it from all scenes.
   * @param {string} sourceId
   */
  onSourceRemoved(sourceId) {
    for (const scene of this.scenes) {
      scene.layers = scene.layers.filter((l) => l.sourceId !== sourceId);
    }
    this.compositor.removeLayer(sourceId);
    if (this.audioMixer) this.audioMixer.removeSource(sourceId);
  }
}

/**
 * @typedef {Object} Scene
 * @property {string} id
 * @property {string} name
 * @property {SceneLayer[]} layers
 * @property {string} backgroundColor
 * @property {{width: number, height: number}} resolution
 */

/**
 * @typedef {Object} SceneLayer
 * @property {string} sourceId
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 * @property {number} rotation
 * @property {number} opacity
 * @property {boolean} visible
 * @property {boolean} flipX
 * @property {boolean} flipY
 * @property {boolean} locked
 * @property {string} blendMode
 */
