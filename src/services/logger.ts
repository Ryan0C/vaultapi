export type LogLevel = "debug" | "info" | "warn" | "error";

export type Logger = {
  level: LogLevel;
  debug: (msg: string, meta?: unknown) => void;
  info: (msg: string, meta?: unknown) => void;
  warn: (msg: string, meta?: unknown) => void;
  error: (msg: string, meta?: unknown) => void;
};

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

function format(level: LogLevel, msg: string, meta?: unknown) {
  const base = {
    ts: new Date().toISOString(),
    level,
    msg
  };

  return meta ? { ...base, meta } : base;
}

export function createLogger(level: LogLevel = "info"): Logger {
  function shouldLog(target: LogLevel) {
    return LEVEL_ORDER[target] >= LEVEL_ORDER[level];
  }

  return {
    level,
    debug(msg, meta) {
      if (shouldLog("debug")) console.debug(JSON.stringify(format("debug", msg, meta)));
    },
    info(msg, meta) {
      if (shouldLog("info")) console.info(JSON.stringify(format("info", msg, meta)));
    },
    warn(msg, meta) {
      if (shouldLog("warn")) console.warn(JSON.stringify(format("warn", msg, meta)));
    },
    error(msg, meta) {
      if (shouldLog("error")) console.error(JSON.stringify(format("error", msg, meta)));
    }
  };
}