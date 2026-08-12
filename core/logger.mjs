// core/logger.mjs — 中文日志（T-A10）：控制台+文件双写，格式 [时间] [级别] [模块] 消息
import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };

function pad(n) {
  return String(n).padStart(2, '0');
}

export function formatTs(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

export function fileStamp(now = new Date()) {
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

let singleton = null;

export function createLogger(taskName, opts = {}) {
  const { level = 'INFO', file = null } = opts;
  const threshold = LEVELS[level] ?? LEVELS.INFO;
  let logFile = null;
  if (file) {
    logFile = path.resolve(file);
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
  }
  const logger = {
    taskName,
    level,
    log(levelName, moduleName, msg) {
      if (LEVELS[levelName] < threshold) return;
      const line = `[${formatTs()}] [${levelName}] [${moduleName}] ${msg}`;
      console.log(line);
      if (logFile) fs.appendFileSync(logFile, line + '\n');
    },
    debug: (moduleName, msg) => logger.log('DEBUG', moduleName, msg),
    info: (moduleName, msg) => logger.log('INFO', moduleName, msg),
    warn: (moduleName, msg) => logger.log('WARN', moduleName, msg),
    error: (moduleName, msg) => logger.log('ERROR', moduleName, msg),
  };
  if (!singleton) singleton = logger;
  return logger;
}

export function getLogger() {
  if (!singleton) singleton = createLogger('default', { level: 'INFO' });
  return singleton;
}

export function setLogger(l) {
  singleton = l;
}

export function stepError(step, { selector, url, timeout } = {}) {
  const parts = [`步骤=${step}`];
  if (selector) parts.push(`选择器=${selector}`);
  if (url) parts.push(`URL=${url}`);
  if (timeout) parts.push(`超时=${timeout}ms`);
  return `${step}失败 [${parts.join(', ')}]`;
}
