// usecase/bilibili/publish.mjs — B 站专栏一键发布（T-B2b~T-B2e/T-B4a）
// 用法：
//   node usecase/bilibili/publish.mjs                一键发布全链（登录→投稿→注入→发布→核验→JSON）
//   node usecase/bilibili/publish.mjs --probe        登录取证：打开 new-edit 页面 dump iframe/ProseMirror/window.editor 实证，不发布
//   node usecase/bilibili/publish.mjs --source <html> --meta <json> [--no-close]
// 导出：runPublish / probeEditor（供外部整合）；退出码 0=成功，非 0=失败
// 依据：B站用例-path-options.md「发布驱动脚本设计要点」+ 坑位 1~6；B站用例-plan.md §三
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, launchEdge, PROJECT_ROOT } from '../../core/launcher.mjs';
import { createLogger, setLogger, getLogger, fileStamp } from '../../core/logger.mjs';
import { checkLogin, ensureLogin, loadLogin } from './login.mjs';
import { stripTags, countChars } from './convert-html.mjs';

const EDIT_URL = 'https://member.bilibili.com/platform/upload/text/new-edit';
const MANAGER_URL = 'https://member.bilibili.com/platform/upload-manager/opus';
const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav';
const OPUS_INIT_CHECK_URL = 'https://member.bilibili.com/x/dynamic/feed/create/opus_init_check?editor_version=1';
const COOKIE_FILE = path.join(PROJECT_ROOT, 'output', 'cookies', 'bilibili.json');
const DEFAULT_ART = path.join(PROJECT_ROOT, 'output', 'report', 'converted.html');
const DEFAULT_META = path.join(PROJECT_ROOT, 'output', 'report', 'converted.html.meta.json');
const REPORT_FILE = path.join(PROJECT_ROOT, 'output', 'report', 'publish-result.json');
const PROBE_FILE = path.join(PROJECT_ROOT, 'output', 'report', 'probe-editor.json');
const MAX_ARTICLE_LEN = 100000;
const KEYWORDS = ['奖励比示范更厉害', 'GRPO', '蒸馏', 'DeepThink', '深度思考'];

let log = getLogger();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randBetween(a, b) {
  return a + Math.floor(Math.random() * (b - a + 1));
}

// 顶层轮询：expr 为返回 { ok, ... } 的 JS 表达式字符串，ok 为真即返回结果
async function pollUntil(page, expr, desc, { timeoutMs = 45000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await page.evalJs(expr);
      if (last && last.ok) return last;
    } catch (e) {
      log.debug('bilibili', `${desc} 轮询异常（容忍）: ${e.message.slice(0, 120)}`);
    }
    await sleep(intervalMs);
  }
  throw new Error(`等待${desc}超时 [步骤=${desc}, 超时=${timeoutMs}ms] 最近采样=${JSON.stringify(last ?? null).slice(0, 300)}`);
}

const EDITOR_IFRAME_SEL = 'iframe[src*="york/read-editor"]';

// iframe 内就绪探针（L0~L3）：返回 { ok, level, iframe, hasTitle, hasProseMirror, hasEditor, counter, publishButtons, url }
const READY_EXPR = `(() => {
  const f = document.querySelector('${EDITOR_IFRAME_SEL}');
  if (!f) return { ok: false, level: 0, why: 'no-iframe' };
  let w = null, d = null;
  try { w = f.contentWindow; d = f.contentDocument; } catch (e) { return { ok: false, level: 0, iframe: true, why: 'doc-inaccessible:' + String(e).slice(0, 60) }; }
  if (!d || !w) return { ok: false, level: 0, iframe: true, why: 'doc-not-ready' };
  const title = d.querySelector('.title-input__inner');
  const pm = d.querySelector('.tiptap.ProseMirror');
  const counter = d.querySelector('.counter');
  const btnTexts = Array.from(d.querySelectorAll('.publish-footer button')).map((b) => (b.textContent || '').trim());
  const buttons = Array.from(d.querySelectorAll('.publish-footer button')).map((b) => ({ text: (b.textContent || '').trim(), disabled: b.disabled || b.getAttribute('aria-disabled') === 'true' || b.classList.contains('disabled') }));
  const editorObj = w.editor && typeof w.editor === 'object' ? w.editor : null;
  const hasEditor = !!editorObj && typeof editorObj.commands === 'object' && editorObj.commands !== null;
  return {
    ok: !!(title && pm && hasEditor),
    level: title && pm ? 2 : 1,
    iframe: true,
    url: (w.location && w.location.href || '').slice(0, 160),
    hasTitle: !!title,
    hasProseMirror: !!pm,
    hasEditor,
    editorHasSetContent: hasEditor ? typeof editorObj.commands.setContent === 'function' : false,
    counter: counter ? (counter.textContent || '').trim() : '',
    publishButtons: buttons,
    footerText: btnTexts.join('|'),
  };
})()`;

