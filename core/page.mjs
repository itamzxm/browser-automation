// core/page.mjs — 页面封装（T-A3~T-A9）：导航/查询/点击输入/等待/截图/JS 执行/委托多标签
import fs from 'node:fs';
import path from 'node:path';
import { getLogger, stepError } from './logger.mjs';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export class Page {
  constructor(browser, targetId, sessionId) {
    this.browser = browser;
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.url = '';
    this.title = '';
    this.log = getLogger();
    this._init = null;
    this._loadWaiters = [];
    this._navQueue = Promise.resolve();
  }

  client() {
    return this.browser.client;
  }

  init() {
    const step = '初始化';
    return Promise.all([
      this.client().send('Page.enable', {}, { sessionId: this.sessionId, step }),
      this.client().send('Runtime.enable', {}, { sessionId: this.sessionId, step }),
      this.client().send('Network.enable', {}, { sessionId: this.sessionId, step }),
    ]);
  }

  ready() {
    if (!this._init) this._init = this.init();
    return this._init;
  }

  _onEvent(m) {
    if (m.method === 'Page.loadEventFired') {
      const waiters = this._loadWaiters;
      this._loadWaiters = [];
      for (const w of waiters) {
        clearTimeout(w.timer);
        w.resolve();
      }
    } else if (m.method === 'Page.frameNavigated') {
      const frame = m.params.frame;
      if (frame && !frame.parentId && frame.url) this.url = frame.url;
    }
  }

  _waitLoad(timeoutMs, step) {
    return new Promise((resolve, reject) => {
      const w = {
        timer: setTimeout(() => {
          const i = this._loadWaiters.indexOf(w);
          if (i >= 0) this._loadWaiters.splice(i, 1);
          reject(new Error(`等待页面加载超时 [步骤=${step}, 超时=${timeoutMs}ms]`));
        }, timeoutMs),
        resolve,
      };
      this._loadWaiters.push(w);
    });
  }

  async goto(url, { timeoutMs } = {}) {
    const run = () => this._goto(url, timeoutMs);
    const result = this._navQueue.then(run, run);
    this._navQueue = result.then(() => {}, () => {});
    return result;
  }

  async _goto(url, timeoutMs) {
    const t = timeoutMs ?? this.browser.cfg.timeoutMs;
    await this.ready();
    const res = await this.client().send('Page.navigate', { url }, { sessionId: this.sessionId, timeoutMs: t, step: 'goto' });
    if (res.errorText) throw new Error(`导航失败 [步骤=goto, URL=${url}, 原因=${res.errorText}]`);
    this.url = url;
    await this._waitLoad(t, 'goto');
    await this._waitNetworkIdle();
    let title = '';
    try {
      const info = await this.evalJs(`({ title: document.title, readyState: document.readyState })`);
      title = info.title ?? '';
    } catch {}
    this.title = title;
    this.log.info('page', `导航成功: ${url} (title=${title})`);
    return { url: this.url, title, frameId: res.frameId, loaderId: res.loaderId };
  }

  async _waitNetworkIdle({ intervalMs = 300, maxMs = 5000 } = {}) {
    const deadline = Date.now() + maxMs;
    let last = null;
    while (Date.now() < deadline) {
      let sample;
      try {
        sample = await this.evalJs(`({ ready: document.readyState, res: performance.getEntriesByType('resource').length })`);
      } catch {
        sample = { ready: 'loading', res: -1 };
      }
      if (sample.ready === 'complete' && last !== null && sample.res === last) return;
      last = sample.res;
      await sleep(intervalMs);
    }
  }

  async evalJs(code, { awaitPromise = true } = {}) {
    await this.ready();
    const res = await this.client().send(
      'Runtime.evaluate',
      { expression: code, returnByValue: true, awaitPromise },
      { sessionId: this.sessionId, step: 'evalJs' },
    );
    if (res.exceptionDetails) {
      const desc = (res.exceptionDetails.exception?.description || res.exceptionDetails.text || '执行异常').slice(0, 200);
      throw new Error(`JS 执行异常 [步骤=evalJs, 代码="${code.slice(0, 80)}..."] ${desc}`);
    }
    return res.result?.value;
  }

  async query(sel) {
    const expr = `(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return { found: false };
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const visible = r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
      const attrs = {};
      for (const a of el.attributes) attrs[a.name] = a.value;
      return {
        found: true,
        tagName: el.tagName,
        text: (el.textContent || '').trim().slice(0, 500),
        attrs,
        rect: { x: r.x, y: r.y, width: r.width, height: r.height },
        visible,
      };
    })()`;
    const v = await this.evalJs(expr);
    this.log.debug('page', `查询元素: ${sel} → found=${v.found}`);
    return v;
  }

  async queryAll(sel) {
    const expr = `(() => {
      const list = Array.from(document.querySelectorAll(${JSON.stringify(sel)}));
      return list.map((el) => {
        const attrs = {};
        for (const a of el.attributes) attrs[a.name] = a.value;
        return { tagName: el.tagName, text: (el.textContent || '').trim().slice(0, 300), attrs };
      });
    })()`;
    return this.evalJs(expr);
  }

  async click(sel, { timeoutMs } = {}) {
    const t = timeoutMs ?? this.browser.cfg.timeoutMs;
    const step = 'click';
    const q = await this.query(sel);
    if (!q.found || !q.visible) {
      throw new Error(stepError(step, { selector: sel, timeout: t }) + (q.found ? ' (元素不可见)' : ' (元素不存在)'));
    }
    await this.evalJs(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      el.scrollIntoView({ block: 'center', inline: 'center' });
      return true;
    })()`);
    await sleep(100);
    const q2 = await this.query(sel);
    if (!q2.found || !q2.visible) {
      throw new Error(stepError(step, { selector: sel, timeout: t }) + ' (滚动后元素不可见)');
    }
    const x = Math.round(q2.rect.x + q2.rect.width / 2);
    const y = Math.round(q2.rect.y + q2.rect.height / 2);
    this.log.debug('page', `点击元素: ${sel} @ (${x},${y})`);
    await this.client().send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }, { sessionId: this.sessionId, step });
    await this.client().send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }, { sessionId: this.sessionId, step });
    this.log.debug('page', `点击完成: ${sel}`);
  }

  async type(sel, text, { clear = false, timeoutMs } = {}) {
    const t = timeoutMs ?? this.browser.cfg.timeoutMs;
    const step = 'type';
    const q = await this.query(sel);
    if (!q.found) throw new Error(stepError(step, { selector: sel, timeout: t }) + ' (元素不存在)');
    const focused = await this.evalJs(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      el.scrollIntoView({ block: 'center' });
      el.focus();
      return document.activeElement === el;
    })()`);
    if (!focused) throw new Error(stepError(step, { selector: sel, timeout: t }) + ' (聚焦失败)');
    if (clear) {
      await this.evalJs(`(() => { document.execCommand('selectAll'); return true; })()`);
    }
    await this.client().send('Input.insertText', { text }, { sessionId: this.sessionId, timeoutMs: t, step });
    const readback = await this.evalJs(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      return el.value !== undefined && el.value !== null ? String(el.value) : (el.textContent || '');
    })()`);
    const tail = text.length > 10 ? text.slice(-10) : text;
    if (!readback.includes(tail)) {
      throw new Error(`${stepError(step, { selector: sel, timeout: t })} 输入回读校验失败: 期望包含 "${tail}", 实际="${readback.slice(0, 50)}"`);
    }
    this.log.info('page', `输入完成: ${sel} (text=${text.length} 字符, 回读=${readback.length} 字符)`);
  }

  async waitForElement(sel, { state = 'visible', timeoutMs } = {}) {
    const t = timeoutMs ?? this.browser.cfg.timeoutMs;
    const step = 'waitForElement';
    const deadline = Date.now() + t;
    while (Date.now() < deadline) {
      const q = await this.query(sel);
      const ok = state === 'visible' ? q.found && q.visible
        : state === 'attached' ? q.found
        : state === 'hidden' ? !q.found || !q.visible
        : false;
      if (ok) {
        this.log.info('page', `等待成功: ${sel} (state=${state})`);
        return q;
      }
      await sleep(200);
    }
    throw new Error(stepError(step, { selector: sel, timeout: t }));
  }

  async waitForText(text, { timeoutMs } = {}) {
    const t = timeoutMs ?? this.browser.cfg.timeoutMs;
    const step = 'waitForText';
    const deadline = Date.now() + t;
    while (Date.now() < deadline) {
      let ok = false;
      try {
        ok = await this.evalJs(`document.body.innerText.includes(${JSON.stringify(text)})`);
      } catch {}
      if (ok) {
        this.log.info('page', `等待文本成功: "${text.slice(0, 50)}"`);
        return;
      }
      await sleep(200);
    }
    throw new Error(`${stepError(step, { timeout: t })} 文本="${text.slice(0, 50)}"`);
  }

  async waitForStable({ intervalMs = 300, maxMs = 2000, samples = 2 } = {}) {
    const deadline = Date.now() + maxMs;
    let prev = null;
    let stable = 0;
    while (Date.now() < deadline) {
      let sig = -1;
      try {
        sig = await this.evalJs(`document.documentElement.outerHTML.length + document.body.innerText.length`);
      } catch {}
      if (sig === prev) stable += 1;
      else {
        stable = 1;
        prev = sig;
      }
      if (stable >= samples) {
        this.log.debug('page', `DOM 稳定: 签名=${sig}`);
        return;
      }
      await sleep(intervalMs);
    }
    this.log.debug('page', `DOM 稳定判定超时 (maxMs=${maxMs}ms)，返回当前状态`);
  }

  async screenshot(file, { fullPage = false, clip = null } = {}) {
    const params = { format: 'png', captureBeyondViewport: !!fullPage };
    if (clip) params.clip = { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 };
    const res = await this.client().send('Page.captureScreenshot', params, { sessionId: this.sessionId, step: 'screenshot' });
    const buf = Buffer.from(res.data, 'base64');
    const abs = path.resolve(file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buf);
    this.log.info('page', `截图已保存: ${abs} (bytes=${buf.length})`);
    return abs;
  }

  async setCookie(c) {
    await this.client().send('Network.setCookie', c, { sessionId: this.sessionId, step: 'setCookie' });
  }

  async getCookie(name) {
    const { cookies } = await this.client().send('Network.getAllCookies', {}, { sessionId: this.sessionId, step: 'getCookie' });
    return cookies.find((c) => c.name === name) ?? null;
  }

  async newTab(url = 'about:blank') {
    return this.browser.newPage(url);
  }

  async switchTab(i) {
    return this.browser.switchTab(i);
  }

  async reload({ timeoutMs } = {}) {
    const t = timeoutMs ?? this.browser.cfg.timeoutMs;
    await this.ready();
    await this.client().send('Page.reload', {}, { sessionId: this.sessionId, timeoutMs: t, step: 'reload' });
    await this._waitLoad(t, 'reload');
    this.log.info('page', `页面已刷新: ${this.url}`);
  }

  async getUrl() {
    return this.url;
  }
}
