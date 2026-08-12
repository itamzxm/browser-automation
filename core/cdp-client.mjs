// core/cdp-client.mjs — CDP 客户端（T-A2）：WebSocket 连接、请求-响应 Promise 化、事件分发、超时/断线错误上下文
import { getLogger } from './logger.mjs';

let nextId = 1;

export class CdpClient {
  constructor() {
    this.ws = null;
    this.url = null;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
    this._opened = false;
    this.log = getLogger();
  }

  connect(wsUrl, { timeoutMs = 10000, autoAttach = true } = {}) {
    this.url = wsUrl;
    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WebSocket(wsUrl);
      } catch (e) {
        reject(new Error(`WebSocket 创建失败: ${wsUrl} (${e.message})`));
        return;
      }
      this.ws = ws;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch {}
        reject(new Error(`连接超时: ${wsUrl} (超时=${timeoutMs}ms)`));
      }, timeoutMs);

      ws.addEventListener('open', () => {
        if (settled) return;
        this._opened = true;
        this.closed = false;
        this.log.info('cdp', `已连接: ${wsUrl}`);
        if (!autoAttach) {
          settled = true;
          clearTimeout(timer);
          resolve(this);
          return;
        }
        this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, { step: '初始化', timeoutMs })
          .then(() => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(this);
          })
          .catch((e) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(e);
            this.close();
          });
      });
      ws.addEventListener('message', (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        this._dispatch(msg);
      });
      ws.addEventListener('error', () => {
        if (!this._opened && !settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`WebSocket 握手失败: ${wsUrl}（若浏览器由本模块启动仍失败，检查端口与调试参数）`));
        } else {
          this.log.debug('cdp', `WebSocket 连接错误: ${wsUrl}`);
        }
      });
      ws.addEventListener('close', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.closed = true;
        this.log.warn('cdp', '连接已断开');
        this._rejectAll(new Error(`连接已断开: ${wsUrl}`));
      });
    });
  }

  send(method, params = {}, { sessionId, timeoutMs = 30000, step = '' } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error(`CDP 发送失败 [步骤=${step || '-'}, 方法=${method}, 原因=连接未就绪]`));
        return;
      }
      const id = nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 调用超时 [步骤=${step || '-'}, 方法=${method}, 超时=${timeoutMs}ms]`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method, step });
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      this.ws.send(JSON.stringify(msg));
    });
  }

  _dispatch(msg) {
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        p.reject(new Error(`CDP 调用失败 [步骤=${p.step || '-'}, 方法=${p.method}, code=${msg.error.code}, message=${msg.error.message}]（若为 -32001/-32601，请检查 flatten/sessionId 与协议版本）`));
      } else {
        p.resolve(msg.result ?? {});
      }
      return;
    }
    if (msg.method) {
      const cbs = this.listeners.get(msg.method);
      if (cbs) {
        for (const cb of [...cbs]) {
          try {
            cb(msg);
          } catch (e) {
            this.log.error('cdp', `事件回调异常: ${msg.method} (${e.message})`);
          }
        }
      }
    }
  }

  on(method, cb) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(cb);
  }

  off(method, cb) {
    this.listeners.get(method)?.delete(cb);
  }

  close() {
    this.closed = true;
    this._rejectAll(new Error('连接已关闭'));
    try {
      this.ws?.close();
    } catch {}
    this.ws = null;
  }

  _rejectAll(err) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}