// iframe 内账号预检诊断：读 opus_init_check verify + PrecheckTip 文案
const VERIFY_EXPR = `(async () => {
  const f = document.querySelector('iframe[src*="york/read-editor"]');
  const d = f && f.contentDocument;
  const w = f && f.contentWindow;
  const out = {};
  try {
    if (w) {
      const r = await w.fetch(${JSON.stringify(OPUS_INIT_CHECK_URL)}, { credentials: 'include' }).then((x) => x.json());
      out.opusInitCheck = { code: r.code, verify: r.data && r.data.verify, config: r.data && r.data.config ? Object.keys(r.data.config) : null };
    }
  } catch (e) { out.opusInitCheckError = String(e).slice(0, 120); }
  if (d) {
    const tip = d.querySelector('[class*="precheck" i]') || d.querySelector('.publish-footer');
    out.precheckTip = tip ? (tip.innerText || '').trim().slice(0, 300) : '';
    out.skeleton = {
      titleInput: !!d.querySelector('.title-input__inner'),
      prosemirror: !!d.querySelector('.tiptap.ProseMirror'),
      editorContainer: !!d.querySelector('.editor-container'),
      toolbarChildren: (d.querySelector('.toolbar')?.children.length) ?? -1,
    };
  }
  out.topUrl = location.href.slice(0, 160);
  return { ok: true, ...out };
})()`;

// iframe 内执行模板：body 为 (w, d) => 函数体
function frameExpr(body) {
  return `(() => {
    const f = document.querySelector('iframe[src*="york/read-editor"]');
    if (!f) return { ok: false, why: 'no-iframe' };
    const w = f.contentWindow, d = f.contentDocument;
    if (!d || !w) return { ok: false, why: 'no-doc' };
    const r = (${body})(w, d);
    return r.ok !== undefined ? r : { ok: true, data: r };
  })()`;
}

// 标题注入：textarea 设 value + input 事件（Vue v-model），回读校验
function titleInjectExpr(title) {
  return frameExpr(`(w, d) => {
    const ta = d.querySelector('.title-input__inner');
    if (!ta) return { ok: false, why: 'no-title-input' };
    ta.focus();
    ta.value = ${JSON.stringify(title)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const readback = ta.value;
    return { ok: readback === ${JSON.stringify(title)}, readback, len: readback.length };
  }`);
}

// 正文注入：首选 window.editor.commands.setContent(html)；备选 ProseMirror 聚焦 + ClipboardEvent paste
function contentInjectExpr(html, text) {
  return frameExpr(`(w, d) => {
    const html = ${JSON.stringify(html)};
    const text = ${JSON.stringify(text)};
    let method = '';
    if (w.editor && typeof w.editor.commands.setContent === 'function') {
      w.editor.commands.setContent(html);
      method = 'setContent';
    } else {
      const pm = d.querySelector('.tiptap.ProseMirror');
      if (!pm) return { ok: false, why: 'no-prosemirror-for-paste' };
      pm.focus();
      const dt = new DataTransfer();
      dt.setData('text/html', html);
      dt.setData('text/plain', text);
      pm.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      method = 'paste-event';
    }
    const json = w.editor ? w.editor.getJSON() : null;
    const counter = d.querySelector('.counter');
    return { ok: true, method, counter: counter ? (counter.textContent || '').trim() : '', json };
  }`);
}

function countJson(stats, node) {
  if (!node || typeof node !== 'object') return;
  stats.total++;
  const t = node.type || 'unknown';
  stats.byType[t] = (stats.byType[t] || 0) + 1;
  if (t === 'heading' && node.attrs && node.attrs.level === 2) stats.h2++;
  if (t === 'codeBlock') stats.codeBlock++;
  if (t === 'table') stats.table++;
  if (t === 'text') stats.textLen += (node.text || '').length;
  if (node.content) for (const c of node.content) countJson(stats, c);
}

