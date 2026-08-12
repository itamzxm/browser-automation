// core/launcher.mjs — 浏览器启动/清理（T-A1）+ Browser 包装（多标签 T-A9、Cookie 管理 T-A8、复用/关闭）
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CdpClient } from './cdp-client.mjs';
import { Page } from './page.mjs';
import { getLogger } from './logger.mjs';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULTS = {
  browserPath: '',
  userDataDir: 'output/user-data/',
  port: 0,
  cookiesDir: 'output/cookies/',
  timeoutMs: 30000,
  headless: false,
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function loadConfig(configPath = path.join(PROJECT_ROOT, 'config.json')) {
  let cfg = {};
  if (fs.existsSync(configPath)) {
    try {
      cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
      throw new Error(`配置文件解析失败: ${configPath} (${e.message})`);
    }
  }
  cfg = { ...DEFAULTS, ...cfg };
  cfg.userDataDir = path.resolve(PROJECT_ROOT, cfg.userDataDir);
  cfg.cookiesDir = path.resolve(PROJECT_ROOT, cfg.cookiesDir);
  return cfg;
}

export function detectBrowserPath(cfg) {
  if (cfg.browserPath && fs.existsSync(cfg.browserPath)) return cfg.browserPath;
  const candidates = [];
  const pf = process.env['ProgramFiles(x86)'];
  const pf64 = process.env['ProgramFiles'];
  if (pf) candidates.push(path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  if (pf64) candidates.push(path.join(pf64, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error('未找到浏览器可执行文件，请在 config.json 中配置 browserPath 字段');
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function checkUserDataDirLock(userDataDir, log) {
  const lockCandidates = [
    path.join(userDataDir, 'SingletonLock'),
    path.join(userDataDir, 'SingletonSocket'),
    path.join(userDataDir, 'Default', 'SingletonLock'),
    path.join(userDataDir, 'Default', 'SingletonSocket'),
  ];
  const hit = lockCandidates.find((p) => fs.existsSync(p));
  if (hit) {
    log.warn('launcher', `检测到用户数据目录被占用: ${hit}`);
    return `用户数据目录正被运行的浏览器占用 [目录=${userDataDir}]。请先完全关闭 Edge（含后台进程，任务管理器确认无 msedge.exe）后再运行本脚本`;
  }
  return null;
}

async function fetchVersion(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export class Browser {
  constructor({ cfg, port, wsUrl, proc, userDataDir }) {
    this.cfg = cfg;
    this.port = port;
    this.wsUrl = wsUrl;
    this.proc = proc ?? null;
    this.userDataDir = userDataDir;
    this.client = new CdpClient();
    this.pages = new Map();
    this.sessionToTarget = new Map();
    this.activePage = null;
    this._attachWaiters = new Map();
    this._anyAttach = new Set();
    this.log = getLogger();
    this._exitHook = null;
  }

  async connect() {
    this.client.on('Target.attachedToTarget', (m) => this._onAttached(m));
    this.client.on('Target.detachedFromTarget', (m) => this._onDetached(m));
    this.client.on('Page.loadEventFired', (m) => this._routeEvent(m));
    this.client.on('Page.frameNavigated', (m) => this._routeEvent(m));
    await this.client.connect(this.wsUrl, { timeoutMs: 15000 });
  }

  _routeEvent(m) {
    const targetId = m.sessionId ? this.sessionToTarget.get(m.sessionId) : null;
    const page = targetId ? this.pages.get(targetId) : null;
    if (page) {
      page._onEvent(m);
    } else {
      this.log.debug('page', `丢弃未匹配会话事件: ${m.method} (sessionId=${m.sessionId})`);
    }
  }

  _onAttached(m) {
    const { sessionId, targetInfo } = m.params;
    const { targetId, type } = targetInfo;
    if (type !== 'page' || this.pages.has(targetId)) return;
    this.sessionToTarget.set(sessionId, targetId);
    const page = new Page(this, targetId, sessionId);
    page.url = targetInfo.url || '';
    this.pages.set(targetId, page);
    this.log.info('page', `标签页已附加: targetId=${targetId}, url=${targetInfo.url}`);
    page.ready()
      .then(() => {
        const w = this._attachWaiters.get(targetId);
        if (w) {
          this._attachWaiters.delete(targetId);
          clearTimeout(w.timer);
          w.resolve(page);
        }
        for (const cb of [...this._anyAttach]) {
          this._anyAttach.delete(cb);
          cb(page);
        }
        if (!this.activePage) this.activePage = page;
      })
      .catch((e) => {
        if (!e.message.includes('连接已关闭')) this.log.error('page', `会话初始化失败: ${e.message}`);
        const w = this._attachWaiters.get(targetId);
        if (w) {
          this._attachWaiters.delete(targetId);
          clearTimeout(w.timer);
          w.reject(e);
        }
      });
  }

  _onDetached(m) {
    const { sessionId, targetId } = m.params;
    this.sessionToTarget.delete(sessionId);
    const page = this.pages.get(targetId);
    if (page) {
      this.pages.delete(targetId);
      if (this.activePage === page) this.activePage = this.pages.values().next().value ?? null;
      this.log.info('page', `标签页已关闭: targetId=${targetId}`);
    }
  }

  _waitForAttach(targetId, timeoutMs = 30000) {
    const existing = this.pages.get(targetId);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._attachWaiters.delete(targetId);
        reject(new Error(`等待标签页附加超时 [步骤=newPage, 超时=${timeoutMs}ms]`));
      }, timeoutMs);
      this._attachWaiters.set(targetId, { resolve, timer });
    });
  }

  _waitAnyAttach(timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._anyAttach.delete(cb);
        resolve(null);
      }, timeoutMs);
      const cb = (page) => {
        clearTimeout(timer);
        resolve(page);
      };
      this._anyAttach.add(cb);
    });
  }

  async ensureInitialPage(timeoutMs = 8000) {
    if (this.pages.size > 0) return;
    const page = await this._waitAnyAttach(timeoutMs);
    if (page) return;
    this.log.warn('launcher', '自动附加未收到页面，手动创建 about:blank');
    await this.newPage('about:blank');
  }

  async newPage(url = 'about:blank') {
    // attach/复用模式下优先复用闲置标签页，避免无限堆标签
    // 可复用：空白页(about:blank/edge://newtab) + 本脚本自己的工作页(投稿/管理)；绝不动用户正在浏览的页面
    if (this.pages.size > 0 && this.proc === null) {
      const candidates = [...this.pages.values()].filter((p) => {
        const u = p.url || '';
        if (u === 'about:blank' || u === 'edge://newtab/') return true;
        if (u.startsWith('https://member.bilibili.com/platform/upload')) return true;
        return false;
      });
      const reuse = candidates[0];
      if (reuse) {
        this.log.info('launcher', `复用闲置标签页: targetId=${reuse.targetId.slice(0, 8)} (url=${reuse.url || 'about:blank'})`);
        this.activePage = reuse;
        try {
          await reuse.goto(url, { timeoutMs: 15000 });
        } catch (e) {
          this.log.warn('launcher', `复用标签页导航失败: ${e.message}`);
        }
        return reuse;
      }
    }
    const { targetId } = await this.client.send('Target.createTarget', { url }, { step: 'newPage' });
    const page = await this._waitForAttach(targetId);
    this.activePage = page;
    return page;
  }

  async listPages() {
    let list = [];
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/json/list`);
      list = await res.json();
    } catch (e) {
      this.log.warn('launcher', `/json/list 获取失败: ${e.message}`);
    }
    const pages = list.filter((t) => t.type === 'page');
    for (const t of pages) {
      if (!this.pages.has(t.id)) {
        try {
          const { sessionId } = await this.client.send('Target.attachToTarget', { targetId: t.id, flatten: true }, { step: 'listPages' });
          this.sessionToTarget.set(sessionId, t.id);
          const page = new Page(this, t.id, sessionId);
          page.url = t.url || '';
          this.pages.set(t.id, page);
          this.log.info('page', `标签页已附加(手动): targetId=${t.id}, url=${t.url}`);
          page.ready().catch((e) => this.log.error('page', `会话初始化失败: ${e.message}`));
          if (!this.activePage) this.activePage = page;
        } catch (e) {
          this.log.warn('page', `附加目标失败: ${t.id} (${e.message})`);
        }
      }
    }
    return pages.map((t) => ({ targetId: t.id, title: t.title, url: t.url }));
  }

  async switchTab(sel) {
    let targetId = sel;
    if (typeof sel === 'number' || /^\d+$/.test(String(sel))) {
      const list = await this.listPages();
      const t = list[Number(sel)];
      if (!t) throw new Error(`切换标签失败 [步骤=switchTab, 目标=索引${sel}, 原因=不存在]`);
      targetId = t.targetId;
    }
    const page = this.pages.get(targetId);
    if (!page) throw new Error(`切换标签失败 [步骤=switchTab, 目标=${targetId}, 原因=标签页未附加]`);
    try {
      await this.client.send('Target.activateTarget', { targetId }, { step: 'switchTab' });
    } catch {}
    this.activePage = page;
    this.log.info('page', `切换到标签页: targetId=${targetId}`);
    return page;
  }

  async closePage(targetId) {
    await this.client.send('Target.closeTarget', { targetId }, { step: 'closePage' });
  }

  getActivePage() {
    if (!this.activePage || !this.pages.has(this.activePage.targetId)) {
      this.activePage = this.pages.values().next().value ?? null;
    }
    return this.activePage;
  }

  async cookieSave(file) {
    const page = this.getActivePage();
    if (!page) throw new Error('Cookie 保存失败 [步骤=cookieSave, 原因=无活动页面]');
    const { cookies } = await this.client.send('Network.getAllCookies', {}, { sessionId: page.sessionId, step: 'cookieSave' });
    const url = page.url || '';
    const payload = { meta: { savedAt: new Date().toISOString(), url }, cookies };
    const abs = path.resolve(file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, JSON.stringify(payload, null, 2));
    this.log.info('launcher', `Cookie 已保存: ${abs} (count=${cookies.length})`);
    return cookies.length;
  }

  async cookieLoad(file) {
    const abs = path.resolve(file);
    if (!fs.existsSync(abs)) throw new Error(`Cookie 加载失败 [步骤=cookieLoad, 文件=${abs}, 原因=文件不存在]`);
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(abs, 'utf8'));
    } catch (e) {
      throw new Error(`Cookie 加载失败 [步骤=cookieLoad, 文件=${abs}, 原因=JSON 解析失败 (${e.message})]`);
    }
    const cookies = Array.isArray(payload) ? payload : payload.cookies;
    if (!Array.isArray(cookies)) throw new Error(`Cookie 加载失败 [步骤=cookieLoad, 文件=${abs}, 原因=格式错误]`);
    const page = this.getActivePage();
    if (!page) throw new Error('Cookie 加载失败 [步骤=cookieLoad, 原因=无活动页面]');
    await this.client.send('Network.setCookies', { cookies }, { sessionId: page.sessionId, step: 'cookieLoad' });
    const { cookies: after } = await this.client.send('Network.getAllCookies', {}, { sessionId: page.sessionId, step: 'cookieLoad' });
    const missing = cookies.filter((c) => !after.some((a) => a.name === c.name && a.domain === c.domain && a.value === c.value));
    if (missing.length > 0) {
      throw new Error(`Cookie 加载失败 [步骤=cookieLoad, 文件=${abs}, 原因=写入校验未通过，缺失 ${missing.length} 条 (${missing.map((c) => c.name).join(',')})]`);
    }
    this.log.info('launcher', `Cookie 已加载: ${abs} (count=${after.length})`);
    return after.length;
  }

  _installExitHook() {
    this._exitHook = () => {
      try {
        if (this.proc && this.proc.exitCode === null) this.proc.kill();
      } catch {}
    };
    process.on('exit', this._exitHook);
  }

  async close() {
    if (this._exitHook) {
      process.removeListener('exit', this._exitHook);
      this._exitHook = null;
    }
    if (this.proc) {
      try {
        this.log.info('launcher', '发送 Browser.close 关闭浏览器');
        await this.client.send('Browser.close', {}, { step: 'close', timeoutMs: 5000 });
      } catch (e) {
        this.log.warn('launcher', `Browser.close 异常: ${e.message}`);
      }
      if (this.proc.exitCode === null) {
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            try {
              this.proc.kill();
            } catch {}
            resolve();
          }, 5000);
          this.proc.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    } else {
      this.log.info('launcher', 'attach 模式：仅断开连接，保留用户浏览器');
    }
    this.client.close();
  }
}

export async function launchEdge(cfg = loadConfig(), { keepAlive = false } = {}) {
  const browserPath = detectBrowserPath(cfg);
  const log = getLogger();
  let port = cfg.port;

  const realUserDataDir = cfg.userDataDir;
  const effectiveUserDataDir = await ensureNonDefaultUserDataDir(realUserDataDir, log);

  if (port !== 0) {
    const version = await fetchVersion(port);
    if (version) {
      log.info('launcher', `复用已有浏览器实例: 端口=${port}, 协议版本=${version['Protocol-Version']}`);
      const b = new Browser({ cfg, port, wsUrl: version.webSocketDebuggerUrl, proc: null, userDataDir: realUserDataDir });
      await b.connect();
      await b.ensureInitialPage();
      return b;
    }
  }

  if (port === 0) port = await getFreePort();

  const lockCheck = checkUserDataDirLock(realUserDataDir, log);
  if (lockCheck) throw new Error(lockCheck);

  fs.mkdirSync(effectiveUserDataDir, { recursive: true });
  const args = [`--remote-debugging-port=${port}`, `--user-data-dir=${effectiveUserDataDir}`, '--no-first-run'];
  if (cfg.headless) args.push('--headless=new');
  const logPath = cfg.headless ? '无头模式' : '有头模式';
  log.info('launcher', `启动浏览器: ${browserPath} ${args.join(' ')} (${logPath})`);

  const spawnOpts = keepAlive ? { stdio: 'ignore', detached: true } : { stdio: 'ignore' };
  const proc = spawn(browserPath, args, spawnOpts);

  let version = null;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    version = await fetchVersion(port);
    if (version) break;
    await sleep(200);
  }
  if (!version) {
    try {
      proc.kill();
    } catch {}
    throw new Error(`浏览器启动失败或调试端口无响应 [步骤=启动浏览器, URL=http://127.0.0.1:${port}/json/version, 超时=10000ms]。若 userDataDir 为 Edge 真实用户目录，请先完全关闭正在运行的 Edge（含后台进程）再运行`);
  }

  log.info('launcher', `浏览器已启动: 端口=${port}, userDataDir=${effectiveUserDataDir}, 协议版本=${version['Protocol-Version']}`);
  const b = new Browser({ cfg, port, wsUrl: version.webSocketDebuggerUrl, proc, userDataDir: realUserDataDir });
  if (!keepAlive) b._installExitHook();
  else proc.unref();
  await b.connect();
  await b.ensureInitialPage();
  return b;
}

