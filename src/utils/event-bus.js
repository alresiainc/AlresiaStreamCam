/**
 * Alresia StreamCam — EventBus
 * Lightweight pub/sub for decoupled module communication.
 */

class EventBus {
  constructor() {
    this._listeners = new Map();
  }

  /**
   * Subscribe to an event.
   * @param {string} event
   * @param {Function} callback
   * @returns {Function} unsubscribe function
   */
  on(event, callback) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(callback);
    return () => this.off(event, callback);
  }

  /**
   * Subscribe once — auto-unsubscribes after first call.
   */
  once(event, callback) {
    const wrapper = (...args) => {
      this.off(event, wrapper);
      callback(...args);
    };
    return this.on(event, wrapper);
  }

  /**
   * Unsubscribe from an event.
   */
  off(event, callback) {
    const set = this._listeners.get(event);
    if (set) {
      set.delete(callback);
      if (set.size === 0) this._listeners.delete(event);
    }
  }

  /**
   * Emit an event with data.
   */
  emit(event, ...args) {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const cb of set) {
      try {
        cb(...args);
      } catch (err) {
        console.error(`[EventBus] Error in listener for "${event}":`, err);
      }
    }
  }

  /**
   * Remove all listeners (useful for cleanup).
   */
  clear() {
    this._listeners.clear();
  }

  /**
   * Return the number of listeners for an event (useful for debugging).
   */
  listenerCount(event) {
    return this._listeners.get(event)?.size || 0;
  }
}

// Shared singleton — import this everywhere
const bus = new EventBus();