function freshStats() {
  return { total: 0, byType: {}, h2: 0, codeBlock: 0, table: 0, textLen: 0 };
}

// 发布按钮：定位 .publish-footer 内"发布"按钮，disabled 预检（读 PrecheckTip），点击一次
function publishClickExpr() {
  return frameExpr(`(w, d) => {
    const btns = Array.from(d.querySelectorAll('.publish-footer button'));
    const btn = btns.find((b) => (b.textContent || '').trim() === '发布') || btns.find((b) => (b.textContent || '').includes('发布'));
    if (!btn) return { ok: false, why: 'no-publish-button', texts: btns.map((b) => (b.textContent || '').trim()) };
    const disabled = btn.disabled || btn.getAttribute('aria-disabled') === 'true' || btn.classList.contains('disabled');
    if (disabled) {
      const tip = d.querySelector('[class*="precheck" i]') || d.querySelector('.publish-footer');
      return { ok: false, why: 'publish-disabled', tipText: (tip ? tip.innerText || tip.textContent : '').trim().slice(0, 400) };
    }
    btn.click();
    return { ok: true, text: (btn.textContent || '').trim() };
  }`);
}

// 成功弹窗探针
const DIALOG_EXPR = frameExpr(`(w, d) => {
  const dl = d.querySelector('.publish-success-dialog');
  if (!dl) return { ok: false };
  const txt = (dl.innerText || '').trim();
  const btn = Array.from(dl.querySelectorAll('button, a, div')).find((b) => (b.textContent || '').trim() === '去看看');
  return { ok: txt.includes('提交成功'), text: txt.slice(0, 200), hasGoSee: !!btn };
}`);

// 点"去看看"
function goSeeExpr() {
  return frameExpr(`(w, d) => {
    const dl = d.querySelector('.publish-success-dialog');
    if (!dl) return { ok: false, why: 'no-dialog' };
    const btn = Array.from(dl.querySelectorAll('button, a, div')).find((b) => (b.textContent || '').trim() === '去看看');
    if (!btn) return { ok: false, why: 'no-gosee-button', text: (dl.innerText || '').slice(0, 200) };
    btn.click();
    return { ok: true };
  }`);
}

// 父页面管理页状态探针
const MANAGER_EXPR = `(() => {
  const loc = location.href;
  const frames = Array.from(document.querySelectorAll('iframe')).map((f) => ({ id: f.id || '', src: (f.src || '').slice(0, 120) }));
  return { ok: loc.includes('upload-manager'), url: loc.slice(0, 160), frames };
})()`;

// 管理页稿件列表 dump（支持管理页 iframe 内）
const MANAGER_LIST_EXPR = `(() => {
  let t = document;
  const frames = Array.from(document.querySelectorAll('iframe'));
  const mgr = frames.find((f) => (f.id || '').includes('upload') || (f.src || '').includes('upload-manager'));
  if (mgr && mgr.contentDocument) t = mgr.contentDocument;
  const links = Array.from(t.querySelectorAll('a'))
    .map((a) => ({ href: (a.href || ''), text: (a.textContent || '').trim().slice(0, 80) }))
    .filter((l) => l.href.includes('/read/') || l.href.includes('/opus/') || l.href.includes('/article/'));
  const text = (t.body ? t.body.innerText : '').slice(0, 2000);
  return { ok: true, inFrame: t !== document, linkCount: links.length, links: links.slice(0, 12), text };
})()`;

function parseCounter(counterText) {
  const m = String(counterText || '').match(/(\d[\d,]*)\s*\/\s*(\d[\d,]*)/);
  if (!m) return null;
  return { cur: Number(m[1].replace(/,/g, '')), max: Number(m[2].replace(/,/g, '')) };
}

function stepsLog(steps) {
  const list = [];
  return {
    push(step, ok, detail) {
      list.push({ step, ok: !!ok, detail: String(detail).slice(0, 300) });
    },
    list,
  };
}

