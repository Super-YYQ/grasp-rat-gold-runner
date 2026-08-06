import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "src", "entries", "desktop.user.js"), "utf8");

const OAUTH_ORIGIN = "https://connect.linux.do";
const GAME_ORIGIN = "https://grasp-rat-game.h-e.top";

function makeButton(text, href = "https://connect.linux.do/oauth2/authorize") {
  const listeners = [];
  let clicks = 0;
  return {
    textContent: text,
    innerText: text,
    isConnected: true,
    disabled: false,
    id: text === "LinuxDO 登录" ? "joinBtn" : "",
    get clickCount() { return clicks; },
    getAttribute(name) { return name === "href" ? href : name === "type" ? "submit" : null; },
    getBoundingClientRect() { return { width: 120, height: 32 }; },
    addEventListener(type, listener) {
      if (type === "click") listeners.push(listener);
    },
    click: () => {
      clicks += 1;
      for (const listener of listeners) listener({ isTrusted: false });
    },
    dispatchEvent() {}
  };
}

function makeContext(hostname, store, button, opts = {}) {
  const isOAuth = hostname === "connect.linux.do";
  let now = opts.initialNow ?? Date.now();
  let nextTimerId = 1;
  const timers = new Map();
  const DateInContext = class extends Date {};
  DateInContext.now = () => now;

  const document = {
    title: "Test",
    forms: [],
    querySelector() { return button; },
    querySelectorAll() { return []; },
    getElementById(id) { return !isOAuth && id === "joinBtn" ? button : null; }
  };
  const window = {
    setInterval(fn) {
      const id = nextTimerId++;
      timers.set(id, fn);
      return id;
    },
    clearInterval(id) { timers.delete(id); },
    getComputedStyle() {
      return { display: "block", visibility: "visible", pointerEvents: "auto" };
    }
  };
  const pageWindow = { eval() {} };
  const location = {
    hostname,
    href: `${isOAuth ? OAUTH_ORIGIN : GAME_ORIGIN}/`,
    origin: isOAuth ? OAUTH_ORIGIN : GAME_ORIGIN,
    pathname: opts.pathname ?? (isOAuth ? "/oauth2/authorize" : "/")
  };
  const sandbox = {
    window,
    document,
    location,
    unsafeWindow: pageWindow,
    GM_getValue(key) { return store.get(key); },
    GM_setValue(key, value) { store.set(key, value); },
    GM_deleteValue(key) { store.delete(key); },
    Date: DateInContext,
    setInterval: window.setInterval,
    clearInterval: window.clearInterval,
    Set,
    Map,
    URL,
    Math,
    MouseEvent: class {},
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "grasp-rat-gold-runner.user.js" });

  return {
    button,
    location,
    pageWindow,
    advance(ms) { now += ms; },
    runTimers() {
      for (const callback of [...timers.values()]) callback();
    },
    timerCount() { return timers.size; }
  };
}

function activeLeave(ts) {
  return { ts, type: "damage", hp: 60, enabled: true, v: 2 };
}

// ---- 1. 没有本脚本刚刚建立的流程标记时,授权页不能碰任何按钮。 ----
{
  const store = new Map();
  const ts = Date.now();
  store.set("crgrLeaveRecord", activeLeave(ts));
  store.set("crgrConsentMode", "STRICT_AUTO_CONSENT");
  const ctx = makeContext("connect.linux.do", store, makeButton("允许"), { initialNow: ts });
  assert.equal(ctx.timerCount(), 0);
  assert.equal(ctx.button.clickCount, 0);
}

// ---- 2. 授权页若没有先经过游戏页登录抢占,直接访问也不能自动允许。 ----
{
  const store = new Map();
  const ts = Date.now();
  store.set("crgrLeaveRecord", activeLeave(ts));
  store.set("crgrReconnectFlow", { ts, phase: "leave" });
  store.set("crgrConsentMode", "STRICT_AUTO_CONSENT");
  store.set("crgrAutoReconnect", true);
  const ctx = makeContext("connect.linux.do", store, makeButton("允许"), { initialNow: ts });
  assert.equal(ctx.timerCount(), 0);
  assert.equal(ctx.button.clickCount, 0);
  assert.equal(store.has("crgrLeaveRecord"), false);
  assert.equal(store.has("crgrReconnectFlow"), false);
}

