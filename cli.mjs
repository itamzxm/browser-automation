// cli.mjs — CLI 入口（T-A11）：无状态单命令模式，命令完成后浏览器保持运行，close 才关闭
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, launchEdge, PROJECT_ROOT } from './core/launcher.mjs';
import { createLogger, fileStamp } from './core/logger.mjs';

const ROOT = PROJECT_ROOT;
const RUNTIME_FILE = path.join(ROOT, 'output', 'runtime.json');

const log = createLogger('cli', { level: 'INFO', file: path.join(ROOT, 'output', 'logs', `cli-${fileStamp()}.log`) });

function usage() {
  return `用法: node cli.mjs <命令> [参数]
  launch                 仅启动浏览器并保持运行（输出端口/进程信息）
  open <url>             启动/复用浏览器并导航，输出 title/url
  click <selector>       点击活动页元素
  type <selector> <文本> 输入文本（中文安全，可多参数拼接）
  wait <selector>        等待元素可见（默认 30s）
  js <代码>              执行 JS 并输出 JSON 结果
  shot [--full] <文件>   截图（默认 output/screenshots/shot-<时间>.png）
  cookie-save [<文件>]   Cookie 全量落盘（默认 output/cookies/<站点>.json）
  cookie-load <文件>     载入 Cookie 并自动刷新活动页
  new-tab [<url>]        新开标签（默认 about:blank）
  switch-tab <索引|targetId>  切换活动标签
  close                  关闭浏览器
  selftest               运行内核冒烟自测（tests/smoke/self-test.mjs）`;
}

function parseArgs(argv) {
  const flags = new Set();
  const positional = [];
  for (const a of argv) {
    if (a.startsWith('--')) flags.add(a.slice(2));
    else positional.push(a);
  }
  return { flags, positional };
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

async function ensureBrowser() {
  const cfg = loadConfig();
  if (cfg.port === 0) {
    try {
      const rt = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8'));
      if (rt.port) cfg.port = rt.port;
    } catch {}
  }
  const b = await launchEdge(cfg, { keepAlive: true });
  fs.mkdirSync(path.join(ROOT, 'output'), { recursive: true });
  fs.writeFileSync(RUNTIME_FILE, JSON.stringify({ port: b.port, pid: b.proc ? b.proc.pid : null, wsUrl: b.wsUrl, at: new Date().toISOString() }, null, 2));
  return b;
}

function resolveOutPath(p, defDir) {
  if (!p) return null;
  if (path.isAbsolute(p)) return p;
  return path.resolve(process.cwd(), p);
}

function cookieFilePath(arg, site) {
  const cfg = loadConfig();
  if (!arg) return path.join(cfg.cookiesDir, `${site || 'browser'}.json`);
  if (arg.includes('.') || arg.includes('\\') || arg.includes('/')) return path.resolve(process.cwd(), arg);
  return path.join(cfg.cookiesDir, `${arg}.json`);
}

function ok(payload) {
  console.log(JSON.stringify({ status: 'ok', ...payload }));
}

async function cmdLaunch() {
  const b = await ensureBrowser();
  ok({ command: 'launch', port: b.port, wsUrl: b.wsUrl, pid: b.proc ? b.proc.pid : null, userDataDir: b.userDataDir });
  return b;
}

async function cmdOpen(url) {
  const b = await ensureBrowser();
  const page = b.getActivePage() ?? (await b.newPage('about:blank'));
  const r = await page.goto(url);
  ok({ command: 'open', title: r.title, url: r.url, port: b.port });
  return b;
}

async function cmdClick(sel) {
  const b = await ensureBrowser();
  const page = b.getActivePage() ?? (await b.newPage('about:blank'));
  await page.click(sel);
  ok({ command: 'click', selector: sel });
  return b;
}

async function cmdType(sel, text) {
  if (!sel || !text) throw new Error('用法: node cli.mjs type <selector> <文本>');
  const b = await ensureBrowser();
  const page = b.getActivePage() ?? (await b.newPage('about:blank'));
  await page.type(sel, text);
  ok({ command: 'type', selector: sel, text });
  return b;
}

async function cmdWait(sel) {
  const b = await ensureBrowser();
  const page = b.getActivePage() ?? (await b.newPage('about:blank'));
  await page.waitForElement(sel);
  ok({ command: 'wait', selector: sel });
  return b;
}

async function cmdJs(code) {
  if (!code) throw new Error('用法: node cli.mjs js <代码>');
  const b = await ensureBrowser();
  const page = b.getActivePage() ?? (await b.newPage('about:blank'));
  const result = await page.evalJs(code);
  ok({ command: 'js', result });
  return b;
}

async function cmdShot(flags, file) {
  const b = await ensureBrowser();
  const page = b.getActivePage() ?? (await b.newPage('about:blank'));
  const out = resolveOutPath(file, '') ?? path.join(ROOT, 'output', 'screenshots', `shot-${fileStamp()}.png`);
  const abs = await page.screenshot(out, { fullPage: flags.has('full') });
  ok({ command: 'shot', file: abs, fullPage: flags.has('full') });
  return b;
}

async function cmdCookieSave(arg) {
  const b = await ensureBrowser();
  const page = b.getActivePage() ?? (await b.newPage('about:blank'));
  let site = '';
  try {
    const u = new URL(page.url || '');
    site = u.hostname;
  } catch {}
  const file = cookieFilePath(arg, site);
  const n = await b.cookieSave(file);
  ok({ command: 'cookie-save', file: path.resolve(file), count: n });
  return b;
}

async function cmdCookieLoad(arg) {
  if (!arg) throw new Error('用法: node cli.mjs cookie-load <文件>');
  const b = await ensureBrowser();
  const file = cookieFilePath(arg, '');
  const n = await b.cookieLoad(file);
  const page = b.getActivePage() ?? (await b.newPage('about:blank'));
  await page.reload();
  ok({ command: 'cookie-load', file: path.resolve(file), count: n });
  return b;
}

async function cmdNewTab(url) {
  const b = await ensureBrowser();
  const page = await b.newPage(url || 'about:blank');
  ok({ command: 'new-tab', targetId: page.targetId, url: page.url });
  return b;
}

async function cmdSwitchTab(sel) {
  if (!sel) throw new Error('用法: node cli.mjs switch-tab <索引|targetId>');
  const b = await ensureBrowser();
  const page = await b.switchTab(sel);
  ok({ command: 'switch-tab', targetId: page.targetId, url: page.url });
  return b;
}

async function cmdClose() {
  const cfg = loadConfig();
  let pid = null;
  let port = cfg.port;
  try {
    const rt = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8'));
    pid = rt.pid ?? null;
    if (!port) port = rt.port;
  } catch {}
  let closed = false;
  if (port && (await fetchVersion(port))) {
    const b = await launchEdge({ ...cfg, port });
    await b.close();
    closed = true;
  }
  if (pid) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      process.kill(pid);
    } catch {}
  }
  try {
    fs.unlinkSync(RUNTIME_FILE);
  } catch {}
  ok({ command: 'close', closed });
}

