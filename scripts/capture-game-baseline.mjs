#!/usr/bin/env node
// 页面基线采集脚本（Phase 0）。
//
// 用途：
//   在【用户本机】用真实 Chromium 打开未登录的游戏主页，采集脱敏的 DOM 契约、
//   network 元数据、console 输出、页面 HTML 与整页截图，供后续选择器改动和
//   DOM fixture 建立使用。
//
// 硬性约束（与审计文档第 8 节一致）：
//   - 不要登录，不要点击 #joinBtn，不要填任何账号信息。
//   - 不导出一级 Cookie、localStorage/sessionStorage 全量、OAuth code/token/state、
//     浏览器用户目录或身份信息。
//   - 站点可能对云端/代理出口返回 403；本脚本必须在用户本机浏览器运行，而非 CI。
//
// 依赖：`npm i -D playwright`（首次）。之后运行 `npm run capture:baseline`。
import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "artifacts", "game-baseline");
const GAME_URL = "https://grasp-rat-game.h-e.top/";

await fs.mkdir(outDir, { recursive: true });

// 延迟;headless:false 保证是真实浏览器实例,与云端抓取环境不同。
const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  locale: "zh-CN"
});
const page = await context.newPage();

const responses = [];
const consoleMessages = [];
const pageErrors = [];

const SAFE_URL_KEYS = new Set([
  "url", "status", "method", "resourceType", "contentType", "frameUrl"
]);

page.on("response", res => {
  const req = res.request();
  responses.push({
    url: req.url(),
    status: res.status(),
    method: req.method(),
    resourceType: req.resourceType(),
    contentType: res.headers()["content-type"] || "",
    frameUrl: req.frame() ? req.frame().url() : ""
  });
});
page.on("console", msg => {
  consoleMessages.push({ type: msg.type(), text: msg.text() });
});
page.on("pageerror", err => {
  pageErrors.push(String(err && (err.stack || err.message) || err));
});

// 计算是否命中游戏主页(供探测网络连通性)。

try {
  await page.goto(GAME_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
} catch (err) {
  console.error("[baseline] goto 失败(可能是云端 403 或网络不通):", err.message);
  // 仍尝试保存部分信息
}
await page.waitForTimeout(5_000);

const baseline = await page.evaluate(() => {
  const visible = el => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0
      && style.display !== "none" && style.visibility !== "hidden";
  };
  const describe = el => el ? ({
    tagName: el.tagName,
    id: el.id || null,
    className: String(el.className || ""),
    text: String(el.innerText || el.textContent || "").trim(),
    href: el.getAttribute("href"),
    type: el.getAttribute("type"),
    role: el.getAttribute("role"),
    outerHTML: el.outerHTML,
    visible: visible(el)
  }) : null;

  return {
    url: location.href,
    origin: location.origin,
    pathname: location.pathname,
    title: document.title,
    readyState: document.readyState,
    joinButton: describe(document.getElementById("joinBtn")),
    buttons: [...document.querySelectorAll("button")].filter(visible).map(describe),
    links: [...document.querySelectorAll("a[href]")].filter(visible).map(describe),
    forms: [...document.forms].map(f => ({
      action: f.action,
      method: f.method,
      id: f.id || null,
      outerHTML: f.outerHTML
    })),
    scripts: [...document.scripts].map(s => ({ src: s.src || null, type: s.type || null })),
    meta: [...document.querySelectorAll("meta")].map(m => ({
      name: m.name || null,
      httpEquiv: m.httpEquiv || null,
      content: m.content || null
    }))
  };
}).catch(err => ({ error: String(err && (err.message || err)) }));

// 采集结果去敏感字段后再落盘。
const meta = {
  capturedAt: new Date().toISOString(),
  gameUrl: GAME_URL,
  exporter: "capture-game-baseline.mjs",
  notes: "未登录、未点击任何按钮;不包含 Cookie/token/凭据。"
};

const safeResponses = responses
  .filter(r => r.url && typeof r.url === "string")
  .map(r => {
    // 只保留域名与路径,剥掉任何查询参数里的 code/token/state 类痕迹(未登录页一般没有)。
    return { ...r, url: plainUrl(r.url) };
  });

function plainUrl(raw) {
  try {
    const u = new URL(raw);
    u.search = "";
    u.hash = "";
    return u.href;
  } catch {
    return String(raw).replace(/[?&#].*$/, "");
  }
}

await fs.writeFile(path.join(outDir, "unauth-contract.json"), JSON.stringify(baseline, null, 2));
await fs.writeFile(path.join(outDir, "network.json"), JSON.stringify(safeResponses, null, 2));
await fs.writeFile(path.join(outDir, "console.json"), JSON.stringify({ console: consoleMessages, pageErrors }, null, 2));
await fs.writeFile(path.join(outDir, "page.html"), await page.content());
await page.screenshot({ path: path.join(outDir, "page.png"), fullPage: true }).catch(() => {});

console.log("=== 未登录游戏页基线(脱敏) ===");
console.log(JSON.stringify(baseline, null, 2));
console.log("\n已保存到", outDir);
console.log("真实浏览器 HTTP 状态(应 200,而非云端 403):",
  responses.find(r => r.url === GAME_URL)?.status ?? "(未记录)");

await browser.close();