// ============ 登录取证（--probe）============
export async function probeEditor(browser, page, { logged } = {}) {
  const evidence = { mode: 'probe', logged, editorReady: false, page: null, iframe: null, injected: null, note: '' };
  log.info('bilibili', `[probe] 登录取证开始: 登录态=${logged ? '有效' : '无效'}`);
  const g = await page.goto(EDIT_URL, { timeoutMs: 60000 });
  evidence.page = { url: g.url, title: g.title };
  log.info('bilibili', `[probe] 已打开投稿页: url=${g.url} title=${g.title}`);
  await sleep(1500);

  const hasIframe = await page.evalJs(`!!document.querySelector('iframe[src*="york/read-editor"]')`);
  evidence.iframe = { present: hasIframe };
  log.info('bilibili', `[probe] 编辑器 iframe 存在: ${hasIframe}`);

  if (!hasIframe) {
    evidence.note = '未发现编辑器 iframe（未登录时外壳会被弹去登录页，符合调研 S-B1/坑位 1 空壳预期）';
    log.warn('bilibili', `[probe] ${evidence.note} 顶层URL=${g.url}`);
    const skeleton = await probeEditorSkeleton(page);
    evidence.skeleton = skeleton;
    fs.mkdirSync(path.dirname(PROBE_FILE), { recursive: true });
    fs.writeFileSync(PROBE_FILE, JSON.stringify(evidence, null, 2), 'utf8');
    return evidence;
  }

  let ready = null;
  try {
    ready = await pollUntil(page, READY_EXPR, '投稿页编辑器就绪(ProseMirror+window.editor)', { timeoutMs: 45000 });
    evidence.iframe = { ...evidence.iframe, ...ready };
    evidence.editorReady = true;
    log.info('bilibili', `[probe] 编辑器就绪实证: hasTitle=${ready.hasTitle} hasProseMirror=${ready.hasProseMirror} hasEditor=${ready.hasEditor} setContent=${ready.editorHasSetContent} counter="${ready.counter}" footer=[${ready.footerText}]`);
  } catch (e) {
    log.warn('bilibili', `[probe] 编辑器未就绪: ${e.message}`);
    const diag = await page.evalJs(VERIFY_EXPR).catch((err) => ({ ok: true, diagError: String(err).slice(0, 120) }));
    evidence.iframe = { ...evidence.iframe, diag };
    evidence.note = '编辑器未就绪（无 .ProseMirror / window.editor）→ 登录态失效或账号预检未过（坑位 1）';
    log.error('bilibili', `[probe] 就绪诊断: topUrl=${diag.topUrl} skeleton=${JSON.stringify(diag.skeleton)} opusInit=${JSON.stringify(diag.opusInitCheck)} precheckTip="${diag.precheckTip}"`);
    fs.mkdirSync(path.dirname(PROBE_FILE), { recursive: true });
    fs.writeFileSync(PROBE_FILE, JSON.stringify(evidence, null, 2), 'utf8');
    return evidence;
  }

  const shot = await page.screenshot(path.join(PROJECT_ROOT, 'output', 'screenshots', 'editor-probe.png'));
  log.info('bilibili', `[probe] 就绪页截图: ${shot}`);

  let title = '';
  let artHtml = '';
  if (fs.existsSync(DEFAULT_META)) {
    title = JSON.parse(fs.readFileSync(DEFAULT_META, 'utf8')).title || '';
  }
  if (fs.existsSync(DEFAULT_ART)) artHtml = fs.readFileSync(DEFAULT_ART, 'utf8');
  if (!title || !artHtml) {
    log.warn('bilibili', '[probe] 转换产物缺失，跳过注入实证（仍完成就绪实证）');
    evidence.injected = { skipped: true };
  } else {
    const t = await page.evalJs(titleInjectExpr(title));
    log.info('bilibili', `[probe] 标题注入实证: ok=${t.ok} len=${t.len}`);
    const c = await page.evalJs(contentInjectExpr(artHtml, stripTags(artHtml)));
    const stats = c.json ? (() => { const s = freshStats(); countJson(s, c.json); return s; })() : null;
    log.info('bilibili', `[probe] 正文注入实证: method=${c.method} counter="${c.counter}" json节点=${stats ? JSON.stringify(stats) : 'null'}`);
    const counterNum = parseCounter(c.counter);
    evidence.injected = { title: { ok: t.ok, len: t.len }, content: { ok: c.ok, method: c.method, counter: c.counter, withinLimit: counterNum ? counterNum.cur <= MAX_ARTICLE_LEN : null, jsonStats: stats } };
    const shot2 = await page.screenshot(path.join(PROJECT_ROOT, 'output', 'screenshots', 'editor-probe-injected.png'));
    log.info('bilibili', `[probe] 注入后截图: ${shot2}`);
  }
  evidence.note = '登录取证完成：编辑器就绪信号（.ProseMirror + window.editor.commands.setContent）实测可用；未点击发布';
  fs.mkdirSync(path.dirname(PROBE_FILE), { recursive: true });
  fs.writeFileSync(PROBE_FILE, JSON.stringify(evidence, null, 2), 'utf8');
  log.info('bilibili', `[probe] 取证报告已写入: ${PROBE_FILE}`);
  return evidence;
}