// ---- 3. STRICT_AUTO_CONSENT:同一授权流程只能成功点击一次,后续重复注入不再点击。 ----
{
  const store = new Map();
  const ts = Date.now();
  store.set("crgrLeaveRecord", activeLeave(ts));
  store.set("crgrReconnectFlow", { ts, phase: "game-login" });
  store.set("crgrConsentMode", "STRICT_AUTO_CONSENT");
  store.set("crgrAutoReconnect", true);
  const button = makeButton("允许");
  const ctx = makeContext("connect.linux.do", store, button, { initialNow: ts });
  ctx.runTimers();
  assert.equal(button.clickCount, 1);
  assert.equal(String(store.get("crgrReconnectAck")), String(ts));
  assert.equal(store.get("crgrReconnectFlow").phase, "auth");

  const second = makeContext("connect.linux.do", store, button, { initialNow: ts });
  assert.equal(second.timerCount(), 0);
  assert.equal(button.clickCount, 1);
}

// ---- 4. NAVIGATE_ONLY(默认):即使有该轮流程也绝不自动允许。 ----
{
  const store = new Map();
  const ts = Date.now();
  store.set("crgrLeaveRecord", activeLeave(ts));
  store.set("crgrReconnectFlow", { ts, phase: "game-login" });
  store.set("crgrAutoReconnect", true);
  const button = makeButton("允许");
  const ctx = makeContext("connect.linux.do", store, button, { initialNow: ts });
  ctx.runTimers();
  assert.equal(button.clickCount, 0, "NAVIGATE_ONLY 不得自动点击允许");
  assert.equal(store.has("crgrReconnectAck"), false, "NAVIGATE_ONLY 不写 ack");
  assert.equal(store.get("crgrReconnectFlow").phase, "game-login", "NAVIGATE_ONLY 不推进授权阶段");
}

// ---- 5. 游戏页登录入口即使短暂出现,也必须先稳定可见;抢占后只允许一次跳转。 ----
{
  const store = new Map();
  const ts = Date.now();
  store.set("crgrLeaveRecord", activeLeave(ts));
  store.set("crgrReconnectFlow", { ts, phase: "leave" });
  store.set("crgrAutoReconnect", true);
  const button = makeButton("LinuxDO 登录");
  const ctx = makeContext("grasp-rat-game.h-e.top", store, button, { initialNow: ts });
  ctx.runTimers();
  assert.equal(button.clickCount, 0);
  ctx.advance(1000);
  ctx.runTimers();
  ctx.advance(1000);
  ctx.runTimers();
  assert.equal(button.clickCount, 0);
  ctx.advance(1000);
  ctx.runTimers();
  assert.equal(ctx.location.href, "https://connect.linux.do/oauth2/authorize");
  assert.equal(store.get("crgrReconnectFlow").phase, "game-login");
  ctx.runTimers();
  assert.equal(ctx.location.href, "https://connect.linux.do/oauth2/authorize");
}

// ---- 6. 返回游戏后 ack 尚在时,登录看护必须保持静默。 ----
{
  const store = new Map();
  const ts = Date.now();
  store.set("crgrLeaveRecord", activeLeave(ts));
  store.set("crgrReconnectFlow", { ts, phase: "auth" });
  store.set("crgrReconnectAck", ts);
  store.set("crgrAutoReconnect", true);
  const ctx = makeContext("grasp-rat-game.h-e.top", store, makeButton("LinuxDO 登录"), { initialNow: ts });
  ctx.advance(5000);
  ctx.runTimers();
  assert.equal(ctx.button.clickCount, 0);
}

// ---- 7. 过期记录只清理,不再触发登录或授权。 ----
{
  const store = new Map();
  const ts = Date.now() - 11 * 60 * 1000;
  store.set("crgrLeaveRecord", activeLeave(ts));
  store.set("crgrReconnectFlow", { ts, phase: "leave" });
  store.set("crgrAutoReconnect", true);
  const ctx = makeContext("grasp-rat-game.h-e.top", store, makeButton("LinuxDO 登录"), Date.now());
  ctx.runTimers();
  assert.equal(ctx.button.clickCount, 0);
  assert.equal(store.has("crgrLeaveRecord"), false);
  assert.equal(store.has("crgrReconnectFlow"), false);
}

// ---- 8. 自动重连默认关闭:未显式开启时,即使有合法离开记录也不自动登录/授权。 ----
{
  const store = new Map();
  const ts = Date.now();
  store.set("crgrLeaveRecord", activeLeave(ts));
  store.set("crgrReconnectFlow", { ts, phase: "leave" });
  const ctx = makeContext("grasp-rat-game.h-e.top", store, makeButton("LinuxDO 登录"), { initialNow: ts });
  ctx.advance(4000);
  ctx.runTimers();
  assert.equal(ctx.button.clickCount, 0, "默认关,不点登录");
  assert.equal(ctx.location.href, "https://grasp-rat-game.h-e.top/", "默认关,不导航");
  assert.equal(store.get("crgrReconnectFlow").phase, "leave", "默认关,不推进流程");
}