async function cmdSelftest() {
  const child = spawn(process.execPath, [path.join(ROOT, 'tests', 'smoke', 'self-test.mjs')], { stdio: 'inherit', cwd: ROOT });
  child.on('exit', (code) => process.exit(code ?? 1));
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const cmd = positional[0] ?? '';
  const args = positional.slice(1);
  let browser = null;
  switch (cmd) {
    case 'launch': browser = await cmdLaunch(); break;
    case 'open': browser = await cmdOpen(args[0]); break;
    case 'click': browser = await cmdClick(args[0]); break;
    case 'type': browser = await cmdType(args[0], args.slice(1).join(' ')); break;
    case 'wait': browser = await cmdWait(args[0]); break;
    case 'js': browser = await cmdJs(args.join(' ')); break;
    case 'shot': browser = await cmdShot(flags, args[0]); break;
    case 'cookie-save': browser = await cmdCookieSave(args[0]); break;
    case 'cookie-load': browser = await cmdCookieLoad(args[0]); break;
    case 'new-tab': browser = await cmdNewTab(args[0]); break;
    case 'switch-tab': browser = await cmdSwitchTab(args[0]); break;
    case 'close': await cmdClose(); break;
    case 'selftest': return cmdSelftest();
    case '': console.log(usage()); break;
    default: throw new Error(`未知命令: ${cmd}\n${usage()}`);
  }
  if (browser) {
    browser.client.close();
    await new Promise((r) => setTimeout(r, 50));
  }
}

main().catch((e) => {
  log.error('cli', `命令失败: ${e.message}`);
  console.error(`FAIL: ${e.message}`);
  process.exit(1);
});
