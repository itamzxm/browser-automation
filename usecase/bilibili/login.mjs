// usecase/bilibili/login.mjs — B 站登录态检测 / 扫码登录协作 / cookie 保存与恢复（零依赖）
// 用法：node usecase/bilibili/login.mjs   （单独跑登录流程，供调试；成功 exit 0，失败 exit 1）
// 导出：checkLogin / ensureLogin / loadLogin（供 publish.mjs 复用）
// 流程：loadLogin(cookie 恢复) → 有效则直接通过；无效/无文件 → ensureLogin(扫码) → cookieSave 落盘
// 环境变量：BILI_QR_TIMEOUT_MS 可覆盖扫码总超时（默认 360000ms）
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, launchEdge, PROJECT_ROOT } from '../../core/launcher.mjs';
import { getLogger, createLogger, fileStamp } from '../../core/logger.mjs';

const HOME_URL = 'https://www.bilibili.com/';
const PC_LOGIN_URL = 'https://passport.bilibili.com/login';
const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav';
const QR_GENERATE_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main_web';
const QR_POLL_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll';
const COOKIE_FILE = path.join(PROJECT_ROOT, 'output', 'cookies', 'bilibili.json');
const QR_SHOT_FILE = path.join(PROJECT_ROOT, 'output', 'qrcode.png');

const QR_WAIT = 86101;        // 未扫码
const QR_SCANNED = 86090;     // 已扫码未确认
const QR_EXPIRED = 86038;     // 二维码过期，需重新生成
const POLL_INTERVAL_MS = 2000;
const QR_TIMEOUT_MS = Number(process.env.BILI_QR_TIMEOUT_MS) || 360000;

const log = getLogger();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function apiGet(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`接口请求失败 [步骤=接口请求, URL=${url}, 状态=${res.status}]`);
  return res.json();
}

// 登录态检测：在 bilibili 站点页面内 fetch nav（页面自带 cookie，同站凭据可随请求带上）
// 返回 { logged, code, uid, uname }
export async function checkLogin(page) {
  try {
    const info = await page.evalJs(`fetch(${JSON.stringify(NAV_URL)}, { credentials: 'include', headers: { accept: 'application/json' } }).then((r) => r.json())`);
    if (info && typeof info.code === 'number') {
      const data = info.data ?? {};
      const logged = info.code === 0 && !!data.isLogin;
      log.info('bilibili', `登录态检测: code=${info.code}${logged ? `, 已登录 (uid=${data.mid}, uname=${data.uname})` : ''}`);
      return { logged, code: info.code, uid: data.mid ?? null, uname: data.uname ?? '' };
    }
  } catch (e) {
    log.warn('bilibili', `nav 接口检测异常: ${e.message}`);
  }
  const cookie = await page.getCookie('SESSDATA');
  log.warn('bilibili', `nav 检测不可用，兜底查 SESSDATA cookie: ${cookie ? '存在(有效性未知)' : '不存在'}`);
  return { logged: false, code: -1, uid: null, uname: '' };
}

