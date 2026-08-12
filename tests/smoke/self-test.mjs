// tests/smoke/self-test.mjs — 内核冒烟自测（T-A12）：驱动 smoke.html 验证全能力，全绿退出码 0
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { loadConfig, launchEdge, PROJECT_ROOT } from '../../core/launcher.mjs';
import { createLogger, fileStamp } from '../../core/logger.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SMOKE_DIR = path.join(ROOT, 'tests', 'smoke');
const OUT = path.join(ROOT, 'output');
const SMOKE_HTML = `file:///${path.join(SMOKE_DIR, 'smoke.html').replace(/\\/g, '/')}`;

createLogger('selftest', { level: 'INFO', file: path.join(OUT, 'logs', `selftest-${fileStamp()}.log`) });

const results = [];
function check(name, fn) {
  const start = Date.now();
  return Promise.resolve()
    .then(fn)
    .then((detail) => {
      results.push({ name, ok: true, detail: detail ?? '', ms: Date.now() - start });
      console.log(`PASS ${name} (${Date.now() - start}ms)${detail ? ` - ${detail}` : ''}`);
    })
    .catch((e) => {
      results.push({ name, ok: false, detail: e.message, ms: Date.now() - start });
      console.log(`FAIL ${name} - ${e.message}`);
    });
}

