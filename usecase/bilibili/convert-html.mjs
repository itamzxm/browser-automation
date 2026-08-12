// convert-html.mjs — B 站专栏受限 HTML 片段转换器（零依赖）
// 用法：node convert-html.mjs <源html> <输出html> [--selftest]
// 导出：parseHtml / convert / selfCheck / runSelfTest（供 publish.mjs import）
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

function parseAttrs(str) {
  const attrs = {};
  const re = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(str))) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return attrs;
}

export function tokenize(html) {
  const tokens = [];
  let pos = 0;
  const len = html.length;
  while (pos < len) {
    const lt = html.indexOf('<', pos);
    if (lt === -1) {
      if (pos < len) tokens.push({ type: 'text', text: html.slice(pos) });
      break;
    }
    if (lt > pos) tokens.push({ type: 'text', text: html.slice(pos, lt) });
    const c = html[lt + 1];
    if (c === '!') {
      if (html.startsWith('<!--', lt)) {
        const end = html.indexOf('-->', lt + 4);
        if (end === -1) { tokens.push({ type: 'text', text: html.slice(lt) }); break; }
        tokens.push({ type: 'comment', text: html.slice(lt + 4, end) });
        pos = end + 3;
        continue;
      }
      const end = html.indexOf('>', lt);
      if (end === -1) { tokens.push({ type: 'text', text: html.slice(lt) }); break; }
      tokens.push({ type: 'doctype', text: html.slice(lt, end + 1) });
      pos = end + 1;
      continue;
    }
    if (c === '/') {
      const m = html.slice(lt + 1).match(/^\s*\/\s*([a-zA-Z][a-zA-Z0-9-]*)\s*>/);
      if (m) { tokens.push({ type: 'close', name: m[1].toLowerCase() }); pos = lt + 1 + m[0].length; continue; }
      tokens.push({ type: 'text', text: '<' });
      pos = lt + 1;
      continue;
    }
    const m = html.slice(lt + 1).match(/^\s*([a-zA-Z][a-zA-Z0-9-]*)/);
    if (!m) { tokens.push({ type: 'text', text: '<' }); pos = lt + 1; continue; }
    const name = m[1].toLowerCase();
    const restStart = lt + 1 + m[0].length;
    let i = restStart;
    let quote = null;
    while (i < len) {
      const ch = html[i];
      if (quote) { if (ch === quote) quote = null; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '>') break;
      i++;
    }
    if (i >= len) { tokens.push({ type: 'text', text: html.slice(lt) }); break; }
    const inner = html.slice(restStart, i).trim();
    const selfClose = inner.endsWith('/');
    const attrStr = selfClose ? inner.slice(0, -1) : inner;
    const attrs = parseAttrs(attrStr);
    if (selfClose || VOID_TAGS.has(name)) {
      tokens.push({ type: 'selfClose', name, attrs });
    } else {
      tokens.push({ type: 'open', name, attrs });
    }
    pos = i + 1;
  }
  return tokens;
}

export function buildTree(tokens) {
  const root = { type: 'element', name: '#root', attrs: {}, children: [] };
  const stack = [root];
  let pending = '';
  const flush = () => {
    if (pending) { stack[stack.length - 1].children.push({ type: 'text', text: pending }); pending = ''; }
  };
  for (const t of tokens) {
    if (t.type === 'text') { pending += t.text; continue; }
    flush();
    if (t.type === 'open') {
      const el = { type: 'element', name: t.name, attrs: t.attrs, children: [] };
      stack[stack.length - 1].children.push(el);
      stack.push(el);
    } else if (t.type === 'selfClose') {
      stack[stack.length - 1].children.push({ type: 'element', name: t.name, attrs: t.attrs, children: [], selfClose: true });
    } else if (t.type === 'close') {
      for (let k = stack.length - 1; k >= 1; k--) {
        if (stack[k].name === t.name) { stack.length = k; break; }
      }
    }
  }
  flush();
  return root;
}

