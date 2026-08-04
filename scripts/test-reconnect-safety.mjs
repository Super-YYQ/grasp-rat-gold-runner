import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "src", "grasp-rat-gold-runner.user.js"), "utf8");

function makeButton(text) {
  const listeners = [];
  let clicks = 0;
  return {
    textContent: text,
    innerText: text,
    isConnected: true,
    disabled: false,
    get clickCount() { return clicks; },
    getAttribute(name) { return name === "href" ? "https://connect.linux.do/oauth2/authorize" : null; },
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

function makeContext(hostname, store, button, initialNow = Date.now()) {
  let now = initialNow;
  let nextTimerId = 1;
  const timers = new Map();
  const DateInContext = class extends Date {};
  DateInContext.now = () => now;

  const document = {
    title: "Test",
    querySelector() { return button; },
    querySelectorAll() { return []; },
    getElementById(id) { return hostname === "grasp-rat-game.h-e.top" && id === "joinBtn" ? button : null; }
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
  const location = { hostname, href: `https://${hostname}/` };
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
    URL,
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

// 没有本脚本刚刚建立的流程标记时，授权页不能碰任何按钮。
{
  const store = new Map();
  const ts = Date.now();
  store.set("crgrLeaveRecord", activeLeave(ts));
  const ctx = makeContext("connect.linux.do", store, makeButton("允许"), ts);
  assert.equal(ctx.timerCount(), 0);
  assert.equal(ctx.button.clickCount, 0);
}

// 授权页若没有先经过游戏页登录抢占，直接访问也不能自动允许。
{
  const store = new Map();
  const ts = Date.now();
  store.set("crgrLeaveRecord", activeLeave(ts));
  store.set("crgrReconnectFlow", { ts, phase: "leave" });
  const ctx = makeContext("connect.linux.do", store, makeButton("允许"), ts);
  assert.equal(ctx.timerCount(), 0);
  assert.equal(ctx.button.clickCount, 0);
  assert.equal(store.has("crgrLeaveRecord"), false);
  assert.equal(store.has("crgrReconnectFlow"), false);
}

// 同一授权流程只能成功点击一次，后续轮询/重复注入都不能再次点击。
{
  const store = new Map();
  const ts = Date.now();
  store.set("crgrLeaveRecord", activeLeave(ts));
  store.set("crgrReconnectFlow", { ts, phase: "game-login" });
  const button = makeButton("允许");
  const ctx = makeContext("connect.linux.do", store, button, ts);
  ctx.runTimers();
  assert.equal(button.clickCount, 1);
  assert.equal(String(store.get("crgrReconnectAck")), String(ts));
  assert.equal(store.get("crgrReconnectFlow").phase, "auth");

  const second = makeContext("connect.linux.do", store, button, ts);
  assert.equal(second.timerCount(), 0);
  assert.equal(button.clickCount, 1);
}

// 游戏页登录入口即使短暂出现，也必须先稳定可见；抢占后只允许一次跳转。
{
  const store = new Map();
  const ts = Date.now();
  store.set("crgrLeaveRecord", activeLeave(ts));
  store.set("crgrReconnectFlow", { ts, phase: "leave" });
  const button = makeButton("LinuxDO 登录");
  const ctx = makeContext("grasp-rat-game.h-e.top", store, button, ts);
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

// 返回游戏后 ack 尚在时，登录看护必须保持静默，给 pageMain 的安全恢复态接管。
{
  const store = new Map();
  const ts = Date.now();
  store.set("crgrLeaveRecord", activeLeave(ts));
  store.set("crgrReconnectFlow", { ts, phase: "auth" });
  store.set("crgrReconnectAck", ts);
  const ctx = makeContext("grasp-rat-game.h-e.top", store, makeButton("LinuxDO 登录"), ts);
  ctx.advance(5000);
  ctx.runTimers();
  assert.equal(ctx.button.clickCount, 0);
}

// 过期记录只清理，不再触发登录或授权。
{
  const store = new Map();
  const ts = Date.now() - 11 * 60 * 1000;
  store.set("crgrLeaveRecord", activeLeave(ts));
  store.set("crgrReconnectFlow", { ts, phase: "leave" });
  const ctx = makeContext("grasp-rat-game.h-e.top", store, makeButton("LinuxDO 登录"), Date.now());
  ctx.runTimers();
  assert.equal(ctx.button.clickCount, 0);
  assert.equal(store.has("crgrLeaveRecord"), false);
  assert.equal(store.has("crgrReconnectFlow"), false);
}

console.log("All reconnect-safety tests passed.");
