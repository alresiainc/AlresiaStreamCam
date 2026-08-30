/**
 * Alresia StreamCam — Platform detection
 * Detects OS and browser capabilities.
 */

const Platform = (() => {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';

  const isWindows = /Windows/i.test(ua);
  const isMac = /Mac OS X/i.test(ua);
  const isLinux = /Linux/i.test(ua) && !isAndroid;

  const isChrome = /Chrome/i.test(ua) && !/Edg/i.test(ua);
  const isEdge = /Edg/i.test(ua);
  const isBrave = /Brave/i.test(ua);

  const isAndroid = /Android/i.test(ua);
  const isIOS = /iPad|iPhone|iPod/i.test(ua);

  /** Extract Chrome major version number (e.g. 117). */
  function chromeVersion() {
    const m = ua.match(/Chrome\/(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  }

  /** Check if WebCodecs is available. */
  function hasWebCodecs() {
    return typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined';
  }

  /** Check if OffscreenCanvas is available. */
  function hasOffscreenCanvas() {
    return typeof OffscreenCanvas !== 'undefined';
  }

  /** Check if requestVideoFrameCallback is available. */
  function hasRVFRC() {
    return typeof HTMLVideoElement !== 'undefined' &&
      'requestVideoFrameCallback' in HTMLVideoElement.prototype;
  }

  /** Get the OS name for native host selection. */
  function osName() {
    if (isWindows) return 'win32';
    if (isMac) return 'darwin';
    if (isLinux) return 'linux';
    return 'unknown';
  }

  /** Human-readable OS name. */
  function osLabel() {
    if (isWindows) return 'Windows';
    if (isMac) return 'macOS';
    if (isLinux) return 'Linux';
    return 'Unknown';
  }

  return Object.freeze({
    isWindows,
    isMac,
    isLinux,
    isChrome,
    isEdge,
    isBrave,
    isAndroid,
    isIOS,
    chromeVersion,
    hasWebCodecs,
    hasOffscreenCanvas,
    hasRVFRC,
    osName,
    osLabel,
  });
})();