function pngSize(buf) {
  if (buf.length < 24 || buf[0] !== 0x89 || buf[1] !== 0x50) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function serveSmoke() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p === '/') p = '/smoke.html';
      const file = path.join(SMOKE_DIR, p.replace(/^\/+/, ''));
      if (!file.startsWith(SMOKE_DIR)) {
        res.writeHead(403);
        res.end();
        return;
      }
      fs.readFile(file, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  const cfg = loadConfig();
  cfg.headless = process.env.SMOKE_HEADFUL ? false : true;
  cfg.userDataDir = path.join(ROOT, 'output', 'user-data', 'smoke-main');
  const browser = await launchEdge(cfg);

  await check('启动浏览器', async () => {
    if (!browser || !browser.port || !browser.wsUrl) throw new Error('浏览器未就绪');
    return `端口=${browser.port}`;
  });

  await check('导航(file:// 冒烟页)', async () => {
    const r = await browser.getActivePage().goto(SMOKE_HTML);
    if (r.title !== '冒烟测试页') throw new Error(`title=${r.title}`);
    return `${r.url} / title=${r.title}`;
  });

  const page = browser.getActivePage();

  await check('等待 waitForStable(进度区持续变更期间)', async () => {
    const start = Date.now();
    await page.waitForStable({ maxMs: 8000 });
    const elapsed = Date.now() - start;
    if (elapsed < 3500) throw new Error(`过早判定稳定: ${elapsed}ms`);
    return `历经 ${elapsed}ms 后稳定`;
  });

  await check('DOM 查询 query/queryAll', async () => {
    const btn = await page.query('#btn');
    if (!btn.found || btn.tagName !== 'BUTTON' || !btn.visible) throw new Error(`按钮查询异常: ${JSON.stringify(btn)}`);
    if (!btn.text.includes('点我')) throw new Error(`按钮文本=${btn.text}`);
    const list = await page.queryAll('#list li');
    if (list.length !== 3) throw new Error(`列表长度=${list.length}`);
    const miss = await page.query('#not-exist');
    if (miss.found) throw new Error('不存在元素竟 found=true');
    return `按钮@(${btn.rect.x},${btn.rect.y}) 列表=${list.length}项`;
  });

  await check('点击', async () => {
    await page.click('#btn');
    const v = await page.evalJs(`document.querySelector('#btn').dataset.clicked`);
    if (v !== 'yes') throw new Error(`dataset.clicked=${v}`);
    return 'dataset.clicked=yes';
  });

  await check('中文输入(insertText)', async () => {
    await page.type('#input', '中文测试abc');
    const v = await page.evalJs(`document.querySelector('#input').value`);
    if (v !== '中文测试abc') throw new Error(`value=${v}`);
    const echo = await page.evalJs(`document.querySelector('#echo').textContent`);
    if (!echo.includes('中文测试abc')) throw new Error(`回显=${echo}`);
    return `value=${v}, 回显=${echo}`;
  });

  await check('多行输入+清空重输(clear)', async () => {
    await page.type('#textarea', '第一行\n第二行', { clear: false });
    const v1 = await page.evalJs(`document.querySelector('#textarea').value`);
    if (v1 !== '第一行\n第二行') throw new Error(`多行value=${JSON.stringify(v1)}`);
    await page.type('#textarea', '替换后内容', { clear: true });
    const v2 = await page.evalJs(`document.querySelector('#textarea').value`);
    if (v2 !== '替换后内容') throw new Error(`clear后value=${v2}`);
    return `多行+clear 均正确`;
  });

  await check('等待 waitForElement(隐藏→延迟显示元素)', async () => {
    await page.evalJs(`(() => {
      const el = document.querySelector('#late');
      el.style.display = 'none';
      setTimeout(() => { el.style.display = 'block'; }, 1500);
      return true;
    })()`);
    const before = await page.query('#late');
    if (before.visible) throw new Error('延迟元素过早可见');
    const start = Date.now();
    await page.waitForElement('#late', { timeoutMs: 10000 });
    const elapsed = Date.now() - start;
    if (elapsed < 1300) throw new Error(`等待过短: ${elapsed}ms`);
    return `${elapsed}ms 后等到延迟元素`;
  });

  await check('等待 waitForText(2s动态文本)', async () => {
    await page.waitForText('动态文本已写入', { timeoutMs: 10000 });
    return '动态文本已等到';
  });

  await check('JS 执行 evalJs', async () => {
    const r1 = await page.evalJs('1+1');
    if (r1 !== 2) throw new Error(`1+1=${r1}`);
    const r2 = await page.evalJs(`Promise.resolve({a:1,b:'中文'})`);
    if (r2.a !== 1 || r2.b !== '中文') throw new Error(`异步对象=${JSON.stringify(r2)}`);
    let threw = null;
    try {
      await page.evalJs(`throw new Error('boom')`);
    } catch (e) {
      threw = e.message;
    }
    if (!threw || !threw.includes('JS 执行异常')) throw new Error(`异常未正确抛出: ${threw}`);
    return '1+1=2, awaitPromise 对象, 异常带代码片段';
  });

  await check('截图 viewport+fullPage', async () => {
    const vp = await page.screenshot(path.join(OUT, 'screenshots', 'smoke-viewport.png'));
    const fp = await page.screenshot(path.join(OUT, 'screenshots', 'smoke-full.png'), { fullPage: true });
    const bv = fs.readFileSync(vp);
    const bf = fs.readFileSync(fp);
    const sv = pngSize(bv);
    const sf = pngSize(bf);
    if (!sv) throw new Error('viewport PNG 魔数错误');
    if (!sf) throw new Error('fullPage PNG 魔数错误');
    if (sf.height <= sv.height) throw new Error(`整页高度未超过视口: ${sf.height} <= ${sv.height}`);
    return `viewport=${sv.width}x${sv.height}, fullPage=${sf.width}x${sf.height}`;
  });

  const server = await serveSmoke();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  await check('Cookie 保存(页面JS写入→getAllCookies→落盘)', async () => {
    const p = await browser.newPage(`${baseUrl}/smoke.html`);
    await p.waitForElement('#btn');
    await p.evalJs(`document.cookie = 'smoke_k=cookie-value-123; path=/'`);
    const n = await browser.cookieSave(path.join(OUT, 'cookies', 'smoke-test.json'));
    if (n < 1) throw new Error(`cookie 数量=${n}`);
    const raw = JSON.parse(fs.readFileSync(path.join(OUT, 'cookies', 'smoke-test.json'), 'utf8'));
    const ck = raw.cookies.find((c) => c.name === 'smoke_k');
    if (!ck || ck.value !== 'cookie-value-123') throw new Error(`cookie 字段: ${JSON.stringify(ck)}`);
    return `保存 ${n} 条，smoke_k=${ck.value} (domain=${ck.domain})`;
  });

  await check('Cookie 恢复(新浏览器→cookieLoad→读回)', async () => {
    const cfg2 = loadConfig();
    cfg2.headless = true;
    cfg2.userDataDir = path.join(ROOT, 'output', 'user-data', 'smoke-cookie');
    const b2 = await launchEdge(cfg2);
    const p2 = await b2.newPage('about:blank');
    const n = await b2.cookieLoad(path.join(OUT, 'cookies', 'smoke-test.json'));
    if (n < 1) throw new Error(`加载后数量=${n}`);
    await p2.goto(`${baseUrl}/smoke.html`);
    await p2.waitForElement('#btn');
    const readback = await p2.evalJs('document.cookie');
    if (!readback.includes('smoke_k=cookie-value-123')) throw new Error(`读回 cookie=${readback}`);
    await b2.close();
    return `cookieLoad=${n} 条，页面读回包含 smoke_k`;
  });

  await check('多标签 newPage/switchTab/路由隔离', async () => {
    const p1 = await browser.newPage(`${baseUrl}/smoke.html`);
    const p2 = await browser.newPage(`${baseUrl}/smoke.html?tab=2`);
    await p1.waitForElement('#btn');
    await p2.waitForElement('#btn');
    if (browser.pages.size < 2) throw new Error(`页面数=${browser.pages.size}`);
    await p1.evalJs(`document.title = 'TAB1'`);
    await p2.evalJs(`document.title = 'TAB2'`);
    if (p1.url !== `${baseUrl}/smoke.html`) throw new Error(`p1.url=${p1.url}`);
    if (p2.url !== `${baseUrl}/smoke.html?tab=2`) throw new Error(`p2.url=${p2.url}`);
    await browser.switchTab(0);
    const act0 = browser.getActivePage();
    await act0.evalJs(`1+1`);
    await browser.switchTab(p2.targetId);
    if (browser.getActivePage().targetId !== p2.targetId) throw new Error('切换到 p2 失败');
    const t1 = await p1.evalJs('document.title');
    const t2 = await p2.evalJs('document.title');
    if (t1 !== 'TAB1' || t2 !== 'TAB2') throw new Error(`title 串扰: p1=${t1}, p2=${t2}`);
    await browser.closePage(p2.targetId);
    await new Promise((r) => setTimeout(r, 300));
    if (browser.pages.has(p2.targetId)) throw new Error('关页后 Map 未移除');
    return `2 页导航互不干扰，切换/关闭正常`;
  });

  await check('等待超时错误上下文', async () => {
    let threw = null;
    try {
      await page.waitForElement('#never-exists', { timeoutMs: 1000 });
    } catch (e) {
      threw = e.message;
    }
    if (!threw || !threw.includes('waitForElement') || !threw.includes('#never-exists') || !threw.includes('超时')) {
      throw new Error(`错误信息缺上下文: ${threw}`);
    }
    return threw;
  });

  await check('点击不可见元素报错', async () => {
    await page.evalJs(`document.querySelector('#late').style.display = 'none'`);
    let threw = null;
    try {
      await page.click('#late');
    } catch (e) {
      threw = e.message;
    }
    if (!threw || !threw.includes('click') || !threw.includes('超时')) throw new Error(`错误信息: ${threw}`);
    return '不可见元素点击已抛错';
  });

  await check('零依赖核验(无 node_modules + 仅内置/相对 import)', async () => {
    for (const t of [path.join(ROOT, 'node_modules'), path.join(ROOT, 'core', 'node_modules')]) {
      if (fs.existsSync(t)) throw new Error(`发现 ${t}`);
    }
    const files = [
      'core/logger.mjs', 'core/cdp-client.mjs', 'core/launcher.mjs', 'core/page.mjs', 'cli.mjs',
    ].map((f) => path.join(ROOT, f));
    const bad = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(/import\s+[\s\S]*?from\s+['"]([^'"]+)['"]/g)) {
        const spec = m[1];
        if (spec.startsWith('node:') || spec.startsWith('.') || spec.startsWith('/')) continue;
        bad.push(`${f}: ${spec}`);
      }
    }
    if (bad.length) throw new Error(`非法第三方 import: ${bad.join('; ')}`);
    return '目录无 node_modules，import 仅内置/相对';
  });

  await browser.close();
  server.close();

  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  console.log('');
  console.log(`自测结果: ${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`自测异常终止: ${e.message}`);
  process.exitCode = 1;
});