// 未登录空壳实证：直接打开 york/read-editor（调研 S-B1.2：未登录不跳转、渲染骨架）
async function probeEditorSkeleton(page) {
  const EDITOR_APP_URL = 'https://member.bilibili.com/york/read-editor';
  log.info('bilibili', `[probe] 直接打开编辑器应用（未登录骨架实证）: ${EDITOR_APP_URL}`);
  const g = await page.goto(EDITOR_APP_URL, { timeoutMs: 60000 });
  await sleep(3000);
  const dump = await page.evalJs(`(() => {
    const q = (s) => !!document.querySelector(s);
    const btnTexts = Array.from(document.querySelectorAll('.publish-footer button')).map((b) => (b.textContent || '').trim());
    const buttons = Array.from(document.querySelectorAll('.publish-footer button')).map((b) => ({ text: (b.textContent || '').trim(), disabled: b.disabled || b.getAttribute('aria-disabled') === 'true' || b.classList.contains('disabled') }));
    const counter = document.querySelector('.counter');
    return {
      url: location.href.slice(0, 160),
      title: document.title,
      titleInput: q('.title-input__inner'),
      prosemirror: q('.tiptap.ProseMirror'),
      editorContainer: q('.editor-container'),
      toolbarChildren: document.querySelector('.toolbar') ? document.querySelector('.toolbar').children.length : -1,
      windowEditor: typeof window.editor,
      counter: counter ? (counter.textContent || '').trim() : '',
      publishButtons: buttons,
      footerText: btnTexts.join('|'),
    };
  })()`).catch((e) => ({ evalError: String(e).slice(0, 200) }));
  log.info('bilibili', `[probe] 编辑器应用骨架实测: ${JSON.stringify(dump)}`);
  const shot = await page.screenshot(path.join(PROJECT_ROOT, 'output', 'screenshots', 'editor-skeleton.png')).catch(() => '');
  if (shot) log.info('bilibili', `[probe] 骨架截图: ${shot}`);
  return { appUrl: g.url, dump };
}

