# browser-automation

零第三方依赖的浏览器自动化内核（Node.js 内置 WebSocket 直连 Chromium/Edge 的 DevTools 协议，不用 Playwright/Selenium），附 B 站专栏发布用例。

## 特性

- **零依赖**：只有 Node.js 内置模块 + 全局 WebSocket（Node 22+），无 node_modules
- **驱动真实浏览器**：导航 / DOM 查询 / 点击 / 输入（中文安全）/ 等待 / 截图 / 执行 JS / Cookie 读写（含 HttpOnly）/ 多标签页
- **attach 模式**：浏览器常开调试端口时，直接连接正在运行的浏览器操作，用完仅断开连接、不关闭浏览器
- **用户真实数据目录**：通过 junction（Windows 目录联接）指向用户真实 profile，AI 与用户共用同一份登录态/收藏/历史（Chromium 禁止在默认目录上开调试端口，junction 绕过该限制）
- **B 站专栏发布用例**：HTML/Markdown 内容 → B 站专栏（自动登录检测/扫码引导 → 填标题正文 → 发布 → 拿文章 URL）
- 内核与用例解耦，可扩展任意网页操作任务

## 快速开始

```bash
node cli.mjs open <url>                  # 启动 Edge 并导航
node cli.mjs click <selector>            # 点击
node cli.mjs type <selector> <text>      # 输入（中文安全）
node cli.mjs js <code>                   # 执行 JS
node cli.mjs shot [--full] <file>        # 截图
node cli.mjs cookie-save <file>          # 保存 cookie
node cli.mjs close                       # 关闭浏览器

node tests/smoke/self-test.mjs           # 内核自测（17 项）
```

## JS API

```js
import { launchEdge, loadConfig } from './core/launcher.mjs';

const browser = await launchEdge(loadConfig());
const page = await browser.newPage('https://example.com');
await page.waitForElement('#btn');
await page.click('#btn');
await page.type('#input', '中文输入');
await page.screenshot('output/shot.png');
await browser.close();
```

常用方法：`goto(url)` / `waitForElement(sel, timeout)` / `waitForText(text)` / `click(sel)` / `type(sel, text)` / `evalJs(code)` / `screenshot(path, {fullPage})` / `getCookie(name)` / `newPage()` / `switchTab(i)`。

## B 站专栏发布

```bash
node usecase/bilibili/publish.mjs                 # 一键发布（默认发布 output/report/converted.html）
node usecase/bilibili/publish.mjs --source <html> # 指定源 HTML
node usecase/bilibili/publish.mjs --probe         # 登录取证模式（不发布）
```

- 登录态检测优先于 cookie 文件；未登录时打开 PC 登录页并截图二维码，扫码一次后登录态写入浏览器 profile（attach 模式与日常使用共用，之后免登录）
- 正文注入首选 `window.editor.commands.setContent()`（B 站编辑器为 Tiptap/ProseMirror），格式保真
- 退出码 0 = 成功，结果 JSON 写入 `output/report/publish-result.json`（含文章 URL）
- 发布成功 = 投稿页成功弹窗 + 稿件入管理列表（"提交成功"需审核，不等公开可见）

## 配置（config.json）

| 字段 | 默认 | 说明 |
|---|---|---|
| `browserPath` | 自动探测 Edge | 浏览器可执行文件路径 |
| `userDataDir` | `output/user-data/` | 用户数据目录；填真实 Edge 目录（如 `C:\Users\<you>\AppData\Local\Microsoft\Edge\User Data`）时自动创建 junction |
| `port` | `0`（自动选空闲端口） | CDP 调试端口；填固定端口（如 `9222`）则优先 attach 已运行实例 |
| `headless` | `false` | 无头模式 |

## 说明

- 运行前若目标 userDataDir 为浏览器真实目录，需先完全关闭该浏览器（脚本检测锁并提示）
- 只做自动化，不含验证码破解/反爬对抗/批量采集
- 未登录/登录态失效会自动进入扫码引导（真人扫码，不绕过风控）
- B 站投稿页为 SPA + iframe 结构，脚本按 `iframe[src*="york/read-editor"]` 定位编辑器（iframe 无稳定 id）
