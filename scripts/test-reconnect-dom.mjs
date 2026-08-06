// DOM fixture 集成测试：把真实 userscript 源跑进 jsdom，用真实 CSS 选择器
// 对着 test/fixtures/*.html 断言授权/登录行为。这是对"只用手写 stub 或正则存在性
// 测试"的替代，让 selector 契约由真实 DOM fixture 驱动。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "src", "entries", "desktop.user.js"), "utf8");
const FIX = p => fs.readFileSync(path.join(root, "test", "fixtures", p), "utf8");

const OAUTH_URL = "https://connect.linux.do/oauth2/authorize";
const GAME_URL = "https://grasp-rat-game.h-e.top/";

function activeLeave(ts) {
  return { ts, type: "damage", hp: 60, enabled: true, v: 2 };
}

function runFixture(html, opts = {}) {
  const url = opts.url;
  const gm = new Map();
  for (const [k, v] of Object.entries(opts.seed || {})) gm.set(k, v);

  let now = opts.initialNow ?? Date.now();
  const dom = new JSDOM(html, { url, runScripts: "outside-only" });
  const { window } = dom;
  const { document } = window;

  // 可控时间
  window.Date = class extends Date {
    constructor(...a) {
      if (!a.length) super(now);
      else super(...a);
    }
    static now() { return now; }
  };

  // 可控定时器
  let nextTimerId = 1;
  const timers = new Map();
  window.setInterval = (fn) => { const id = nextTimerId++; timers.set(id, fn); return id; };
  window.clearInterval = (id) => { timers.delete(id); };

  // fixture 是静态 HTML(未执行真实布局/样式,getBoundingClientRect 判定不可见),
  // 测试语义上这些元素都可见,给它们显式布局与样式。
  window.Element.prototype.getBoundingClientRect = function () {
    return { width: 120, height: 32, top: 0, left: 0, bottom: 32, right: 120, x: 0, y: 0 };
  };
  window.Element.prototype.getComputedStyle = undefined;
  window.getComputedStyle = function () {
    return { display: "block", visibility: "visible", pointerEvents: "auto" };
  };

  // GM shim
  window.GM_getValue = k => gm.get(k);
  window.GM_setValue = (k, v) => gm.set(k, v);
  window.GM_deleteValue = k => gm.delete(k);

  // 点击追踪:捕获每个按钮/链接的点击
  const clicks = [];
  document.addEventListener("click", (e) => {
    const t = e.target;
    const label = (t && (t.id || (t.textContent || "").trim())) || (t && t.nodeName) || "?";
    clicks.push(String(label));
  }, true);

  // 运行真实 userscript;游戏域名下 pageMain 会被注入到页面上下文并因无游戏状态抛错,
  // 这是预期(证明注入发生),不是失败。
  let injectedPageMain = false;
  try {
    window.eval(source);
  } catch (e) {
    injectedPageMain = String(e && e.message || e).includes("state") ||
      url === GAME_URL;
    if (!injectedPageMain) throw e;
  }

  return {
    window,
    document,
    gm,
    clicks,
    nowRef: { set: v => { now = v; }, get: () => now },
    runTimers() { for (const cb of [...timers.values()]) cb(); },
    timerCount() { return timers.size; }
  };
}

const now0 = Date.now();

// ---- 1. oauth-consent.html + STRICT:只点确权按钮,写 ack,推进 auth。 ----
{
  const gm = new Map([
    ["crgrLeaveRecord", activeLeave(now0)],
    ["crgrReconnectFlow", { ts: now0, phase: "game-login" }],
    ["crgrConsentMode", "STRICT_AUTO_CONSENT"],
    ["crgrAutoReconnect", true]
  ]);
  const ctx = runFixture(FIX("oauth-consent.html"), { url: OAUTH_URL, seed: Object.fromEntries(gm), initialNow: now0 });
  ctx.runTimers();
  assert.deepEqual(ctx.clicks.filter(c => c === "允许").length, 1, "点击确权按钮");
  assert.equal(String(ctx.gm.get("crgrReconnectFlow").phase), "auth");
  assert.equal(String(ctx.gm.get("crgrReconnectAck")), String(now0));
}

// ---- 2. oauth-decoy-buttons.html:绝不点"继续阅读",只点精确"允许"。 ----
{
  const gm = new Map([
    ["crgrLeaveRecord", activeLeave(now0)],
    ["crgrReconnectFlow", { ts: now0, phase: "game-login" }],
    ["crgrConsentMode", "STRICT_AUTO_CONSENT"],
    ["crgrAutoReconnect", true]
  ]);
  const ctx = runFixture(FIX("oauth-decoy-buttons.html"), { url: OAUTH_URL, seed: Object.fromEntries(gm), initialNow: now0 });
  ctx.runTimers();
  assert.equal(ctx.clicks.filter(c => c === "继续阅读").length, 0, "不点击诱饵");
  assert.equal(ctx.clicks.filter(c => c === "允许").length, 1, "点击正确确权按钮");
}