// ============ 一键发布全链（browser/page 由调用方提供，登录已就绪）============
export async function runPublish(browser, { source = DEFAULT_ART, meta = DEFAULT_META, steps } = {}) {
  const st = steps || stepsLog();
  const page = browser.getActivePage() || browser.pages.values().next().value;
  {
    const info = await checkLogin(page);
    st.push('登录确认', info.logged, `uid=${info.uid} uname=${info.uname}`);
    if (!info.logged) throw new Error(`登录态无效 [步骤=登录确认, code=${info.code}]`);

    const g = await page.goto(EDIT_URL, { timeoutMs: 60000 });
    st.push('打开投稿页', true, g.url);
    const ready = await pollUntil(page, READY_EXPR, '投稿页编辑器就绪(ProseMirror+window.editor)', { timeoutMs: 60000 });
    st.push('编辑器就绪', true, `counter=${ready.counter} footer=[${ready.footerText}]`);

    const metaJson = JSON.parse(fs.readFileSync(meta, 'utf8'));
    const title = metaJson.title || '';
    if (!title || title.length < 2 || title.length > 40) {
      throw new Error(`标题校验失败 [步骤=标题注入, 标题="${title}" ${title.length}字, 要求 2~40 字]`);
    }
    const artHtml = fs.readFileSync(source, 'utf8');
    const chars = countChars(artHtml);
    if (chars.noWs > MAX_ARTICLE_LEN) {
      throw new Error(`正文超限 [步骤=正文注入, 纯文本 ${chars.noWs} 字 > ${MAX_ARTICLE_LEN}]`);
    }

    const t = await page.evalJs(titleInjectExpr(title));
    if (!t.ok) throw new Error(`标题注入失败 [步骤=标题注入, 回读="${t.readback}" 期望="${title}"]`);
    st.push('标题注入', true, `len=${t.len} 回读一致`);

    await sleep(randBetween(3000, 5000));
    const c = await page.evalJs(contentInjectExpr(artHtml, stripTags(artHtml)));
    if (!c.ok) throw new Error(`正文注入失败 [步骤=正文注入, 原因=${c.why}]`);
    const stats = freshStats();
    countJson(stats, c.json);
    const counterNum = parseCounter(c.counter);
    st.push('正文注入', true, `method=${c.method} counter=${c.counter} h2=${stats.h2} codeBlock=${stats.codeBlock} table=${stats.table} 文本${stats.textLen}字`);
    if (!counterNum || counterNum.cur > MAX_ARTICLE_LEN) {
      throw new Error(`字数复检失败 [步骤=字数复检, counter="${c.counter}" 要求 ≤${MAX_ARTICLE_LEN}]（坑位 2：正文未进 Tiptap doc）`);
    }
    if (stats.table === 0 && artHtml.includes('<table>')) {
      log.warn('bilibili', 'getJSON 无 table 节点，触发表格降级预案（本轮按转换产物原样发布，降级重转换留待后续）');
      st.push('表格降级检查', false, 'getJSON 无 table 节点');
    }

    await sleep(randBetween(3000, 5000));
    const p = await page.evalJs(publishClickExpr());
    if (!p.ok) {
      if (p.why === 'publish-disabled') {
        throw new Error(`发布按钮禁用 [步骤=发布, 原因=账号预检未过, PrecheckTip="${p.tipText}"]（等级不足/未实名/封禁，坑位 4）`);
      }
      throw new Error(`发布按钮定位失败 [步骤=发布, 原因=${p.why}, 按钮=${JSON.stringify(p.texts)}]`);
    }
    st.push('点击发布', true, `按钮文本="${p.text}"`);

    let dialog = null;
    try {
      dialog = await pollUntil(page, DIALOG_EXPR, '发布成功弹窗(.publish-success-dialog)', { timeoutMs: 90000, intervalMs: 800 });
      st.push('成功弹窗', true, dialog.text.slice(0, 120));
    } catch (e) {
      const diag = await page.evalJs(VERIFY_EXPR).catch((err) => ({ verifyError: String(err).slice(0, 120) }));
      throw new Error(`发布结果未知 [步骤=成功弹窗, ${e.message}, 诊断=${JSON.stringify(diag).slice(0, 400)}]`);
    }

    await sleep(randBetween(1500, 3000));
    const gs = await page.evalJs(goSeeExpr());
    if (!gs.ok) log.warn('bilibili', `[核验] 点"去看看"失败: ${gs.why}，改为直接访问管理页`);
    st.push('点击去看看', gs.ok, gs.why || 'ok');

    const verify = await verifyPublished(browser, page, title, st);
    const result = {
      success: true,
      title,
      url: verify.url,
      note: verify.note,
      visible: verify.visible,
      publishedAt: new Date().toISOString(),
      steps: st.list,
    };
    fs.mkdirSync(path.dirname(REPORT_FILE), { recursive: true });
    fs.writeFileSync(REPORT_FILE, JSON.stringify(result, null, 2), 'utf8');
    log.info('bilibili', `发布成功，结果已写入: ${REPORT_FILE} url=${verify.url}`);
    return result;
  }
}

// ============ 结果核验（T-B2e/T-B4a，坑位 5：提交成功≠已上线）============
async function verifyPublished(browser, page, title, st) {
  let manager = null;
  try {
    manager = await pollUntil(page, MANAGER_EXPR, '管理页跳转(upload-manager)', { timeoutMs: 30000, intervalMs: 500 });
    st.push('管理页跳转', true, manager.url);
  } catch (e) {
    log.warn('bilibili', `[核验] 管理页未自动跳转: ${e.message}，改用新标签直接访问`);
    const p2 = await browser.newPage(MANAGER_URL);
    await sleep(6000);
    manager = { url: MANAGER_URL, frames: [] };
    const list = await p2.evalJs(MANAGER_LIST_EXPR).catch((err) => ({ ok: true, error: String(err).slice(0, 120) }));
    st.push('管理页访问', true, '新标签直达');
    return await pickFromList(p2, list, title, st);
  }

  const list = await page.evalJs(MANAGER_LIST_EXPR);
  return await pickFromList(page, list, title, st);
}