const EDGE_DEFAULT_USER_DATA = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'User Data');
const JUNCTION_DIR = path.join(PROJECT_ROOT, 'output', 'edge-profile-junction');

async function ensureNonDefaultUserDataDir(userDataDir, log) {
  const norm = (p) => p.replace(/[\\/]+/g, path.sep).toLowerCase();
  const isEdgeDefault = norm(userDataDir) === norm(EDGE_DEFAULT_USER_DATA);
  if (!isEdgeDefault) return userDataDir;

  log.info('launcher', `userDataDir 是 Edge 默认目录，创建 junction 以启用调试端口: ${JUNCTION_DIR} → ${userDataDir}`);
  try {
    if (fs.existsSync(JUNCTION_DIR)) {
      const stat = fs.lstatSync(JUNCTION_DIR);
      if (!stat.isSymbolicLink() && !stat.isDirectory()) {
        fs.rmSync(JUNCTION_DIR, { recursive: true, force: true });
      }
    }
    if (!fs.existsSync(JUNCTION_DIR)) {
      fs.mkdirSync(path.dirname(JUNCTION_DIR), { recursive: true });
      fs.symlinkSync(userDataDir, JUNCTION_DIR, 'junction');
    }
    return JUNCTION_DIR;
  } catch (e) {
    throw new Error(`创建 junction 失败 [目录=${JUNCTION_DIR}]: ${e.message}。请检查权限或改用非默认 userDataDir`);
  }
}