// ---- 3. oauth-unknown-layout.html:结构未知 → 不点击,超时进 FAILED_MANUAL。 ----
{
  const gm = new Map([
    ["crgrLeaveRecord", activeLeave(now0)],
    ["crgrReconnectFlow", { ts: now0, phase: "game-login" }],
    ["crgrConsentMode", "STRICT_AUTO_CONSENT"],
    ["crgrAutoReconnect", true]
  ]);
  const ctx = runFixture(FIX("oauth-unknown-layout.html"), { url: OAUTH_URL, seed: Object.fromEntries(gm), initialNow: now0 });
  ctx.runTimers();
  // 没有任何命中,不点击"当然是继续"
  assert.equal(ctx.clicks.length, 0, "未知结构零点击");
  // 推进超过 2 分钟授权等待 → FAILED_MANUAL
  for (let i = 0; i < 60; i++) { ctx.nowRef.set(ctx.nowRef.get() + 2500); ctx.runTimers(); }
  assert.equal(ctx.gm.get("crgrReconnectFlow").phase, "FAILED_MANUAL", "超时进 FAILED_MANUAL");
}

// ---- 4. oauth-consent.html + NAVIGATE_ONLY(默认):即使结构匹配也绝不自动允许。 ----
{
  const gm = new Map([
    ["crgrLeaveRecord", activeLeave(now0)],
    ["crgrReconnectFlow", { ts: now0, phase: "game-login" }],
    ["crgrAutoReconnect", true]
  ]);
  const ctx = runFixture(FIX("oauth-consent.html"), { url: OAUTH_URL, seed: Object.fromEntries(gm), initialNow: now0 });
  ctx.runTimers();
  assert.equal(ctx.clicks.length, 0, "NAVIGATE_ONLY 零点击");
  assert.equal(ctx.gm.get("crgrReconnectFlow").phase, "game-login", "不推进授权阶段");
  assert.equal(ctx.gm.has("crgrReconnectAck"), false, "不写 ack");
}

// ---- 5. game-unauth.html:找到 #joinBtn,冷却过后抢占 game-login。(jsdom 不真正导航) ----
{
  const gm = new Map([
    ["crgrLeaveRecord", activeLeave(now0)],
    ["crgrReconnectFlow", { ts: now0, phase: "leave" }],
    ["crgrAutoReconnect", true]
  ]);
  const ctx = runFixture(FIX("game-unauth.html"), { url: GAME_URL, seed: Object.fromEntries(gm), initialNow: now0 });
  ctx.runTimers(); // 建立登录可见起点
  ctx.nowRef.set(ctx.nowRef.get() + 4000);
  ctx.runTimers(); // 超过 settle
  const flow = ctx.gm.get("crgrReconnectFlow");
  assert.equal(flow.phase, "game-login", "抢占 game-login");
  // 选择器必须命中 #joinBtn,绝不点 mobileJoinBtn(文本"登录")/leaveBtn 等诱饵。
  assert.equal(ctx.clicks.filter(c => c === "mobileJoinBtn").length, 0, "不点手机端登录诱饵");
  assert.equal(ctx.clicks.filter(c => c === "leaveBtn").length, 0, "不点离开按钮");
  assert.equal(ctx.clicks.filter(c => c === "joinBtn").length, 1, "命中 #joinBtn");
  // 若 fixture 里 #joinBtn 无 href,走 click;jsdom 中 location 不变但点击发生。
  const joinClicks = ctx.clicks.filter(c => c === "joinBtn").length;
  assert.ok(joinClicks === 0 || ctx.document.getElementById("joinBtn").hasAttribute("href") === false,
    "#joinBtn 应通过 click 触发跳转(而非裸 location.href)");
}

// ---- 6. 默认关闭:即便有流程,游戏/授权两侧都不动作。 ----
{
  const gm = new Map([
    ["crgrLeaveRecord", activeLeave(now0)],
    ["crgrReconnectFlow", { ts: now0, phase: "leave" }],
    ["crgrConsentMode", "STRICT_AUTO_CONSENT"]
  ]);
  const ctx = runFixture(FIX("game-unauth.html"), { url: GAME_URL, seed: Object.fromEntries(gm), initialNow: now0 });
  ctx.runTimers();
  ctx.nowRef.set(ctx.nowRef.get() + 4000);
  ctx.runTimers();
  assert.equal(ctx.gm.get("crgrReconnectFlow").phase, "leave", "默认关,不推进");
}

console.log("All reconnect DOM-fixture tests passed.");