async function pickFromList(page, list, title, st) {
  if (!list || list.links.length === 0) {
    const txt = (list && list.text || '').replace(/\s+/g, ' ').slice(0, 300);
    st.push('稿件定位', false, `管理列表无稿件链接, 页面文本=${txt}`);
    log.warn('bilibili', `[核验] 管理列表未定位到稿件链接（管理页 DOM 结构与预期不同，实况已记录）`);
    return { url: null, visible: null, note: '管理列表未定位到稿件链接（管理页结构实况记录在日志），提交成功弹窗已确认' };
  }
  const matched = list.links.find((l) => l.text.includes(title) || title.includes(l.text.trim()));
  const target = matched || list.links[0];
  st.push('稿件定位', true, `url=${target.href} text=${target.text}`);
  log.info('bilibili', `[核验] 稿件定位: ${target.href} "${target.text}" (${matched ? '标题匹配' : '取列表第一条'})`);

  const m = target.href.match(/read\/cv(\d+)/);
  let apiTitle = null;
  if (m) {
    try {
      const r = await page.evalJs(`fetch(${JSON.stringify(`https://api.bilibili.com/x/article/creative/article/view?aid=${m[1]}`)}, { credentials: 'include' }).then((x) => x.json())`);
      apiTitle = r.data && (r.data.title || (r.data.article && r.data.article.title));
      st.push('接口核验', !!apiTitle, `article/view aid=${m[1]} title="${apiTitle || ''}"`);
    } catch (e) {
      st.push('接口核验', false, e.message.slice(0, 120));
    }
  }

  let visible = null;
  let note = `已提交成功，稿件 ${target.href}`;
  const p2 = await page.newTab(target.href).catch(() => null);
  if (p2) {
    await sleep(4000);
    const body = await p2.evalJs(`({ url: location.href, title: document.title, text: (document.body.innerText || '').slice(0, 3000) })`).catch(() => null);
    if (body) {
      const hit = KEYWORDS.filter((k) => body.text.includes(k));
      const titleOk = body.title.includes(title) || body.text.includes(title);
      visible = titleOk && hit.length > 0;
      note = `提交成功，稿件 ${target.href}；详情页断言 title=${titleOk} 关键字=${hit.join('/')} → visible=${visible}`;
      st.push('详情断言', !!visible, note);
      log.info('bilibili', `[核验] 详情页: url=${body.url} title="${body.title}" 关键字命中=${hit.join('/') || '无'} visible=${visible}`);
    } else {
      st.push('详情断言', false, '详情页打开失败（可能审核中/未上线）');
      note = `提交成功，稿件 ${target.href}；详情页暂不可见（审核中，坑位 5）`;
    }
  } else {
    st.push('详情断言', false, '新标签打开失败');
  }
  if (apiTitle && apiTitle === title) {
    visible = visible === false ? false : true;
    note = `${note}；接口 title="${apiTitle}" 与服务端一致`;
  }
  return { url: target.href, visible, note };
}

// ============ CLI 入口 ============
async function main() {
  const argv = process.argv.slice(2);
  const probe = argv.includes('--probe');
  const noClose = argv.includes('--no-close');
  const getOpt = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
  };
  const source = getOpt('--source') || DEFAULT_ART;
  const meta = getOpt('--meta') || DEFAULT_META;

  const logger = createLogger('bilibili-publish', { level: 'INFO', file: path.join(PROJECT_ROOT, 'output', 'logs', `bilibili-publish-${fileStamp()}.log`) });
  setLogger(logger);
  log = logger;

  let browser = null;
  try {
    browser = await launchEdge(loadConfig());
    const page = await browser.newPage();
    const logged = await loadLogin(browser, page);

    if (probe) {
      log.info('bilibili', '[probe] 登录取证模式：只验证编辑器就绪与注入能力，不发布');
      await probeEditor(browser, page, { logged });
      return 0;
    }

    if (!logged) {
      log.info('bilibili', '未登录，进入扫码登录（等待用户扫码；二维码截图 output/qrcode.png）');
      await ensureLogin(browser, page);
      const count = await browser.cookieSave(COOKIE_FILE);
      log.info('bilibili', `扫码登录完成，cookie 已保存: ${COOKIE_FILE} (count=${count})`);
    }
    const result = await runPublish(browser, { source, meta });
    console.log(JSON.stringify(result));
    return 0;
  } catch (e) {
    log.error('bilibili', `发布流程失败: ${e.message}`);
    return 1;
  } finally {
    if (browser && !noClose) await browser.close().catch(() => {});
  }
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isCli) {
  main().then((code) => {
    process.exitCode = code;
  });
}
