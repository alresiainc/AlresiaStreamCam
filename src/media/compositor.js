/**
 * Alresia StreamCam — Compositor
 * Renders multiple VideoSource tracks onto a Canvas, producing a single
 * combined MediaStream output via captureStream().
 */

class Compositor {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} options
   * @param {number} options.width - Output width (default 1920)
   * @param {number} options.height - Output height (default 1080)
   * @param {number} options.framerate - Target FPS (default 30)
   * @param {string} options.backgroundColor - Background color (default '#000000')
   */
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    this.width = options.width || COMPOSITOR_DEFAULTS.width;
    this.height = options.height || COMPOSITOR_DEFAULTS.height;
    this.framerate = options.framerate || COMPOSITOR_DEFAULTS.framerate;
    this.backgroundColor = options.backgroundColor || COMPOSITOR_DEFAULTS.backgroundColor;

    // Set canvas size
    this.canvas.width = this.width;
    this.canvas.height = this.height;

    /** @type {Array<CompositorLayer>} */
    this.layers = [];

    /** The output MediaStream from canvas.captureStream() */
    this.outputStream = null;
    this._running = false;
    this._rafId = null;
    this._frameCount = 0;
    this._lastFpsTime = performance.now();
    this.currentFps = 0;
  }

  /**
   * Add a source layer to the composition.
   * @param {VideoSource} source
   * @param {object} layout - { x, y, width, height, rotation, opacity, visible, flipX, flipY }
   */
  addLayer(source, layout = {}) {
    // Don't add duplicates
    if (this.layers.find((l) => l.sourceId === source.id)) return;

    const videoEl = source.getVideoElement();
    if (!videoEl) {
      console.warn('[Compositor] Source has no stream:', source.id);
      return;
    }

    const layer = {
      sourceId: source.id,
      source,
      video: videoEl,
      x: layout.x ?? 0,
      y: layout.y ?? 0,
      width: layout.width ?? this.width,
      height: layout.height ?? this.height,
      rotation: layout.rotation ?? 0,
      opacity: layout.opacity ?? 1,
      visible: layout.visible ?? true,
      flipX: layout.flipX ?? false,
      flipY: layout.flipY ?? false,
      locked: layout.locked ?? false,
      blendMode: layout.blendMode || 'source-over',
    };

    this.layers.push(layer);
    return layer;
  }

  /**
   * Update a layer's layout properties.
   * @param {string} sourceId
   * @param {object} props - Partial layout properties
   */
  updateLayer(sourceId, props) {
    const layer = this.layers.find((l) => l.sourceId === sourceId);
    if (!layer) return null;
    Object.assign(layer, props);
    return layer;
  }

  /**
   * Remove a layer by source ID.
   * @param {string} sourceId
   */
  removeLayer(sourceId) {
    const idx = this.layers.findIndex((l) => l.sourceId === sourceId);
    if (idx === -1) return;
    this.layers.splice(idx, 1);
  }

  /** Remove all layers. */
  clearLayers() {
    this.layers.length = 0;
  }

  /**
   * Get the output MediaStream.
   * Starts the captureStream() and rendering loop.
   */
  getOutputStream() {
    if (!this.outputStream) {
      this.outputStream = this.canvas.captureStream(this.framerate);
    }
    return this.outputStream;
  }

  /**
   * Start the rendering loop.
   * Composites all visible layers onto the canvas each frame.
   */
  start() {
    if (this._running) return;
    this._running = true;
    this._lastFpsTime = performance.now();
    this._frameCount = 0;
    this._renderLoop();
    bus.emit(Events.COMPOSITOR_STARTED);
  }

  /** Stop the rendering loop. */
  stop() {
    this._running = false;
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    bus.emit(Events.COMPOSITOR_STOPPED);
  }

  /** The main render loop. */
  _renderLoop() {
    if (!this._running) return;
    this._renderFrame();
    this._rafId = requestAnimationFrame(() => this._renderLoop());
  }

  /** Render a single frame. */
  _renderFrame() {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;

    // Clear with background
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = this.backgroundColor;
    ctx.fillRect(0, 0, w, h);

    // Draw each visible layer
    for (const layer of this.layers) {
      if (!layer.visible) continue;
      if (layer.video.readyState < 2) continue; // HAVE_CURRENT_DATA

      ctx.save();
      ctx.globalAlpha = layer.opacity;
      ctx.globalCompositeOperation = layer.blendMode;

      // Position and size
      const cx = layer.x + layer.width / 2;
      const cy = layer.y + layer.height / 2;

      ctx.translate(cx, cy);

      // Rotation
      if (layer.rotation) {
        ctx.rotate((layer.rotation * Math.PI) / 180);
      }

      // Flip
      const scaleX = layer.flipX ? -1 : 1;
      const scaleY = layer.flipY ? -1 : 1;
      ctx.scale(scaleX, scaleY);

      // Draw the video frame
      try {
        ctx.drawImage(
          layer.video,
          -layer.width / 2,
          -layer.height / 2,
          layer.width,
          layer.height
        );
      } catch (err) {
        // Video might not be ready yet — skip this frame
      }

      ctx.restore();
    }

    // FPS counter
    this._frameCount++;
    const now = performance.now();
    if (now - this._lastFpsTime >= 1000) {
      this.currentFps = this._frameCount;
      this._frameCount = 0;
      this._lastFpsTime = now;
    }
  }

  /**
   * Resize the output canvas.
   * @param {number} width
   * @param {number} height
   */
  resize(width, height) {
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
  }

  /**
   * Set the background color.
   * @param {string} color - CSS color string
   */
  setBackgroundColor(color) {
    this.backgroundColor = color;
  }

  /**
   * Render a single frame and return it as an ImageBitmap.
   * Useful for thumbnails/previews.
   */
  async renderSnapshot() {
    this._renderFrame();
    return createImageBitmap(this.canvas);
  }

  /**
   * Render a single frame to a blob.
   * @param {string} type - MIME type (default 'image/png')
   * @param {number} quality - JPEG quality (0-1)
   * @returns {Promise<Blob>}
   */
  async renderBlob(type = 'image/png', quality = 0.92) {
    this._renderFrame();
    return new Promise((resolve) => {
      this.canvas.toBlob(resolve, type, quality);
    });
  }

  /** Clean up resources. */
  destroy() {
    this.stop();
    this.clearLayers();
    this.outputStream = null;
  }
}

/**
 * @typedef {Object} CompositorLayer
 * @property {string} sourceId
 * @property {VideoSource} source
 * @property {HTMLVideoElement} video
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