// ---- 9. 授权按钮在 STRICT 下超时未现 → 明确 FAILED_MANUAL 而不是静默轮询。 ----
{
  const store = new Map();
  const ts = Date.now();
  store.set("crgrLeaveRecord", activeLeave(ts));
  store.set("crgrReconnectFlow", { ts, phase: "game-login" });
  store.set("crgrConsentMode", "STRICT_AUTO_CONSENT");
  store.set("crgrAutoReconnect", true);
  // 页面没有可识别按钮(findAuthorizeButton 返回 null) → 超时
  const ctx = makeContext("connect.linux.do", store, null, { initialNow: ts });
  // 先跑一拍进入 auth 阶段
  ctx.runTimers();
  assert.equal(store.get("crgrReconnectFlow").phase, "auth");
  // 推进超过 2 分钟授权等待
  for (let i = 0; i < 60; i++) { ctx.advance(2500); ctx.runTimers(); }
  const flow = store.get("crgrReconnectFlow");
  assert.equal(flow.phase, "FAILED_MANUAL", "超时进入 FAILED_MANUAL");
  assert.ok((flow.lastError || "").includes("需要手动授权"), "记录 lastError");
  // 刷新不再轮询:terminal 阶段直接跳过
  const fresh = makeContext("connect.linux.do", store, null, { initialNow: ts + 3 * 60 * 1000 });
  assert.equal(fresh.timerCount(), 0, "终态不再开启授权轮询");
  assert.equal(fresh.button, null);
}

// ---- 10. 非 OAuth 路径(即使 connect.linux.do 域名)不运行授权逻辑。 ----
{
  const store = new Map();
  const ts = Date.now();
  store.set("crgrLeaveRecord", activeLeave(ts));
  store.set("crgrReconnectFlow", { ts, phase: "game-login" });
  store.set("crgrConsentMode", "STRICT_AUTO_CONSENT");
  const button = makeButton("允许");
  const ctx = makeContext("connect.linux.do", store, button, { initialNow: ts, pathname: "/foo/bar" });
  ctx.runTimers();
  assert.equal(button.clickCount, 0, "非 authorize 路径不点击");
  assert.equal(store.get("crgrReconnectFlow").phase, "game-login", "非 authorize 路径不推进流程");
}

// ---- 11. 终态(FAILED_MANUAL)下,即使按钮在场也不点击、不写 ack。 ----
{
  const store = new Map();
  const ts = Date.now();
  store.set("crgrLeaveRecord", activeLeave(ts));
  store.set("crgrReconnectFlow", { ts, phase: "FAILED_MANUAL", lastError: "早前失败" });
  store.set("crgrConsentMode", "STRICT_AUTO_CONSENT");
  store.set("crgrAutoReconnect", true);
  const button = makeButton("允许");
  const ctx = makeContext("connect.linux.do", store, button, { initialNow: ts });
  ctx.runTimers();
  assert.equal(button.clickCount, 0, "终态不点击");
  assert.equal(store.has("crgrReconnectAck"), false, "终态不写 ack");
}

// ---- 12. 登录链接若把 connect.linux.do 放在查询参数里伪装,必须 fail closed 不导航。 ----
{
  const store = new Map();
  const ts = Date.now();
  store.set("crgrLeaveRecord", activeLeave(ts));
  store.set("crgrReconnectFlow", { ts, phase: "leave" });
  store.set("crgrAutoReconnect", true);
  // 冒充 joinBtn 但 href 指向恶意站,仅在查询参数含 connect.linux.do/oauth2/authorize
  const evilHref = "https://evil.example/auth?next=https://connect.linux.do/oauth2/authorize&cb=1";
  const button = makeButton("LinuxDO 登录", evilHref);
  const ctx = makeContext("grasp-rat-game.h-e.top", store, button, { initialNow: ts });
  ctx.runTimers(); // 建立登录可见起点
  ctx.advance(4000);
  ctx.runTimers(); // 超过 settle → 触发导航(evil href 应 fail closed)
  assert.equal(ctx.location.href, "https://grasp-rat-game.h-e.top/", "不导航到伪造链接");
  const flow = store.get("crgrReconnectFlow");
  assert.ok(flow.phase === "FAILED_MANUAL" || flow.lastError, "fail closed 记录原因");
}

console.log("All reconnect-safety tests passed.");