// 扫码登录协作：打开 PC 登录页（passport.bilibili.com/login，非 h5 移动端页）→ 截图二维码 → 2s 轮询状态机（86101/86090/86038/0）→ 确认 cookie 落位
// 成功返回 qrcode_key；超时抛错
export async function ensureLogin(browser, page) {
  const deadline = Date.now() + QR_TIMEOUT_MS;
  let genCount = 0;

  while (Date.now() < deadline) {
    genCount += 1;
    let gen;
    try {
      gen = await apiGet(QR_GENERATE_URL);
    } catch (e) {
      log.error('bilibili', `二维码生成失败: ${e.message}，5 秒后重试`);
      await sleep(5000);
      continue;
    }
    if (gen.code !== 0 || !gen.data?.qrcode_key) {
      throw new Error(`二维码生成接口异常 [步骤=生成二维码, URL=${QR_GENERATE_URL}, 返回=${JSON.stringify(gen).slice(0, 200)}]`);
    }
    const qrcodeKey = gen.data.qrcode_key;
    log.info('bilibili', `二维码已生成 (#${genCount}): qrcode_key=${qrcodeKey}`);

    await page.goto(PC_LOGIN_URL, { timeoutMs: 30000 });
    await sleep(2000);
    await page.waitForStable({ maxMs: 5000 }).catch(() => {});
    const shot = await page.screenshot(QR_SHOT_FILE);
    log.info('bilibili', `请扫描窗口中的二维码（截图: ${shot}），等待自动登录`);

    let regenerated = false;
    while (Date.now() < deadline && !regenerated) {
      await sleep(POLL_INTERVAL_MS);
      let poll;
      try {
        poll = await apiGet(`${QR_POLL_URL}?qrcode_key=${encodeURIComponent(qrcodeKey)}`);
      } catch (e) {
        log.warn('bilibili', `轮询请求失败: ${e.message}，继续等待`);
        continue;
      }
      const st = poll.data?.code ?? poll.code;
      if (st === 0) {
        log.info('bilibili', '扫码登录成功 (code=0)，等待 cookie 落位…');
        await page.goto(HOME_URL, { timeoutMs: 30000 }).catch((e) => log.warn('bilibili', `首页导航异常: ${e.message}`));
        let ok = false;
        for (let i = 0; i < 10 && !ok; i++) {
          ok = (await checkLogin(page)).logged;
          if (!ok) await sleep(1000);
        }
        if (!ok) throw new Error('扫码显示成功但浏览器 cookie 未落位 [步骤=扫码登录, URL=' + QR_POLL_URL + ']，请重试');
        return qrcodeKey;
      }
      if (st === QR_EXPIRED) {
        log.warn('bilibili', '二维码已过期 (86038)，重新生成');
        regenerated = true;
      } else if (st === QR_SCANNED) {
        log.info('bilibili', '已扫码 (86090)，请在手机上点击确认');
      } else if (st === QR_WAIT) {
        log.debug('bilibili', '等待扫码 (86101)…');
      } else {
        log.debug('bilibili', `轮询未知状态: ${st}`);
      }
    }
  }
  throw new Error(`扫码登录超时 [步骤=扫码轮询, URL=${QR_POLL_URL}, 超时=${QR_TIMEOUT_MS}ms]（期间共尝试生成二维码 ${genCount} 次）`);
}

// 登录态恢复/检测（优先级）：
// 1) 先检测浏览器内真实登录态（attach 模式登录态在浏览器 profile 里，优先于 cookie 文件）
// 2) cookie 文件仅作兜底恢复
export async function loadLogin(browser, page) {
  await page.goto(HOME_URL, { timeoutMs: 30000 }).catch((e) => log.warn('bilibili', `首页导航异常: ${e.message}`));
  const live = await checkLogin(page);
  if (live.logged) {
    log.info('bilibili', `浏览器内登录态有效 (uid=${live.uid}, uname=${live.uname})，无需扫码`);
    return true;
  }
  log.info('bilibili', `浏览器内未登录 (code=${live.code})，尝试 cookie 文件恢复: ${COOKIE_FILE}`);
  if (!fs.existsSync(COOKIE_FILE)) {
    log.info('bilibili', `cookie 文件不存在: ${COOKIE_FILE}，跳过恢复`);
    return false;
  }
  try {
    await browser.cookieLoad(COOKIE_FILE);
  } catch (e) {
    log.warn('bilibili', `cookie 加载失败: ${e.message}`);
    return false;
  }
  await page.goto(HOME_URL, { timeoutMs: 30000 }).catch((e) => log.warn('bilibili', `首页导航异常: ${e.message}`));
  const ck = await checkLogin(page);
  if (ck.logged) {
    log.info('bilibili', `cookie 恢复成功，登录态有效 (uid=${ck.uid}, uname=${ck.uname})`);
    return true;
  }
  log.warn('bilibili', `cookie 已加载但登录态失效 (code=${ck.code})，进入扫码流程`);
  return false;
}

async function main() {
  createLogger('bilibili-login', { level: 'INFO', file: path.join(PROJECT_ROOT, 'output', 'logs', `bilibili-login-${fileStamp()}.log`) });
  const cfg = loadConfig();
  let browser = null;
  try {
    browser = await launchEdge(cfg);
    const page = await browser.newPage();
    const ok = await loadLogin(browser, page);
    if (ok) {
      log.info('bilibili', '已登录，通过（无需扫码）');
      return 0;
    }
    log.info('bilibili', '未登录，请在打开的浏览器窗口中扫码（二维码截图: output/qrcode.png）');
    await ensureLogin(browser, page);
    const count = await browser.cookieSave(COOKIE_FILE);
    log.info('bilibili', `扫码登录完成，cookie 已保存: ${COOKIE_FILE} (count=${count})`);
    return 0;
  } catch (e) {
    log.error('bilibili', `登录流程失败: ${e.message}`);
    return 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isCli) {
  main().then((code) => {
    process.exitCode = code;
  });
}