export function parseHtml(html) {
  return buildTree(tokenize(html));
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isNaN(code) ? m : String.fromCodePoint(code);
    }
    return ENT[name] ?? m;
  });
}

function encText(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function encAttr(s) {
  return encText(s).replace(/"/g, '&quot;');
}

function clsOf(node) {
  return node.attrs.class || '';
}

function textOf(node) {
  if (node.type === 'text') return node.text;
  if (node.type === 'element') return decodeEntities(node.children.map(textOf).join(''));
  return '';
}

function cleanText(raw) {
  const noEmoji = raw.replace(/\p{Extended_Pictographic}/gu, '');
  return noEmoji.replace(/[\r\n\t\u00a0 ]{2,}/g, ' ').trim();
}

function freshStats() {
  return { h2: 0, h3: 0, p: 0, pre: 0, table: 0, quote: 0, ul: 0, ol: 0, li: 0, link: 0, img: 0, code: 0, details: 0, h2Titles: [] };
}

function renderChildrenToString(node, meta) {
  const tmp = [];
  for (const c of node.children) renderNode(c, tmp, meta);
  return tmp.join('');
}

function renderChildren(node, out, meta) {
  for (const c of node.children) renderNode(c, out, meta);
}

function renderFlow(node, out, meta) {
  for (const child of node.children) {
    if (child.type !== 'element' || !clsOf(child).split(/\s+/).includes('flow-step')) continue;
    let badge = '';
    let t = '';
    let body = null;
    for (const c of child.children) {
      if (c.type !== 'element') continue;
      const cl = clsOf(c).split(/\s+/);
      if (cl.includes('flow-badge')) badge = textOf(c).trim();
      else if (cl.includes('flow-body')) {
        for (const cc of c.children) {
          if (cc.type !== 'element') continue;
          const ccl = clsOf(cc).split(/\s+/);
          if (ccl.includes('t')) t = textOf(cc).trim();
          else if (cc.name === 'p') body = cc;
        }
      }
    }
    const lead = badge ? `${badge} ${t}` : t;
    if (lead) out.push(`<p><b>${encText(lead)}</b></p>`);
    if (body) renderNode(body, out, meta);
  }
}

function renderTimeline(node, out, meta) {
  for (const child of node.children) {
    if (child.type !== 'element' || !clsOf(child).split(/\s+/).includes('tl-item')) continue;
    let phase = '';
    let title = '';
    let body = null;
    for (const c of child.children) {
      if (c.type !== 'element') continue;
      const cl = clsOf(c).split(/\s+/);
      if (cl.includes('tl-phase')) phase = textOf(c).trim();
      else if (cl.includes('tl-title')) title = textOf(c).trim();
      else if (cl.includes('tl-body')) body = c;
    }
    const head = [phase, title].filter(Boolean).join(' · ');
    if (head) {
      out.push(`<h3>${encText(head)}</h3>`);
      meta.stats.h3++;
    }
    if (body) renderNode(body, out, meta);
  }
}

function renderBigNum(node, out, meta) {
  for (const child of node.children) {
    if (child.type !== 'element' || !clsOf(child).split(/\s+/).includes('cell')) continue;
    let n = '';
    let l = '';
    for (const c of child.children) {
      if (c.type !== 'element') continue;
      const cl = clsOf(c).split(/\s+/);
      if (cl.includes('n')) n = textOf(c).trim();
      else if (cl.includes('l')) l = textOf(c).trim();
    }
    if (n) out.push(`<p><b>${encText(n)}</b>${l ? ' — ' + encText(l) : ''}</p>`);
  }
}

function renderSecHead(node, out, meta) {
  let num = '';
  for (const child of node.children) {
    if (child.type === 'element' && child.name === 'span' && clsOf(child).split(/\s+/).includes('sec-num')) {
      num = textOf(child).trim();
    }
  }
  for (const child of node.children) {
    if (child.type === 'element' && child.name === 'h2') {
      const t = textOf(child).replace(/\s+/g, ' ').trim();
      out.push(`<h2>${encText(num ? num + ' ' + t : t)}</h2>`);
      meta.stats.h2++;
      meta.stats.h2Titles.push(num ? num + ' ' + t : t);
    }
  }
}

function renderCard(node, out, meta) {
  let tag = '';
  for (const child of node.children) {
    if (child.type === 'element' && child.name === 'span' && clsOf(child).split(/\s+/).includes('tag')) {
      tag = textOf(child).trim();
    }
  }
  if (tag) out.push(`<p><b>${encText(tag)}</b></p>`);
  for (const child of node.children) {
    if (child.type !== 'element') continue;
    if (child.name === 'span' && clsOf(child).split(/\s+/).includes('tag')) continue;
    renderNode(child, out, meta);
  }
}

function renderHero(node, out, meta) {
  let h1Text = '';
  let kicker = null;
  const metaSpans = [];
  let tldr = null;
  const walk = (n) => {
    if (n.type !== 'element') return;
    if (n.name === 'h1' && !h1Text) {
      h1Text = textOf(n).replace(/\s+/g, ' ').trim();
    } else if ((n.name === 'p' || n.name === 'div') && clsOf(n).split(/\s+/).includes('kicker') && !kicker) {
      kicker = n;
    } else if (n.name === 'div' && clsOf(n).split(/\s+/).includes('meta') && !tldr) {
      for (const c of n.children) {
        if (c.type === 'element' && c.name === 'span') {
          const t = textOf(c).replace(/\s+/g, ' ').trim();
          if (t) metaSpans.push(t);
        }
      }
    } else if (n.name === 'div' && clsOf(n).split(/\s+/).includes('tldr') && !tldr) {
      tldr = n;
    }
    for (const c of n.children) walk(c);
  };
  walk(node);
  meta.title = h1Text;
  if (meta.title.length > 40) {
    meta.title = meta.title.slice(0, 40);
    meta.warnings.push('标题超 40 字，已截断');
  }
  if (meta.title.length < 2) meta.warnings.push('标题不足 2 字');
  if (kicker) out.push(`<p><i>${encText(textOf(kicker).replace(/\s+/g, ' ').trim())}</i></p>`);
  if (metaSpans.length) out.push(`<p>${encText(metaSpans.join(' · '))}</p>`);
  if (tldr) renderNode(tldr, out, meta);
}

function renderFooter(node, out, meta) {
  const texts = [];
  const walk = (n) => {
    if (n.type !== 'element') return;
    if (n.name === 'p') {
      const t = textOf(n).replace(/\s+/g, ' ').trim();
      if (t) texts.push(t);
    }
    for (const c of n.children) walk(c);
  };
  walk(node);
  if (texts.length) out.push(`<p>${encText(texts.join(' '))}</p>`);
}

function renderDetails(node, out, meta) {
  let q = '';
  for (const child of node.children) {
    if (child.type === 'element' && child.name === 'summary') {
      q = textOf(child).replace(/\s+/g, ' ').trim();
    }
  }
  if (q) {
    out.push(`<h3>Q ${encText(q)}</h3>`);
    meta.stats.h3++;
  }
  meta.stats.details++;
  for (const child of node.children) {
    if (child.type !== 'element') continue;
    if (child.name === 'summary') continue;
    renderNode(child, out, meta);
  }
}

function renderPre(node, out, meta) {
  const sb = [];
  const collect = (n) => {
    for (const c of n.children) {
      if (c.type === 'text') sb.push(c.text);
      else if (c.type === 'element') collect(c);
    }
  };
  collect(node);
  out.push(`<pre><code>${encText(decodeEntities(sb.join('')))}</code></pre>`);
  meta.stats.pre++;
}

export function renderNode(node, out, meta) {
  if (node.type === 'text') {
    const cleaned = cleanText(node.text);
    if (cleaned) out.push(encText(decodeEntities(cleaned)));
    return;
  }
  if (node.type !== 'element') return;
  const name = node.name;
  if (name === 'script' || name === 'style' || name === 'head' || name === 'nav' || name === 'template' || name === 'meta' || name === 'link' || name === 'title') return;
  if (name === 'header') { renderHero(node, out, meta); return; }
  if (name === 'footer') { renderFooter(node, out, meta); return; }
  if (name === 'section' || name === 'article' || name === 'main' || name === 'body' || name === 'html') { renderChildren(node, out, meta); return; }
  if (name === 'div' || name === 'span') {
    const cl = clsOf(node).split(/\s+/);
    if (cl.includes('sec-head')) { renderSecHead(node, out, meta); return; }
    if (cl.includes('card')) { renderCard(node, out, meta); return; }
    if (cl.includes('flow')) { renderFlow(node, out, meta); return; }
    if (cl.includes('timeline')) { renderTimeline(node, out, meta); return; }
    if (cl.includes('big-num')) { renderBigNum(node, out, meta); return; }
    if (cl.includes('src')) {
      const inner = renderChildrenToString(node, meta).trim();
      const t = inner.startsWith('依据：') ? inner : `依据：${inner}`;
      out.push(`<p><i>${t}</i></p>`);
      return;
    }
    if (cl.includes('tldr')) {
      const inner = renderChildrenToString(node, meta);
      out.push(`<p>${inner.trim()}</p>`);
      return;
    }
    renderChildren(node, out, meta);
    return;
  }
  if (name === 'h1') {
    const inner = renderChildrenToString(node, meta);
    out.push(`<h2>${inner.trim()}</h2>`);
    meta.stats.h2++;
    meta.stats.h2Titles.push(inner.trim());
    return;
  }
  if (name === 'h2') {
    const inner = renderChildrenToString(node, meta);
    out.push(`<h2>${inner.trim()}</h2>`);
    meta.stats.h2++;
    meta.stats.h2Titles.push(inner.trim());
    return;
  }
  if (name === 'h3' || name === 'h4' || name === 'h5' || name === 'h6') {
    const inner = renderChildrenToString(node, meta);
    out.push(`<${name}>${inner.trim()}</${name}>`);
    if (name === 'h3') meta.stats.h3++;
    return;
  }
  if (name === 'p') {
    const inner = renderChildrenToString(node, meta);
    const sub = clsOf(node).split(/\s+/).includes('sub');
    out.push(sub ? `<p><i>${inner.trim()}</i></p>` : `<p>${inner.trim()}</p>`);
    meta.stats.p++;
    return;
  }
  if (name === 'b' || name === 'strong') { out.push(`<b>${renderChildrenToString(node, meta).trim()}</b>`); return; }
  if (name === 'i' || name === 'em') { out.push(`<i>${renderChildrenToString(node, meta).trim()}</i>`); return; }
  if (name === 'u') { out.push(`<u>${renderChildrenToString(node, meta).trim()}</u>`); return; }
  if (name === 's' || name === 'del') { out.push(`<s>${renderChildrenToString(node, meta).trim()}</s>`); return; }
  if (name === 'code') {
    out.push(`<code>${encText(decodeEntities(textOf(node)))}</code>`);
    meta.stats.code++;
    return;
  }
  if (name === 'pre') { renderPre(node, out, meta); return; }
  if (name === 'ul' || name === 'ol') {
    const inner = renderChildrenToString(node, meta);
    out.push(`<${name}>${inner}</${name}>`);
    if (name === 'ul') meta.stats.ul++; else meta.stats.ol++;
    return;
  }
  if (name === 'li') {
    const inner = renderChildrenToString(node, meta);
    out.push(`<li>${inner.trim()}</li>`);
    meta.stats.li++;
    return;
  }
  if (name === 'blockquote') {
    const inner = renderChildrenToString(node, meta);
    out.push(`<blockquote>${inner.trim()}</blockquote>`);
    meta.stats.quote++;
    return;
  }
  if (name === 'table') {
    const inner = renderChildrenToString(node, meta);
    out.push(`<table>${inner}</table>`);
    meta.stats.table++;
    return;
  }
  if (name === 'tr') {
    const inner = renderChildrenToString(node, meta);
    out.push(`<tr>${inner}</tr>`);
    return;
  }
  if (name === 'th' || name === 'td') {
    const inner = renderChildrenToString(node, meta);
    out.push(`<${name}>${inner.trim()}</${name}>`);
    return;
  }
  if (name === 'a') {
    const inner = renderChildrenToString(node, meta).trim();
    const href = node.attrs.href;
    if (href) {
      out.push(`<a href="${encAttr(href)}">${inner || encText(href)}</a>`);
      meta.stats.link++;
    } else if (inner) {
      out.push(inner);
    }
    return;
  }
  if (name === 'br') { out.push('<br>'); return; }
  if (name === 'hr') { out.push('<hr>'); return; }
  if (name === 'img') {
    const alt = node.attrs.alt || '';
    const src = node.attrs.src || '';
    out.push(`[图片占位：${encText(alt || src || '未命名图片')}]`);
    meta.placeholders.push({ src, alt });
    meta.stats.img++;
    return;
  }
  if (name === 'details') { renderDetails(node, out, meta); return; }
  if (name === 'summary') return;
  renderChildren(node, out, meta);
}

export function convert(sourceHtml) {
  const root = parseHtml(sourceHtml);
  const meta = {
    title: '',
    source: '',
    convertedAt: new Date().toISOString(),
    stats: freshStats(),
    placeholders: [],
    warnings: [],
  };
  const htmlEl = root.children.find((c) => c.type === 'element' && c.name === 'html') || root;
  const bodyEl = htmlEl.children.find((c) => c.type === 'element' && c.name === 'body') || htmlEl;
  const out = [];
  for (const c of bodyEl.children) renderNode(c, out, meta);
  const raw = out.join('');
  const html = raw.replace(/>\s*</g, '>\n<').trim();
  return { html, meta };
}

export function stripTags(html) {
  return html.replace(/<[^>]+>/g, '');
}

export function countChars(html) {
  const text = stripTags(html);
  return { withWs: text.length, noWs: text.replace(/\s+/g, '').length, text };
}

export function selfCheck(html, meta) {
  const checks = [];
  const ok = (name, pass, detail) => checks.push({ name, pass, detail });
  const h2s = meta.stats.h2Titles;
  const nums = ['01', '02', '03', '04', '05', '06', '07', '08', '09'];
  ok('章节标题 h2=9 且 01~09 齐全', h2s.length === 9 && nums.every((n) => h2s.some((t) => t.startsWith(n))), `h2×${h2s.length}: ${h2s.map((t) => t.slice(0, 10)).join(' / ')}`);
  const chars = countChars(html);
  ok('纯文本字数 ≤100000', chars.noWs <= 100000, `${chars.noWs} 字（含空白 ${chars.withWs} 字）`);
  const emoji = chars.text.match(/\p{Extended_Pictographic}/gu) || [];
  ok('无 emoji 残留', emoji.length === 0, emoji.length ? emoji.join(',') : '无');
  const badTags = html.match(/<(nav|footer|header|script|style)\b/gi) || [];
  ok('无 nav/footer/header/script 标签', badTags.length === 0, badTags.join(',') || '无');
  const toc = chars.text.match(/#s[1-9]/g) || [];
  ok('无 toc 锚点残留', toc.length === 0, toc.length ? toc.join(',') : '无');
  const pair = (tag) => {
    const o = (html.match(new RegExp(`<${tag}\\b`, 'g')) || []).length;
    const c = (html.match(new RegExp(`</${tag}>`, 'g')) || []).length;
    return o === c ? o : `不平衡 open=${o} close=${c}`;
  };
  const pv = ['pre', 'table', 'blockquote', 'ul', 'ol'].map((t) => `${t}=${pair(t)}`).join(' ');
  ok('pre/table/blockquote/ul/ol 标签配对', ['pre', 'table', 'blockquote', 'ul', 'ol'].every((t) => typeof pair(t) === 'number'), pv);
  ok('标题 2~40 字', meta.title.length >= 2 && meta.title.length <= 40, `${meta.title.length} 字「${meta.title}」`);
  const s = meta.stats;
  ok('结构计数（pre=1 table=1 quote=1 ul=4 h3=11）', s.pre === 1 && s.table === 1 && s.quote === 1 && s.ul === 4 && s.h3 === 11, `pre=${s.pre} table=${s.table} quote=${s.quote} ul=${s.ul} h3=${s.h3} link=${s.link} code=${s.code} img=${s.img}`);
  return checks;
}

export function runSelfTest() {
  const sample = '<article><h1>占位样例</h1><img src="http://x/a.png" alt="架构图"><p>正文 <b>加粗</b> <i>斜体</i> 表情✨剔除</p><p style="font-size:30px;color:red">自定义字号内容</p><p>含实体 &lt;think&gt; 与 \\boxed{} 原样</p><table><tr><td>单元格</td></tr></table></article>';
  const r = convert(sample);
  const checks = [
    ['img 占位文本输出', r.html.includes('[图片占位：架构图]')],
    ['emoji 剔除', !r.html.includes('✨')],
    ['style 属性剥离', !r.html.includes('font-size') && !r.html.includes('color:')],
    ['占位清单登记', r.meta.placeholders.length === 1 && r.meta.placeholders[0].alt === '架构图'],
    ['table 节点保留', r.html.includes('<table>') && r.html.includes('<td>单元格</td>')],
    ['b/i 映射', r.html.includes('<b>加粗</b>') && r.html.includes('<i>斜体</i>')],
    ['实体反转义后重转义', r.html.includes('&lt;think&gt;')],
    ['boxed 字面保留', r.html.includes('\\boxed{}')],
  ];
  return checks;
}

function log(level, mod, msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}][${level}][${mod}] ${msg}`);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest') || argv[0] === 'selftest') {
    const checks = runSelfTest();
    let failed = 0;
    for (const [name, pass] of checks) {
      log(pass ? 'INFO' : 'ERROR', 'convert', `自测样例 ${name}: ${pass ? '通过' : '失败'}`);
      if (!pass) failed++;
    }
    log(failed ? 'ERROR' : 'INFO', 'convert', failed ? `自测样例 ${failed} 项失败` : '自测样例全部通过');
    process.exit(failed ? 1 : 0);
  }
  const [src, out] = argv;
  if (!src || !out) {
    log('ERROR', 'convert', '用法：node convert-html.mjs <源html> <输出html> [--selftest]');
    process.exit(2);
  }
  if (!fs.existsSync(src)) {
    log('ERROR', 'convert', `源文件不存在：${src}`);
    process.exit(1);
  }
  log('INFO', 'convert', `开始转换：${src}`);
  const sourceHtml = fs.readFileSync(src, 'utf8');
  const { html, meta } = convert(sourceHtml);
  meta.source = src;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html, 'utf8');
  const metaPath = `${out}.meta.json`;
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
  log('INFO', 'convert', `已输出 HTML：${out}（${Buffer.byteLength(html, 'utf8')} 字节）`);
  log('INFO', 'convert', `已输出 meta：${metaPath}`);
  const chars = countChars(html);
  log('INFO', 'convert', `标题「${meta.title}」${meta.title.length} 字；纯文本 ${chars.noWs} 字（含空白 ${chars.withWs}）`);
  const checks = selfCheck(html, meta);
  let failed = 0;
  for (const c of checks) {
    log(c.pass ? 'INFO' : 'ERROR', 'convert', `${c.name}: ${c.pass ? '通过' : '失败'}（${c.detail}）`);
    if (!c.pass) failed++;
  }
  for (const w of meta.warnings) log('WARN', 'convert', w);
  if (failed) {
    log('ERROR', 'convert', `自检 ${checks.length - failed}/${checks.length} 项通过，存在失败项，退出码 1`);
    process.exit(1);
  }
  log('INFO', 'convert', `自检 ${checks.length} 项全部通过，退出码 0`);
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isCli) main();
