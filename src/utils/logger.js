/**
 * Alresia StreamCam — Logger
 * Structured logging with levels, prefixes, and optional console output.
 */

const LogLevel = Object.freeze({
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  SILENT: 4,
});

class Logger {
  constructor(prefix = 'StreamCam', level = LogLevel.INFO) {
    this.prefix = prefix;
    this.level = level;
  }

  setLevel(level) {
    this.level = level;
  }

  _log(level, levelName, args) {
    if (level < this.level) return;
    const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
    const tag = `[${ts}] [${levelName}] [${this.prefix}]`;
    const method = level >= LogLevel.WARN ? 'warn' : level >= LogLevel.ERROR ? 'error' : 'log';
    console[method](tag, ...args);
  }

  debug(...args) { this._log(LogLevel.DEBUG, 'DBG', args); }
  info(...args)  { this._log(LogLevel.INFO, 'INF', args); }
  warn(...args)  { this._log(LogLevel.WARN, 'WRN', args); }
  error(...args) { this._log(LogLevel.ERROR, 'ERR', args); }

  /** Create a child logger with an additional prefix segment. */
  child(subPrefix) {
    const child = new Logger(`${this.prefix}:${subPrefix}`, this.level);
    return child;
  }
}

// Singleton for the background service worker
const bgLog = new Logger('StreamCam:BG', LogLevel.INFO);
