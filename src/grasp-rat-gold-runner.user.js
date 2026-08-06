// ==UserScript==
// @name         Grasp Rat Gold Runner
// @namespace    https://grasp-rat-game.h-e.top/
// @version      1.9.12
// @description  Auto collect coin drops with HP-drop leave safety and combat dodge support.
// @match        https://grasp-rat-game.h-e.top/*
// @match        https://connect.linux.do/oauth2/authorize*
// @noframes
// @run-at       document-end
// @grant        unsafeWindow
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// ==/UserScript==

(function () {
  "use strict";

  // ---------- OAuth 授权页自动重连入口 ----------
  // 离开游戏后浏览器跳转到 connect.linux.do 授权页,需要在那个域名上也注入一段
  // 轻量逻辑:读离开记录 -> 按类型算冷却 -> 精确结构匹配确权按钮(可选) -> 重回游戏。
  // 因 pageMain 运行在页面上下文(unsafeWindow.eval),访问不到 GM_* API,所以离开记录
  // 的读写由本 IIFE 顶层(userscript 沙盒)负责,并通过 __crgrReconnect 暴露给 pageMain。
  //
  // 安全说明(Phase 1 范围):
  //   本阶段把"未知结构一律 fail closed、失败进入明确终态、URL 严格校验、默认关闭"
  //   等行为做到位,极大降低页面脚本伪造记录后的影响;但 bridge 仍驻留 unsafeWindow,
  //   完整解除"页面可写 GM"需在 Phase 2 把主逻辑迁回 userscript 沙盒(见审计文档 §4.1)。
  const RECONNECT_COOLDOWN_LOWHP_MS = 30 * 60 * 1000;
  const RECONNECT_COOLDOWN_STAMINA_MS = 60 * 60 * 1000;
  // 自动重连只对“刚发生的这一轮离开”负责。超过冷却后再给一小段宽限期，
  // 避免旧记录在用户以后正常打开游戏时继续驱动登录/授权跳转。
  const RECONNECT_GRACE_MS = 10 * 60 * 1000;
  // 各阶段的硬性 deadline(ms):到点未完成就进入明确终态而不是无声卡死。
  const RECONNECT_NAV_DEADLINE_MS = 15 * 1000;          // 登录导航
  const RECONNECT_AWAIT_CONSENT_MS = 2 * 60 * 1000;     // 授权等待
  const RECONNECT_RETURN_DEADLINE_MS = 30 * 1000;       // 返回
  const RECONNECT_MAX_NAV_ATTEMPTS = 2;                 // 导航失败最多回退重试次数
  const RECONNECT_LOGIN_SETTLE_MS = 2500;
  const RECONNECT_CRITICAL_HP = 25; // 与 pageMain 内 COMBAT_CRITICAL_HP 保持一致
  const RECONNECT_KEY_LEAVE = "crgrLeaveRecord";
  const RECONNECT_KEY_ACK = "crgrReconnectAck";
  const RECONNECT_KEY_FLOW = "crgrReconnectFlow";
  const RECONNECT_KEY_SWITCH = "crgrAutoReconnect";
  const RECONNECT_KEY_CONSENT = "crgrConsentMode";
  const RECONNECT_AUTO_TYPES = new Set(["damage", "lowhp", "stamina"]);
  // 状态机:进行中阶段(小写)与终态(大写)。任何终态出现后都不再自动点击/导航。
  const RECONNECT_TERMINAL = new Set(["FAILED_RETRYABLE", "FAILED_MANUAL", "CANCELLED", "EXPIRED", "DONE"]);

  function gmGet(key) {
    try {
      if (typeof GM_getValue === "function") return GM_getValue(key);
    } catch (_) {}
    return undefined;
  }
  function gmSet(key, val) {
    try {
      if (typeof GM_setValue === "function") GM_setValue(key, val);
    } catch (_) {}
  }
  function gmDel(key) {
    try {
      if (typeof GM_deleteValue === "function") GM_deleteValue(key);
    } catch (_) {}
  }

  function reconnectCooldownMs(type) {
    return type === "damage" ? 0
      : type === "lowhp" ? RECONNECT_COOLDOWN_LOWHP_MS
      : type === "stamina" ? RECONNECT_COOLDOWN_STAMINA_MS
      : -1;
  }

  function reconnectRecordIsActive(rec, now) {
    if (!rec || !RECONNECT_AUTO_TYPES.has(rec.type)) return false;
    const ts = Number(rec.ts);
    if (!Number.isFinite(ts)) return false;
    const age = (Number(now) || Date.now()) - ts;
    if (age < -60 * 1000) return false;
    return age <= reconnectCooldownMs(rec.type) + RECONNECT_GRACE_MS;
  }

  // 随机 flowId(尽力与诊断标识;不需要保密)。优先 crypto,降级纯 JS。
  function reconnectId() {
    try {
      if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    } catch (_) {}
    return "f" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  // 登录目标的 OAuth 链接必须可解析且 host/pathname 精确匹配;仅查询参数含
  // "connect.linux.do/oauth2/authorize" 的表象不算数(防 URL 伪装)。
  function isExpectedOAuthUrl(raw) {
    try {
      const url = new URL(String(raw || ""), location.href);
      return url.protocol === "https:"
        && url.hostname === "connect.linux.do"
        && url.pathname === "/oauth2/authorize";
    } catch (_) {
      return false;
    }
  }

  // 授权逻辑只允许在 connect.linux.do 的精确 authorize 路径运行(与 @match 双保险)。
  function isOAuthAuthorizePage() {
    try {
      return location.origin === "https://connect.linux.do"
        && (location.pathname === "/oauth2/authorize" || location.pathname.indexOf("/oauth2/authorize/") === 0);
    } catch (_) {
      return false;
    }
  }

  // ---- 游戏契约检查(fail closed,审计文档 §4.5)----
  // 接收一个"字段名 -> 实际值"的 report,返回 READY / DEGRADED / INCOMPATIBLE 分级。
  // 这是决策的唯一实现(pageMain 只负责构造 report 并应用返回的级别),
  // 对外开放的 __crgrContract 是纯只读分类器(不读,不写,无 GM/无状态权限),
  // 便于离线测试;页面即使调用它也只能对一个它自己给的 report 做分类,无能力加成。
  function contractPresent(value, expectation) {
    if (typeof value === "undefined" || value === null || value === false) return false;
    if (expectation === "function") return typeof value === "function";
    if (expectation === "array") return Array.isArray(value);
    if (expectation === "Set-like") {
      return value && (value instanceof Set || typeof value.add === "function"
        || typeof value.has === "function" || typeof value.delete === "function");
    }
    if (expectation === "HTMLElement") {
      return typeof value === "object" && typeof value.getContext === "function";
    }
    if (expectation === "present") return true;
    if (expectation === "object") return typeof value === "object" && !Array.isArray(value);
    return true;
  }

  // 预期契约:required 缺失 → INCOMPATIBLE(不注入控制);required 全在但某些
  // 关键可选(画布/坐标/指针)缺失 → DEGRADED(自动移动/攻击关闭,只读展示)。
  const GAME_CONTRACT_REQUIRED = [
    ["state", "object"],
    ["state.entities", "array"],
    ["state.coinDrops", "array"],
    ["state.keys", "Set-like"],
    ["state.currentUserId", "present"],
    ["sendVelocity", "function"]
  ];
  const GAME_CONTRACT_OPTIONAL_CRITICAL = [
    ["canvas", "HTMLElement"],
    ["setPointerFromClient", "function"],
    ["screenCenter", "function"]
  ];

  function classifyGameContract(report) {
    const out = { status: "READY", missing: [], criticalMissing: [], report: {} };
    for (const [key, expect] of GAME_CONTRACT_REQUIRED) {
      const value = report ? report[key] : undefined;
      const ok = contractPresent(value, expect);
      out.report[key] = ok ? expect : "missing";
      if (!ok) out.missing.push(key);
    }
    for (const [key, expect] of GAME_CONTRACT_OPTIONAL_CRITICAL) {
      const value = report ? report[key] : undefined;
      const ok = contractPresent(value, expect);
      out.report[key] = ok ? expect : "missing";
      if (!ok) out.criticalMissing.push(key);
    }
    if (out.missing.length) out.status = "INCOMPATIBLE";
    else if (out.criticalMissing.length) out.status = "DEGRADED";
    else out.status = "READY";
    return out;
  }
  try {
    if (typeof unsafeWindow !== "undefined") {
      unsafeWindow.__crgrContract = Object.freeze({ classify: classifyGameContract });
    }
  } catch (_) {}

  // 新建 v3 流程记录:带 flowId/owner/lease/deadline,任何失败都写 lastError。
  function newFlow(leave) {
    const ts = Number(leave && leave.ts);
    return {
      version: 3,
      flowId: reconnectId(),
      ts: String(leave && leave.ts),
      type: (leave && leave.type) || "damage",
      phase: "leave",
      reason: (leave && leave.reason) || "",
      at: Date.now(),
      dueAt: Number.isFinite(ts) ? ts + reconnectCooldownMs((leave && leave.type) || "damage") : 0,
      deadline: 0,
      ownerId: null,
      leaseUntil: 0,
      attempt: 0,
      consentMode: reconnectReadConsentMode(),
      lastError: null,
      lastTransitionAt: Date.now()
    };
  }

  function reconnectReadSwitch() {
    return gmGet(RECONNECT_KEY_SWITCH) === true; // 默认关闭(安全优先,需显式开启)
  }
  function reconnectReadConsentMode() {
    return gmGet(RECONNECT_KEY_CONSENT) === "STRICT_AUTO_CONSENT" ? "STRICT_AUTO_CONSENT" : "NAVIGATE_ONLY";
  }

  // 写流程记录并"乐观写后回读",返回写后读到的记录,供调用方确认 owner/phase。
  function flowWriteMerge(ts, patch) {
    const flow = gmGet(RECONNECT_KEY_FLOW);
    if (!flow || String(flow.ts) !== String(ts)) return null;
    const next = Object.assign({}, flow, patch, {
      lastTransitionAt: Date.now()
    });
    gmSet(RECONNECT_KEY_FLOW, next);
    return gmGet(RECONNECT_KEY_FLOW);
  }

  // pageMain(页面上下文)通过该桥读写离开记录与重连开关;实现都在 userscript 沙盒。
  // 注意:claimLoginFlow / claimAuthFlow / claimAck / flowWriteMerge 等属于流程状态推进,
  // 只在沙盒内由两个 watcher 调用,不暴露给页面(pageMain 只需要记录/开关/读取)。
  const reconnectBridge = {
    readLeave() { return gmGet(RECONNECT_KEY_LEAVE) || null; },
    writeLeave(rec) { gmSet(RECONNECT_KEY_LEAVE, rec); },
    clearLeave() { gmDel(RECONNECT_KEY_LEAVE); },
    readFlow() { return gmGet(RECONNECT_KEY_FLOW) || null; },
    markLeaveFlow(ts) {
      const leave = gmGet(RECONNECT_KEY_LEAVE);
      if (!leave || String(leave.ts) !== String(ts)) return null;
      const flow = newFlow(leave);
      gmSet(RECONNECT_KEY_FLOW, flow);
      return flow;
    },
    readSwitch: reconnectReadSwitch,
    setSwitch(on) { gmSet(RECONNECT_KEY_SWITCH, !!on); },
    readConsentMode: reconnectReadConsentMode,
    setConsentMode(mode) {
      gmSet(RECONNECT_KEY_CONSENT, mode === "STRICT_AUTO_CONSENT" ? "STRICT_AUTO_CONSENT" : "NAVIGATE_ONLY");
    },
    readAck() { return gmGet(RECONNECT_KEY_ACK); },
    clearAck() { gmDel(RECONNECT_KEY_ACK); },
    clearFlow() { gmDel(RECONNECT_KEY_FLOW); },
    claimAck(ts) {
      const ack = gmGet(RECONNECT_KEY_ACK);
      if (ack && String(ack) === String(ts)) return false;
      const leave = gmGet(RECONNECT_KEY_LEAVE);
      if (!leave || String(leave.ts) !== String(ts)) return false;
      gmSet(RECONNECT_KEY_ACK, ts);
      return true;
    },
    // 冷却映射(ms):供游戏域名页算"距离开多久才能重连"
    cooldownMs: reconnectCooldownMs,
    isRecordActive: reconnectRecordIsActive
  };
  // 暴露到 unsafeWindow(优先),否则 window,供 pageMain 调用(见顶部安全说明)。
  try {
    if (typeof unsafeWindow !== "undefined") unsafeWindow.__crgrReconnect = reconnectBridge;
    else window.__crgrReconnect = reconnectBridge;
  } catch (_) {
    try { window.__crgrReconnect = reconnectBridge; } catch (_e) {}
  }

  // 在授权页找"允许/授权"类按钮;优先按 LINUX DO Connect 实际页面结构
  // (class="btn-pill btn-pill-primary" 的 <a> 允许按钮),再回退到关键词匹配
  function isVisibleEnabledAction(el) {
    if (!el || !el.isConnected) return false;
    if (el.disabled || el.getAttribute("aria-disabled") === "true") return false;
    try {
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return false;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || style.pointerEvents === "none") {
        return false;
      }
    } catch (_) {}
    return true;
  }

  // 授权页"允许"按钮匹配。设计目标是 fail closed:
  //   1) 必须先处于 connect.linux.do 精确 authorize 路径;
  //   2) 精确结构 a.btn-pill.btn-pill-primary,或确权表单(action 满足 isExpectedOAuthUrl)
  //      范围内的按钮;
  //   3) 按钮文本必须是白名单【精确值】(整串匹配,不用 includes),
  //     因此"继续阅读/确认退出"等诱饵不会命中;
  //   4) 找不到精确结构 → 返回 null,绝不靠宽松关键词猜测点击。
  function findAuthorizeButton() {
    if (!isOAuthAuthorizePage()) return null;
    const denyRe = /拒绝|取消|deny|cancel|decline|reject|refuse|不同意|不授权|不允许|not now|退出|登出|logout/;
    const allowExact = new Set(["允许", "授权", "同意", "确认", "authorize", "accept", "approve", "allow", "grant"]);
    const normalize = s => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();

    // 1) 精确结构:btn-pill-primary
    try {
      const primary = document.querySelector(
        "a.btn-pill-primary, a.btn-pill.btn-pill-primary, button.btn-pill-primary, input.btn-pill-primary"
      );
      if (primary && isVisibleEnabledAction(primary)) {
        const t = normalize(primary.innerText || primary.textContent || primary.value || "");
        if (allowExact.has(t) && !denyRe.test(t)) return primary;
      }
    } catch (_) {}

    // 2) 确权表单范围内的精确按钮
    try {
      const forms = Array.from(document.forms || []);
      const targetForm = forms.find(f => {
        const action = f.getAttribute && (f.getAttribute("action") || f.action || "");
        return isExpectedOAuthUrl(action);
      });
      if (targetForm) {
        const els = Array.from(targetForm.querySelectorAll(
          "button, input[type='submit'], a[role='button'], input[type='button']"
        )).filter(isVisibleEnabledAction);
        for (const el of els) {
          const t = normalize(el.innerText || el.textContent || el.value
            || (el.getAttribute && el.getAttribute("value")) || "");
          if (allowExact.has(t) && !denyRe.test(t)) return el;
        }
        return null; // 有确权表单但没有精确按钮 → fail closed
      }
    } catch (_) {}

    // 3) 无确权容器/结构未知 → fail closed,绝不宽松匹配
    return null;
  }

  function oauthReconnectMain() {
    // 授权页只处理由本脚本刚刚发起的这一轮重连流程。
    // 没有流程标记、已确认过或已过期的记录一律不碰按钮;结构未知时 fail closed。
    try {
      if (!isOAuthAuthorizePage()) {
        document.title = "[非授权页·自动重连不动作] " + (document.title || "");
        return;
      }
      if (!reconnectBridge.readSwitch()) {
        document.title = "[自动重连已关闭·不点允许] " + (document.title || "");
        return;
      }
      const consentMode = reconnectBridge.readConsentMode();
      const rec = reconnectBridge.readLeave();
      const flow = reconnectBridge.readFlow();
      if (!reconnectBridge.isRecordActive(rec) || rec.enabled === false
        || !flow || !rec.ts || String(flow.ts) !== String(rec.ts)) {
        document.title = "[无有效重连流程·不点允许] " + (document.title || "");
        return;
      }
      if (RECONNECT_TERMINAL.has(flow.phase)) {
        document.title = "[重连已终止·" + flow.phase + "] " + (document.title || "");
        return;
      }
      const ack = reconnectBridge.readAck();
      if (ack && String(ack) === String(rec.ts)) {
        document.title = "[已重连过·不重复点] " + (document.title || "");
        return;
      }
      if (flow.phase === "auth") {
        document.title = "[授权动作已占用·不重复点] " + (document.title || "");
        return;
      }
      if (flow.phase !== "game-login") {
        if (flow.phase === "leave") {
          // 直接落到授权页而没有经过游戏页登录抢占，视为未确认的手动/异常导航；
          // 宁可让用户手动处理，也不把这次页面访问当成自动允许。
          reconnectBridge.clearLeave();
          reconnectBridge.clearAck();
          reconnectBridge.clearFlow();
        }
        document.title = "[未确认游戏页登录·不点允许] " + (document.title || "");
        return;
      }
      // 默认 NAVIGATE_ONLY:只负责"把用户带到授权页",绝不自动点允许。
      if (consentMode === "NAVIGATE_ONLY") {
        document.title = "[请手动允许授权]" + (document.title ? " " + document.title : "");
        return;
      }
      // STRICT_AUTO_CONSENT:仅精确契约匹配才自动允许。先在按钮渲染前锁定阶段,
      // 防止用户手动允许或页面刷新后,游戏页又把同一条离开记录当成新的登录任务。
      if (!flowWriteMerge(rec.ts, { phase: "auth", deadline: Date.now() + RECONNECT_AWAIT_CONSENT_MS })) {
        document.title = "[授权动作已占用·不重复点] " + (document.title || "");
        return;
      }

      const baseTitle = document.title || "";
      const startedAt = Date.now();
      let poll = 0;
      let hookedAuthorizeButton = null;
      const cancelForManualAuthorize = () => {
        reconnectBridge.clearLeave();
        reconnectBridge.clearAck();
        reconnectBridge.clearFlow();
        document.title = "[手动允许·自动重连已取消] " + baseTitle;
        if (poll) clearInterval(poll);
        poll = 0;
      };
      const hookManualAuthorize = button => {
        if (!button || button === hookedAuthorizeButton) return;
        hookedAuthorizeButton = button;
        try {
          button.addEventListener("click", event => {
            if (event && event.isTrusted === true) cancelForManualAuthorize();
          }, true);
        } catch (_) {}
      };

      poll = window.setInterval(() => {
        try {
          const current = reconnectBridge.readLeave();
          const currentFlow = reconnectBridge.readFlow();
          const now = Date.now();
          if (!reconnectBridge.readSwitch() || !reconnectBridge.isRecordActive(current)
            || current.enabled === false || !current.ts || String(current.ts) !== String(rec.ts)
            || !currentFlow || String(currentFlow.ts) !== String(rec.ts)
            || currentFlow.phase !== "auth" || RECONNECT_TERMINAL.has(currentFlow.phase)) {
            clearInterval(poll);
            poll = 0;
            return;
          }

          const currentAck = reconnectBridge.readAck();
          if (currentAck && String(currentAck) === String(rec.ts)) {
            clearInterval(poll);
            document.title = "[已重连过·不重复点] " + baseTitle;
            return;
          }

          const cooldown = reconnectBridge.cooldownMs(current.type);
          const dueAt = Number(current.ts) + cooldown;
          if (now < dueAt) {
            document.title = "[冷却中·不点允许] " + baseTitle;
            return;
          }

          // 授权结构未知/按钮超时未现 → 明确进入 FAILED_MANUAL,不再静默轮询到死。
          if (now - startedAt > RECONNECT_AWAIT_CONSENT_MS) {
            flowWriteMerge(rec.ts, {
              phase: "FAILED_MANUAL",
              deadline: now,
              lastError: "授权按钮超时未见,页面结构未知,需要手动授权"
            });
            clearInterval(poll);
            poll = 0;
            document.title = "[页面结构未知·需要手动授权] " + baseTitle;
            return;
          }

          const btn = findAuthorizeButton();
          if (btn) {
            hookManualAuthorize(btn);
            // 流程已在按钮出现前抢占;这里先写 ack,最后才允许触发页面导航。
            // 同页重复注入、重复刷新或多标签页都只能有一个胜者。
            if (!reconnectBridge.claimAck(rec.ts)) {
              clearInterval(poll);
              poll = 0;
              return;
            }
            clearInterval(poll);
            poll = 0;
            document.title = "[已点击允许·重连中] " + baseTitle;
            try { btn.click(); } catch (_) {
              try { btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); } catch (_e) {}
            }
            return;
          }
          document.title = "[等待授权页加载·找允许] " + baseTitle;
        } catch (err) {
          // 单次异常:记入 lastError(不再完全静默),下一拍继续。
          try { flowWriteMerge(rec.ts, { lastError: "授权轮询异常: " + String(err && err.message || err) }); } catch (_) {}
        }
      }, 400);
    } catch (err) {
      // 顶层异常不再被静默吞掉:标记 FAILED_RETRYABLE 并写 lastError。
      try {
        const f = reconnectBridge.readFlow();
        if (f && f.ts) flowWriteMerge(f.ts, { phase: "FAILED_RETRYABLE", lastError: "授权流程异常: " + String(err && err.message || err), deadline: Date.now() });
      } catch (_) {}
    }
  }

  // 在游戏域名页(登出态)找"LinuxDO 登录"入口:
  //   1) 精确锚定 #joinBtn(游戏页真实结构 <button class="join" id="joinBtn">LinuxDO 登录);
  //   2) href 满足 isExpectedOAuthUrl 的跳转链接(必须是 https://connect.linux.do/oauth2/authorize
  //      的精确解析结果,仅查询字符串包含 connect.linux.do 的表象不算)。
  // 两种都找不到 → 返回 null(绝不宽松关键词命中来导航)。
  function findLinuxDoLoginButton() {
    const denyRe = /离开|退出|exit|sign\s*out|log\s*out|logout|disconnect|不登录|取消/;
    // 1) 精确:游戏页真实按钮 id
    try {
      const btn = document.getElementById("joinBtn");
      if (btn && isVisibleEnabledAction(btn)) return btn;
    } catch (_) {}
    // 2) 严格 OAuth 跳转链接
    try {
      const links = Array.from(document.querySelectorAll("a[href]"));
      for (const a of links) {
        if (!isVisibleEnabledAction(a)) continue;
        const href = a.getAttribute("href") || "";
        if (!isExpectedOAuthUrl(href)) continue;
        const text = (a.innerText || a.textContent || "").trim().toLowerCase();
        if (denyRe.test(text)) continue;
        return a;
      }
    } catch (_) {}
    return null;
  }

  // 登出态看护:游戏域名页 + DOM + GM,不依赖游戏变量。
  // 防误触三条件须同时满足才会点登录跳授权页:开关开 + 合法离开记录 + 页面出现 LinuxDo 登录入口。
  // 任意一条不满足(尤其正常挂机时登录入口不在场)→什么都不做,绝不自作主张戳登录。
  function gameReconnectWatcher() {
    const watcherHost = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    const watcherKey = "__crgrGameReconnectWatcher";
    try {
      if (watcherHost[watcherKey]) return;
      watcherHost[watcherKey] = true;
    } catch (_) {}

    const baseTitle = document.title || "";
    const POLL_MS = 1000;
    let jumped = false;
    let loginVisibleSince = 0;
    let observedTs = "";
    let hookedLoginButton = null;
    let poll = 0;
    let manualLoginListener = null;
    const release = () => {
      if (poll) clearInterval(poll);
      poll = 0;
      if (manualLoginListener) {
        try { document.removeEventListener("click", manualLoginListener, true); } catch (_) {}
        manualLoginListener = null;
      }
      try { watcherHost[watcherKey] = false; } catch (_) {}
    };
    const cancelForManualLogin = () => {
      // 用户自己点登录时，当前离开记录不再代表一轮自动重连；
      // 清掉流程标记，防止授权页把这次手动登录误当成自动允许。
      reconnectBridge.clearLeave();
      reconnectBridge.clearAck();
      reconnectBridge.clearFlow();
      jumped = true;
      document.title = "[手动登录·自动重连已取消] " + baseTitle;
      release();
    };
    const hookManualLogin = button => {
      if (!button || button === hookedLoginButton) return;
      hookedLoginButton = button;
      try {
        button.addEventListener("click", event => {
          if (event && event.isTrusted === true) cancelForManualLogin();
        }, true);
      } catch (_) {}
    };
    manualLoginListener = event => {
      if (!event || event.isTrusted !== true) return;
      const button = findLinuxDoLoginButton();
      const target = event.target;
      if (!button || target !== button && !(button.contains && button.contains(target))) return;
      cancelForManualLogin();
    };
    try { document.addEventListener("click", manualLoginListener, true); } catch (_) {}

    poll = window.setInterval(() => {
      try {
        if (jumped) { release(); return; }
        if (!reconnectBridge.readSwitch()) return;
        const rec = reconnectBridge.readLeave();
        if (!rec || !rec.ts) return; // 没离开记录:正常在玩/刚手动启动后被清,不管
        if (!RECONNECT_AUTO_TYPES.has(rec.type) || rec.enabled === false) {
          return; // manual/other/未知:不重连
        }
        if (!reconnectBridge.isRecordActive(rec)) {
          // 旧记录只能清理，不能再触发任何导航。
          reconnectBridge.clearLeave();
          reconnectBridge.clearAck();
          reconnectBridge.clearFlow();
          return;
        }
        const flow = reconnectBridge.readFlow();
        if (!flow || String(flow.ts) !== String(rec.ts)) return;
        const ack = reconnectBridge.readAck();
        // 允许按钮已经被点击，返回游戏的这段时间由 pageMain 做安全恢复；
        // 此时绝不能因为登录入口短暂闪现又发起一轮登录。
        if (ack && String(ack) === String(rec.ts)) return;
        if (flow.phase !== "leave") {
          // 终态:当前实例退出看护,不再重试。
          if (RECONNECT_TERMINAL.has(flow.phase)) {
            release();
            return;
          }
          if (flow.phase === "game-login") {
            // 导航后仍停留原页(可能 location 赋值被拦/失败):最多回退重试一次。
            const flowAge = Date.now() - (Number(flow.lastTransitionAt) || Number(flow.at) || 0);
            if (flowAge > RECONNECT_NAV_DEADLINE_MS) {
              const attempt = (Number(flow.attempt) || 0) + 1;
              if (attempt <= RECONNECT_MAX_NAV_ATTEMPTS) {
                flowWriteMerge(rec.ts, { phase: "leave", attempt, deadline: 0, lastError: "登录导航回退重试" });
                document.title = "[登录导航回退·重试] " + baseTitle;
                return; // 下一拍重新抢占登录
              }
              flowWriteMerge(rec.ts, {
                phase: "FAILED_MANUAL", deadline: Date.now(), attempt,
                lastError: "登录导航失败超过重试上限,请手动登录"
              });
              release();
              document.title = "[登录导航失败·请手动登录] " + baseTitle;
              return;
            }
            return; // 仍在导航等待窗口内
          }
          // 其它占用/中间态:当前实例退出看护。
          release();
          return;
        }
        if (observedTs !== String(rec.ts)) {
          observedTs = String(rec.ts);
          loginVisibleSince = 0;
        }

        const loginBtn = findLinuxDoLoginButton();
        if (!loginBtn) {
          loginVisibleSince = 0;
          return;
        }
        hookManualLogin(loginBtn);

        const cd = reconnectBridge.cooldownMs(rec.type);
        if (cd < 0) return;
        const dueAt = rec.ts + cd;
        const now = Date.now();
        if (now < dueAt) {
          // 冷却未到:只显示倒计时,不动作。但前提是确实在登出态——
          // 若页面上没出现登录入口(可能已登录或在玩),就不动 title、不打扰
          const rem = dueAt - now;
          const mm = String(Math.floor(rem / 60000)).padStart(2, "0");
          const ss = String(Math.floor((rem % 60000) / 1000)).padStart(2, "0");
          document.title = "[待重连·还需 " + mm + ":" + ss + "] " + baseTitle;
          loginVisibleSince = 0;
          return;
        }
        // 登录入口必须连续可见一段时间，过滤游戏页初始化时的短暂占位。
        if (!loginVisibleSince) loginVisibleSince = now;
        if (now - loginVisibleSince < RECONNECT_LOGIN_SETTLE_MS) {
          document.title = "[确认登出态·暂不登录] " + baseTitle;
          return;
        }

        try {
          // 先持久化抢占结果(phase: leave -> game-login),再触发一次导航。
          const prev = reconnectBridge.readFlow();
          if (!prev || prev.phase !== "leave" || RECONNECT_TERMINAL.has(prev.phase)) {
            jumped = true;
            release();
            return;
          }
          const navId = reconnectId();
          if (!flowWriteMerge(rec.ts, {
            phase: "game-login",
            deadline: Date.now() + RECONNECT_NAV_DEADLINE_MS,
            ownerId: navId,
            leaseUntil: Date.now() + RECONNECT_NAV_DEADLINE_MS
          })) {
            jumped = true;
            release();
            return;
          }
          jumped = true;
          document.title = "[冷却到期·跳授权页] " + baseTitle;
          release();
          if (loginBtn.id === "joinBtn" && !loginBtn.getAttribute("href")) {
            // #joinBtn 无 href:交给游戏自己的 click 处理跳转。
            try { loginBtn.click(); } catch (_) {
              try { loginBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); } catch (_e) {}
            }
          } else {
            // 有 href 时必须严格校验为预期 OAuth 链接,否则拒绝导航(fail closed)。
            const href = loginBtn.getAttribute && loginBtn.getAttribute("href");
            if (href && isExpectedOAuthUrl(href) && !/^javascript:/i.test(href)) {
              location.href = href;
            } else {
              // 结构未知/非法 href:不导航,交由手动处理。
              flowWriteMerge(rec.ts, { phase: "FAILED_MANUAL", lastError: "登录链接不是预期 OAuth 地址,已 fail closed", deadline: Date.now() });
              document.title = "[登录入口未知·请手动登录] " + baseTitle;
            }
          }
        } catch (err) {
          // 导航/点击失败也不静默:标记终态,避免失败状态下反复重试。
          try { flowWriteMerge(rec.ts, { phase: "FAILED_RETRYABLE", lastError: "登录导航异常: " + String(err && err.message || err), deadline: Date.now() }); } catch (_) {}
          release();
        }
      } catch (_) {
        // 单次异常:静默继续
      }
    }, POLL_MS);
  }

  // 域名分流:授权页只跑轻量重连逻辑,绝不注入 pageMain
  if (location.hostname === "connect.linux.do" || location.hostname.endsWith(".connect.linux.do")) {
    try { oauthReconnectMain(); } catch (_) {}
    return;
  }
  // 其它非游戏域名不注入(如误装到别处)
  if (location.hostname !== "grasp-rat-game.h-e.top") return;

  // 游戏域名页:登出态下"等冷却 + 到期点 LinuxDo 登录跳授权页"的轻量看护。
  // 与 pageMain(登录态挂机)共存于同一页,互不依赖:它只靠 DOM + GM 记录,
  // 不读 state/els。pageMain 在登录态 ready() 后照常 setup。
  // 关键防误触:只有当(重连开关开)且(读到合法离开记录 type∈damage/lowhp/stamina)
  // 且(页面当前出现了 LinuxDo 登录入口=未登录态)才行动。
  // 正常挂机时游戏已登录、登录入口不在场,本看护什么都不做。
  try { gameReconnectWatcher(); } catch (_) {}

  const code = `(${pageMain.toString()})();`;

  try {
    if (typeof unsafeWindow !== "undefined" && unsafeWindow.eval) {
      unsafeWindow.eval(code);
      return;
    }
  } catch (_) {
    // Fall back to a page script element below.
  }

  const script = document.createElement("script");
  script.textContent = code;
  (document.documentElement || document.head || document.body).appendChild(script);
  script.remove();

  function pageMain() {
    "use strict";

    const RUNNER_KEY = "__codexRatGoldRunner";
    const PANEL_ID = "codex-rat-gold-runner-panel";
    const RICH_ENEMY_MIN_DROP = 10;
    const RICH_ENEMY_SCAN_CM = 25000;
    const RICH_ENEMY_KEEP_CM = 22000;
    const RICH_ENEMY_ESCAPE_CM = 17000;
    // 逃离两阶段:刚触发 170m 逃离时纯反向拉开(避免路过的玩家引发一过性抖动);
    // 同一敌人持续逼近超过此 hold 时长、仍 170m 内,才转去逃向一颗“安全金币锚点”顺路收币。
    // 锚点到达或超过 max 寿命后立刻换下一颗/回纯反向,避免在同一金币点原地转圈。
    const FLEE_ANCHOR_HOLD_MS = 1500;
    const FLEE_ANCHOR_MAX_MS = 3500;
    const FLEE_ANCHOR_SAFE_RADIUS_CM = 19000;
    // 金币拾取半径:八向移动步长较大时,过小的 stop 阈值会在金币周边来回超调转圈。
    const COIN_REACHED_CM = 160;
    const ENEMY_LINE_SCAN_CM = 50000;
    const ENEMY_LINE_MIN_DROP = 1;
    const COMBAT_SCAN_CM = 17000;
    const COMBAT_LOW_HP = 9;
    const COMBAT_FAST_CHECK_HP = 22;
    const COMBAT_CRITICAL_HP = 25;
    const COMBAT_DODGE_SCAN_CM = 36000;
    const COMBAT_DODGE_SPEED_CMPS = 1300;
    const COMBAT_DODGE_SWITCH_MS = 650;
    const COMBAT_SPACING_SCAN_CM = 19000;
    const COMBAT_RANGE_HARD_MIN_CM = 8500;
    const COMBAT_RANGE_MIN_CM = 10000;
    const COMBAT_RANGE_IDEAL_CM = 12500;
    const COMBAT_RANGE_MAX_CM = 15000;
    const COMBAT_CLOSE_PROJECTILE_PRESSURE = 520;
    // 常态巡航轻量弹道躲避：不进临时交战、不清金币路线。
    // 压迫度或近弹距离超阈值时短暂横移，hold 结束后立刻恢复巡航。
    const CRUISE_DODGE_PRESSURE = 380;
    const CRUISE_DODGE_NEAR_CM = 12000;
    const CRUISE_DODGE_HOLD_MS = 450;
    const AUTO_FIRE_RANGE_CM = 15000;
    const AUTO_FIRE_DEFAULT_PROJECTILE_SPEED_CMPS = 10000;
    const AUTO_FIRE_MAX_RATE_MS = 100;
    const AUTO_FIRE_LOOP_MS = 100;
    const AUTO_FIRE_STAMINA_COST_MILLI = 500;
    const AUTO_FIRE_STAMINA_MAX_MILLI = 10000;
    const AUTO_FIRE_RESERVE_SHOTS = 2; // §6.1:为退出/躲避保留的连发余量(发)。
    const AUTO_FIRE_LEAD_MIN_MS = 60;
    const AUTO_FIRE_LEAD_MAX_MS = 1150;
    const AUTO_FIRE_BURST_MIN_SHOTS = 5;
    const AUTO_FIRE_BURST_MAX_SHOTS = 8;
    const AUTO_FIRE_BURST_SHOT_MS = AUTO_FIRE_MAX_RATE_MS;
    const PROJECTILE_MEMORY_MS = 1800;
    const MOVING_ENEMY_MEMORY_MS = 10000;
    const ENEMY_MOVE_EPSILON_CM = 30;
    const LINE_CANVAS_MAX_DPR = 1.75;
    const DROP_CLUSTER_CM = 9000;
    const ROUTE_CLUSTER_CM = 13000;
    const ROUTE_LINK_CM = 15000;
    const ROUTE_MAX_LINK_CM = 22000;
    const ROUTE_ANCHOR_LIMIT = 22;
    const ROUTE_POOL_LIMIT = 72;
    const ROUTE_MAX_POINTS_DENSE = 6;
    const ROUTE_MAX_POINTS_MID = 4;
    const ROUTE_MAX_POINTS_SPARSE = 2;
    const ROUTE_SWITCH_FACTOR = 1.14;
    const REPLAN_MS = 1800;
    // 路线总长软折扣:路线全程超过起点阈值后按软折扣压评分,让远处长路线变贵、近处金团路线相对胜出。
    // 斜率设 0 即可让本项失效;floor 限制最多砍一半,避免极端值。
    const ROUTE_LENGTH_PENALTY_START_CM = 30000;
    const ROUTE_LENGTH_PENALTY_PER_CM = 0.000018;
    const ROUTE_LENGTH_PENALTY_FLOOR = 0.5;
    // 首段路程偏好:第一颗金币在 near 内不打折;超过 far 软阈值压到 floor,抑制“突然冲很远的一颗”。
    const ROUTE_NEAR_PREFER_CM = 12000;
    const ROUTE_FAR_SOFT_CM = 35000;
    const ROUTE_FAR_FACTOR_FLOOR = 0.28;
    const DROP_LEADERBOARD_REFRESH_MS = 10000;
    const DROP_LEADERBOARD_ENTRY_REFRESH_DELAY_MS = 3000;
    const STEP_TICK_MS = 150;
    const COMBAT_FAST_TICK_MS = 50;
    const AXIS_DOMINANCE_RATIO = 1.65;
    // 八向移动时间估算:斜对角按 35cm/tick、沿轴按 42cm/tick。
    // 原沿轴用 50(过快),让恰好在斜对角方向的远金币秒收益被高估、压过近处金团。沿轴调到 42 让远点重新变贵。
    const TRAVEL_TICK_DIAGONAL_DIV = 35;
    const TRAVEL_TICK_AXIS_DIV = 42;
    const HUNT_REACHED_CM = 260;
    const HUNT_LOST_MEMORY_MS = 12000;
    const HUNT_PREDICT_MIN_MS = 350;
    const HUNT_PREDICT_MAX_MS = 1300;
    const HUNT_PREDICT_DISTANCE_DIVISOR = 9000;
    const DANGER_ID = "codex-rat-danger-vignette";
    const MANUAL_TARGET_REACHED_CM = 160;
    const MOVE_KEYS = ["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"];

    if (window[RUNNER_KEY] && typeof window[RUNNER_KEY].destroy === "function") {
      window[RUNNER_KEY].destroy("replaced");
    } else if (window[RUNNER_KEY] && typeof window[RUNNER_KEY].stop === "function") {
      window[RUNNER_KEY].stop("replaced");
    }

      const existingPanel = document.getElementById(PANEL_ID);
      if (existingPanel) existingPanel.remove();
      const existingDanger = document.getElementById(DANGER_ID);
      if (existingDanger) existingDanger.remove();

    const ready = () => {
      try {
        return typeof state !== "undefined"
          && typeof els !== "undefined"
          && typeof sendVelocity === "function"
          && state
          && els;
      } catch (_) {
        return false;
      }
    };

    let waitTimer = 0;
    let waitCount = 0;

    function waitForGame() {
      if (ready()) {
        clearInterval(waitTimer);
        setupRunner();
        return;
      }
      waitCount += 1;
      if (waitCount > 240) {
        console.warn("[RatGoldRunner] Game variables not found. Reload the game page and try again.");
        clearInterval(waitTimer);
      }
    }

    waitTimer = window.setInterval(waitForGame, 500);
    waitForGame();

    function setupRunner() {
      const root = document.createElement("section");
      root.id = PANEL_ID;
      root.innerHTML = [
        '<div class="crgr-frame">',
        '  <canvas class="crgr-lines" data-crgr="line-canvas" aria-hidden="true"></canvas>',
        '  <div class="crgr-corner c1"></div>',
        '  <div class="crgr-corner c2"></div>',
        '  <div class="crgr-corner c3"></div>',
        '  <div class="crgr-corner c4"></div>',
        '  <div class="crgr-head">',
        '    <span class="crgr-tag">RAT GOLD RUNNER</span>',
        '    <strong data-crgr="mode">STANDBY</strong>',
        '    <button type="button" data-crgr="collapse" title="折叠/展开">HUD</button>',
        '  </div>',
        '  <div class="crgr-attack-lock">',
        '    <button type="button" class="crgr-auto-attack" data-crgr="auto-fire">自动攻击</button>',
        '    <div class="crgr-attack-head"><span>ATTACK BUFFER</span><small data-crgr="attack-lock-summary">AUTO</small></div>',
        '    <div class="crgr-attack-list" data-crgr="attack-list"><button type="button" disabled>扫描中</button></div>',
        '  </div>',
        '  <div class="crgr-core">',
        '    <div class="crgr-reticle"><span></span><span></span><span></span><span></span></div>',
        '    <div class="crgr-action" data-crgr="action">等待启动</div>',
        '    <div class="crgr-grid">',
        '      <div><b data-crgr="hp">--</b><small>HP</small></div>',
        '      <div><b data-crgr="gain">+0</b><small>GAIN</small></div>',
        '      <div><b data-crgr="target">--</b><small>TARGET</small></div>',
        '      <div><b data-crgr="move">idle</b><small>MOVE</small></div>',
        '    </div>',
        '    <div class="crgr-line"><span>THREAT</span><b data-crgr="threat">--</b></div>',
        '    <div class="crgr-line"><span>STAMINA</span><b data-crgr="stamina">--</b></div>',
        '    <div class="crgr-line"><span>SAFETY</span><b data-crgr="safety">LEAVE 0 / EVADE 0</b></div>',
        '  </div>',
        '  <div class="crgr-body">',
        '    <div class="crgr-hunt-row">',
        '      <label>追杀用户名 <input data-crgr="hunt-query" placeholder="用户名片段" /></label>',
        '      <button type="button" data-crgr="hunt">追杀</button>',
        '    </div>',
        '    <div class="crgr-drop-board">',
        '      <div class="crgr-drop-head"><span>DROP TOP 5</span><small data-crgr="drop-refresh">--</small></div>',
        '      <ol data-crgr="drop-list"><li>扫描中</li></ol>',
        '    </div>',
        '    <div class="crgr-actions">',
        '      <button type="button" data-crgr="start">启动</button>',
        '      <button type="button" data-crgr="stop">停止</button>',
        '      <button type="button" data-crgr="combat">临时交战</button>',
        '      <button type="button" data-crgr="reconnect">重连 ON</button>',
        '      <button type="button" data-crgr="reconnect-clear" title="清理重连流程/离开记录/ack">清理重连</button>',
        '      <button type="button" data-crgr="reconnect-retry" title="清掉失败/终态后仅本次重试">仅本次重试</button>',
        '      <button type="button" data-crgr="leave">离开</button>',
        '    </div>',
        '    <pre data-crgr="status">READY</pre>',
        '  </div>',
        '</div>',
      ].join("");
      document.body.appendChild(root);

      const style = document.createElement("style");
      style.textContent = `
        #${PANEL_ID} {
          position: fixed;
          top: 0;
          right: 0;
          bottom: 0;
          left: var(--crgr-scene-left, 384px);
          z-index: 2147483647;
          color: #e5edf8;
          font: clamp(14px, 0.72vw, 20px)/1.35 "Microsoft YaHei", "Microsoft YaHei UI", "SimHei", "Heiti SC", Arial, sans-serif;
          pointer-events: none;
          text-shadow: 0 0 10px rgba(125, 211, 252, .45);
        }
        #${PANEL_ID} .crgr-frame {
          position: absolute;
          inset: 0;
          background:
            linear-gradient(90deg, rgba(34, 211, 238, .035), transparent 16%, transparent 84%, rgba(34, 211, 238, .035)),
            linear-gradient(180deg, rgba(14, 165, 233, .04), transparent 18%, transparent 82%, rgba(14, 165, 233, .03));
          box-shadow: inset 0 0 36px rgba(14, 165, 233, .045);
        }
        #${PANEL_ID} .crgr-lines {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          display: block;
          pointer-events: none;
          z-index: 0;
        }
        #${PANEL_ID}.collapsed .crgr-core,
        #${PANEL_ID}.collapsed .crgr-body {
          display: none;
        }
        #${PANEL_ID} .crgr-corner {
          position: absolute;
          width: 72px;
          height: 44px;
          border-color: rgba(103, 232, 249, .38);
          pointer-events: none;
        }
        #${PANEL_ID} .c1 { left: 14px; top: 14px; border-left: 2px solid; border-top: 2px solid; }
        #${PANEL_ID} .c2 { right: 14px; top: 14px; border-right: 2px solid; border-top: 2px solid; }
        #${PANEL_ID} .c3 { left: 14px; bottom: 14px; border-left: 2px solid; border-bottom: 2px solid; }
        #${PANEL_ID} .c4 { right: 14px; bottom: 14px; border-right: 2px solid; border-bottom: 2px solid; }
        #${PANEL_ID} .crgr-head {
          position: absolute;
          left: 50%;
          top: 16px;
          transform: translateX(-50%);
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          min-width: 270px;
          padding: 7px 12px;
          color: #a5f3fc;
          letter-spacing: .08em;
          background: rgba(2, 6, 23, .46);
          border: 1px solid rgba(125, 211, 252, .16);
        }
        #${PANEL_ID} .crgr-tag {
          color: rgba(186, 230, 253, .78);
          font-size: 11px;
        }
        #${PANEL_ID} .crgr-head strong {
          color: #f8fafc;
          font-size: clamp(15px, .78vw, 22px);
        }
        #${PANEL_ID} .crgr-core {
          position: absolute;
          inset: 0;
        }
        #${PANEL_ID} .crgr-reticle {
          display: none;
        }
        #${PANEL_ID} .crgr-action {
          position: absolute;
          left: 50%;
          top: 122px;
          transform: translateX(-50%);
          width: min(680px, calc(100% - 40px));
          min-height: 46px;
          padding: 9px 14px;
          color: #fef9c3;
          font-size: clamp(21px, 1.08vw, 32px);
          font-weight: 700;
          text-align: center;
          text-transform: uppercase;
          background: rgba(2, 6, 23, .42);
          border: 1px solid rgba(250, 204, 21, .14);
        }
        #${PANEL_ID} .crgr-grid {
          position: absolute;
          left: 50%;
          bottom: 20px;
          transform: translateX(-50%);
          width: min(720px, calc(100% - 40px));
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 8px;
        }
        #${PANEL_ID} .crgr-grid div,
        #${PANEL_ID} .crgr-line {
          background: rgba(2, 6, 23, .38);
          border: 1px solid rgba(125, 211, 252, .14);
          box-shadow: inset 0 0 18px rgba(14, 165, 233, .05);
        }
        #${PANEL_ID} .crgr-grid div {
          display: grid;
          gap: 2px;
          min-height: 64px;
          place-items: center;
          padding: 8px;
          background: rgba(2, 6, 23, .36);
        }
        #${PANEL_ID} .crgr-grid b {
          color: #e0f2fe;
          font-size: clamp(20px, 1.05vw, 30px);
          max-width: 100%;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        #${PANEL_ID} small,
        #${PANEL_ID} .crgr-line span {
          color: rgba(186, 230, 253, .62);
          font-size: clamp(11px, .58vw, 16px);
          letter-spacing: .12em;
        }
        #${PANEL_ID} .crgr-line {
          position: relative;
          display: flex;
          justify-content: space-between;
          gap: 10px;
          min-width: min(330px, calc(100% - 36px));
          max-width: min(560px, calc(100% - 36px));
          padding: 7px 10px;
          background: rgba(2, 6, 23, .36);
        }
        #${PANEL_ID} .crgr-line b {
          color: #cffafe;
          font-weight: 600;
          font-size: clamp(15px, .78vw, 22px);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        #${PANEL_ID} .crgr-line:nth-of-type(4) {
          position: absolute;
          left: 18px;
          top: 78px;
        }
        #${PANEL_ID} .crgr-line:nth-of-type(5) {
          position: absolute;
          right: 18px;
          top: 78px;
        }
        #${PANEL_ID} .crgr-line:nth-of-type(6) {
          position: absolute;
          right: 18px;
          bottom: 86px;
        }
        #${PANEL_ID} .crgr-attack-lock {
          position: absolute;
          left: 18px;
          top: 184px;
          width: min(360px, calc(100% - 36px));
          max-height: min(38vh, 360px);
          display: grid;
          gap: 6px;
          padding: 8px;
          color: rgba(226, 232, 240, .82);
          background: rgba(2, 6, 23, .38);
          border: 1px solid rgba(125, 211, 252, .14);
          pointer-events: auto;
        }
        #${PANEL_ID} .crgr-auto-attack {
          min-height: 36px;
          color: #bae6fd;
          background: rgba(8, 47, 73, .34);
          border-color: rgba(56, 189, 248, .42);
          font-weight: 700;
          letter-spacing: .08em;
        }
        #${PANEL_ID} .crgr-auto-attack.active {
          color: #ecfeff;
          background: rgba(8, 47, 73, .62);
          box-shadow: inset 0 0 18px rgba(56, 189, 248, .16), 0 0 18px rgba(56, 189, 248, .1);
        }
        #${PANEL_ID} .crgr-attack-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          color: rgba(186, 230, 253, .72);
        }
        #${PANEL_ID} .crgr-attack-head span {
          color: #fecaca;
          font-size: clamp(12px, .62vw, 18px);
          font-weight: 700;
          letter-spacing: .08em;
        }
        #${PANEL_ID} .crgr-attack-head small {
          min-width: 0;
          color: rgba(254, 249, 195, .82);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        #${PANEL_ID} .crgr-attack-list {
          display: grid;
          gap: 4px;
          max-height: min(30vh, 280px);
          overflow: auto;
        }
        #${PANEL_ID} .crgr-attack-list button {
          display: grid;
          grid-template-columns: minmax(0, 1fr) minmax(46px, auto) minmax(48px, auto);
          gap: 6px;
          align-items: center;
          min-height: 28px;
          padding: 0 7px;
          color: rgba(226, 232, 240, .86);
          text-align: left;
          background: rgba(15, 23, 42, .18);
          border-color: rgba(125, 211, 252, .12);
        }
        #${PANEL_ID} .crgr-attack-list button.active {
          color: #fff7ed;
          background: rgba(127, 29, 29, .42);
          border-color: rgba(248, 113, 113, .46);
        }
        #${PANEL_ID} .crgr-attack-name {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        #${PANEL_ID} .crgr-attack-hp {
          color: #fecaca;
          text-align: right;
          font-variant-numeric: tabular-nums;
        }
        #${PANEL_ID} .crgr-attack-dist {
          color: rgba(186, 230, 253, .72);
          text-align: right;
          font-variant-numeric: tabular-nums;
        }
        #${PANEL_ID} .crgr-body {
          position: absolute;
          left: 18px;
          bottom: 86px;
          width: min(520px, calc(100% - 36px));
          display: grid;
          grid-template-columns: 1fr;
          gap: 8px;
          align-items: end;
          padding: 8px;
          background: rgba(2, 6, 23, .42);
          border: 1px solid rgba(125, 211, 252, .14);
          pointer-events: auto;
        }
        #${PANEL_ID} label { display: grid; gap: 4px; color: #b9c7d8; }
        #${PANEL_ID} .crgr-hunt-row {
          display: grid;
          grid-template-columns: 1fr minmax(82px, auto);
          gap: 6px;
          align-items: end;
        }
        #${PANEL_ID} .crgr-drop-board {
          padding: 7px 8px;
          background: rgba(2, 6, 23, .28);
          border: 1px solid rgba(125, 211, 252, .12);
        }
        #${PANEL_ID} .crgr-drop-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          margin-bottom: 5px;
          color: rgba(186, 230, 253, .74);
        }
        #${PANEL_ID} .crgr-drop-head span {
          color: #fef3c7;
          font-size: clamp(12px, .62vw, 18px);
          font-weight: 700;
          letter-spacing: .08em;
        }
        #${PANEL_ID} .crgr-drop-head small {
          color: rgba(186, 230, 253, .55);
          letter-spacing: 0;
          white-space: nowrap;
        }
        #${PANEL_ID} .crgr-drop-board ol {
          display: grid;
          gap: 3px;
          margin: 0;
          padding: 0;
          list-style: none;
        }
        #${PANEL_ID} .crgr-drop-board li {
          display: grid;
          grid-template-columns: 24px minmax(0, 1fr) minmax(44px, auto);
          gap: 6px;
          align-items: center;
          min-height: 26px;
          color: rgba(226, 232, 240, .78);
          font-size: clamp(12px, .62vw, 18px);
        }
        #${PANEL_ID} .crgr-drop-rank {
          color: rgba(250, 204, 21, .78);
          text-align: right;
          font-variant-numeric: tabular-nums;
        }
        #${PANEL_ID} .crgr-drop-name {
          min-width: 0;
          height: 26px;
          padding: 0 6px;
          color: #e0f2fe;
          text-align: left;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          background: rgba(15, 23, 42, .16);
          border-color: rgba(125, 211, 252, .12);
        }
        #${PANEL_ID} .crgr-drop-name:hover {
          color: #fef9c3;
          background: rgba(113, 63, 18, .4);
        }
        #${PANEL_ID} .crgr-drop-name[disabled] {
          color: rgba(148, 163, 184, .72);
          cursor: default;
        }
        #${PANEL_ID} .crgr-drop-value {
          color: #fde68a;
          text-align: right;
          font-weight: 700;
          font-variant-numeric: tabular-nums;
        }
        #${PANEL_ID} input {
          width: 100%;
          height: 26px;
          padding: 0 8px;
          color: #eaf3ff;
          background: rgba(15, 23, 42, .22);
          border: 1px solid rgba(148, 163, 184, .22);
          border-radius: 4px;
          outline: none;
          font: inherit;
        }
        #${PANEL_ID} .crgr-actions {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 6px;
        }
        #${PANEL_ID} button {
          min-height: 34px;
          color: #eaf3ff;
          background: rgba(15, 23, 42, .2);
          border: 1px solid rgba(125, 211, 252, .22);
          border-radius: 4px;
          cursor: pointer;
          font: inherit;
          pointer-events: auto;
        }
        #${PANEL_ID} button:hover { background: rgba(8, 47, 73, .72); }
        #${PANEL_ID} button.crgr-drop-name {
          min-height: 26px;
        }
        #${PANEL_ID} button[data-crgr="start"] { border-color: rgba(74, 222, 128, .45); color: #bbf7d0; }
        #${PANEL_ID} button[data-crgr="stop"] { border-color: rgba(251, 191, 36, .45); color: #fde68a; }
        #${PANEL_ID} button[data-crgr="combat"] { border-color: rgba(248, 113, 113, .42); color: #fecaca; }
        #${PANEL_ID} button[data-crgr="hunt"] { border-color: rgba(250, 204, 21, .42); color: #fef3c7; }
        #${PANEL_ID} button[data-crgr="reconnect"] { border-color: rgba(74, 222, 128, .42); color: #bbf7d0; }
        #${PANEL_ID} button[data-crgr="reconnect"].active {
          color: #f0fdf4;
          background: rgba(20, 83, 45, .42);
          box-shadow: inset 0 0 18px rgba(74, 222, 128, .14), 0 0 18px rgba(74, 222, 128, .08);
        }
        #${PANEL_ID} button[data-crgr="combat"].active {
          color: #fff7ed;
          background: rgba(127, 29, 29, .42);
          box-shadow: inset 0 0 18px rgba(248, 113, 113, .16), 0 0 18px rgba(248, 113, 113, .1);
        }
        #${PANEL_ID} button[data-crgr="hunt"].active {
          color: #fffbeb;
          background: rgba(113, 63, 18, .44);
          box-shadow: inset 0 0 18px rgba(250, 204, 21, .14), 0 0 18px rgba(250, 204, 21, .08);
        }
        #${PANEL_ID} button[data-crgr="leave"] { border-color: rgba(248, 113, 113, .55); color: #fecaca; }
        #${PANEL_ID} pre {
          grid-column: 1 / -1;
          margin: 0;
          padding: 0;
          color: rgba(186, 230, 253, .74);
          background: transparent;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          font-size: clamp(12px, .62vw, 18px);
        }
        #${PANEL_ID}.running .crgr-frame {
          box-shadow: inset 0 0 40px rgba(45, 212, 191, .045);
        }
        #${PANEL_ID}.danger .crgr-frame {
          box-shadow: inset 0 0 52px rgba(127, 29, 29, .22);
        }
        @media (max-width: 760px) {
          #${PANEL_ID} {
            left: 0;
          }
          #${PANEL_ID} .crgr-head {
            top: 10px;
            min-width: 220px;
          }
          #${PANEL_ID} .crgr-action {
            top: 48px;
          }
          #${PANEL_ID} .crgr-line {
            min-width: 0;
            max-width: calc(50vw - 24px);
          }
          #${PANEL_ID} .crgr-body {
            width: calc(100vw - 36px);
          }
          #${PANEL_ID} .crgr-grid {
            grid-template-columns: repeat(2, 1fr);
            bottom: 10px;
            width: min(360px, calc(100vw - 36px));
          }
        }
        #${DANGER_ID} {
          position: fixed;
          inset: 0;
          z-index: 2147483646;
          pointer-events: none;
          opacity: 0;
          transition: opacity .22s ease;
          box-shadow:
            inset 0 0 0 2px rgba(248, 113, 113, .38),
            inset 0 0 48px 18px rgba(127, 29, 29, .38),
            inset 0 0 110px 42px rgba(69, 10, 10, .34);
        }
        #${DANGER_ID}.active {
          opacity: 1;
          animation: crgr-danger-pulse 1.15s ease-in-out infinite;
        }
        #${DANGER_ID}.critical {
          opacity: 1;
          animation: crgr-danger-critical .62s ease-in-out infinite;
        }
        @keyframes crgr-danger-pulse {
          0%, 100% {
            box-shadow:
              inset 0 0 0 2px rgba(248, 113, 113, .28),
              inset 0 0 44px 16px rgba(127, 29, 29, .28),
              inset 0 0 94px 36px rgba(69, 10, 10, .24);
          }
          50% {
            box-shadow:
              inset 0 0 0 3px rgba(248, 113, 113, .62),
              inset 0 0 74px 28px rgba(127, 29, 29, .56),
              inset 0 0 140px 58px rgba(69, 10, 10, .5);
          }
        }
        @keyframes crgr-danger-critical {
          0%, 100% {
            box-shadow:
              inset 0 0 0 3px rgba(248, 113, 113, .38),
              inset 0 0 88px 34px rgba(127, 29, 29, .48),
              inset 0 0 180px 76px rgba(69, 10, 10, .44);
          }
          50% {
            box-shadow:
              inset 0 0 0 5px rgba(248, 113, 113, .78),
              inset 0 0 132px 54px rgba(127, 29, 29, .72),
              inset 0 0 250px 108px rgba(69, 10, 10, .62);
          }
        }
      `;
      document.head.appendChild(style);

      const danger = document.createElement("div");
      danger.id = DANGER_ID;
      document.body.appendChild(danger);

      const ui = {
        huntQuery: root.querySelector('[data-crgr="hunt-query"]'),
        hunt: root.querySelector('[data-crgr="hunt"]'),
        attackLockSummary: root.querySelector('[data-crgr="attack-lock-summary"]'),
        attackList: root.querySelector('[data-crgr="attack-list"]'),
        lineCanvas: root.querySelector('[data-crgr="line-canvas"]'),
        dropRefresh: root.querySelector('[data-crgr="drop-refresh"]'),
        dropList: root.querySelector('[data-crgr="drop-list"]'),
        start: root.querySelector('[data-crgr="start"]'),
        stop: root.querySelector('[data-crgr="stop"]'),
        combat: root.querySelector('[data-crgr="combat"]'),
        autoFire: root.querySelector('[data-crgr="auto-fire"]'),
        leave: root.querySelector('[data-crgr="leave"]'),
        reconnect: root.querySelector('[data-crgr="reconnect"]'),
        collapse: root.querySelector('[data-crgr="collapse"]'),
        mode: root.querySelector('[data-crgr="mode"]'),
        action: root.querySelector('[data-crgr="action"]'),
        hp: root.querySelector('[data-crgr="hp"]'),
        gain: root.querySelector('[data-crgr="gain"]'),
        target: root.querySelector('[data-crgr="target"]'),
        move: root.querySelector('[data-crgr="move"]'),
        threat: root.querySelector('[data-crgr="threat"]'),
        stamina: root.querySelector('[data-crgr="stamina"]'),
        safety: root.querySelector('[data-crgr="safety"]'),
        status: root.querySelector('[data-crgr="status"]')
      };

      function updateHudSceneBounds() {
        const side = document.querySelector(".side");
        const rect = side ? side.getBoundingClientRect() : null;
        const sideRight = rect && rect.width > 0 ? Math.ceil(rect.right + 28) : 384;
        root.style.setProperty("--crgr-scene-left", sideRight + "px");
      }

      updateHudSceneBounds();
      window.addEventListener("resize", updateHudSceneBounds);

      const runner = {
        running: false,
        timer: 0,
        statusTimer: 0,
        sidebarSafetyTimer: 0,
        dropLeaderboardTimer: 0,
        dropLeaderboardEntryTimer: 0,
        dropLeaderboardEntryRefreshScheduled: false,
        lineRaf: 0,
        lineCtx: ui.lineCanvas ? ui.lineCanvas.getContext("2d") : null,
        lineDpr: 1,
        tickMs: STEP_TICK_MS,
        startedAt: 0,
        targetId: null,
        targetScore: 0,
        routeIds: [],
        routeScore: 0,
        routeValue: 0,
        routeTravelSeconds: 0,
        routeKind: "",
        routeAdvanced: false,
        // §5.7:到达金币后的确认/轻推/临时黑名单状态。
        coinArrivalId: null,
        coinArrivalAt: 0,
        coinArrivalNudges: 0,
        coinBlacklist: new Map(),
        navTarget: null,
        planNextAt: 0,
        manualTarget: null,
        huntMode: false,
        huntQuery: "",
        huntTargetId: null,
        huntTargetName: "",
        huntLastSeen: null,
        huntLastSeenAt: 0,
        combatMode: false,
        combatRisk: "clear",
        combatProjectiles: 0,
        combatTargets: 0,
        combatSpacingState: "none",
        combatSpacingMeters: null,
        autoFireMode: false,
        autoFireLastAt: 0,
        autoFireNextBurstAt: 0,
        autoFireBursting: false,
        autoFireBurstTimers: [],
        autoFireBurstClient: null,
        autoFireTarget: "",
        autoFireStatus: "OFF",
        // §6.4:统计的是"计划发数";若游戏提供弹药/体力确认再记 confirmedShots。
        plannedShots: 0,
        attackLockUserId: null,
        attackLockName: "",
        attackLockStatus: "AUTO",
        lastCombatDodge: { dx: 0, dy: 0, score: 0 },
        lastCombatSwitchAt: 0,
        combatManualOverride: false,
        userMoveKeys: new Set(),
        scriptMoveKeys: new Set(),
        lastMoveMode: "idle",
        lastHp: null,
        stoppedHpBaseline: null,
        leaveInProgress: false,
        lastBalance: null,
        deltaBalance: 0,
        leaves: 0,
        avoidances: 0,
        // §5.9: 规避计数按"事件"而非 tick。fleeing=当前是否处于持续逃离,
        // fleeKey=当前威胁敌人 key;进入逃离或威胁换敌才 +1。
        fleeing: false,
        fleeKey: "",
        hourlyLimitLeaveTriggered: false,
        autoReconnect: false,
        // 游戏契约分级(审计文档 §4.5):READY / DEGRADED / INCOMPATIBLE + 缺失字段。
        contractStatus: "UNKNOWN",
        contractReason: "",
        // 重连回游戏的"安全恢复态":刚通过自动重连回到游戏时进入,先不自动巡航,
        // 监控近身富敌和血量,确认安全后才恢复运行——避免几滴血出生在敌人旁边被秒。
        rejoinRecovery: false,
        rejoinLeaveType: "",
        rejoinSafeSince: 0,
        rejoinPeakHp: null,
        rejoinTargetHpSafe: 40,
        lastThreat: null,
        enemyMotion: new Map(),
        projectileMotion: new Map(),
        // 逃离锚点:持续被同一敌人逼近超 FLEE_ANCHOR_HOLD_MS 后,选一颗安全金币作为撤离目标顺路收币。
        // 锚点含坐标、设置时刻、目标敌人 key;敌人离开 170m 后由 step 主循环清掉。
        fleeAnchor: null,
        // 常态巡航弹道躲避 hold 截止时刻；超时后恢复金币巡航。
        cruiseDodgeUntil: 0,
        lastAction: "ready",
        lastError: "",
        log: [],
        root,
        danger,
        style
      };

      window[RUNNER_KEY] = runner;

      // 从 userscript 桥读取自动重连开关(持久化在 GM,跨域共享),默认关
      try {
        const bridge = (typeof window !== "undefined" && window.__crgrReconnect) || null;
        if (bridge && typeof bridge.readSwitch === "function") {
          runner.autoReconnect = bridge.readSwitch();
        }
      } catch (_) {}

      // 游戏契约探测(fail closed):构造字段报告,调用沙盒内唯一分类器分级。
      // READY=全部必需+关键可选都在;DEGRADED=必需在但画布/指针缺失,读展示可用、
      // 自动移动/攻击关闭;INCOMPATIBLE=必需缺失,不注入控制、提示导出诊断。
      try {
        const s = typeof state !== "undefined" ? state : null;
        const d = typeof els !== "undefined" ? els : null;
        const contractFields = {
          "state": s,
          "state.entities": s && s.entities,
          "state.coinDrops": s && s.coinDrops,
          "state.keys": s && s.keys,
          "state.currentUserId": s && s.currentUserId,
          "state.minimap": s && s.minimap ? s.minimap.points : undefined,
          "state.pointerWorld": s && s.pointerWorld,
          "sendVelocity": typeof sendVelocity !== "undefined" ? sendVelocity : undefined,
          "canvas": (d && d.canvas) || (typeof canvas !== "undefined" ? canvas : undefined),
          "screenCenter": (d && d.screenCenter) || (typeof screenCenter !== "undefined" ? screenCenter : undefined),
          "setPointerFromClient": (d && d.setPointerFromClient) || (typeof setPointerFromClient !== "undefined" ? setPointerFromClient : undefined)
        };
        const classifier = (window.__crgrContract && window.__crgrContract.classify) || null;
        const verdict = classifier ? classifier(contractFields) : null;
        if (verdict) {
          runner.contractStatus = verdict.status;
          runner.contractReport = verdict.report || null;
          runner.contractReason = verdict.missing.length
            ? "缺失必需字段: " + verdict.missing.join(", ")
            : verdict.criticalMissing.length
              ? "缺失关键可选(画布/指针): " + verdict.criticalMissing.join(", ")
              : "";
          runner.stepReady = verdict.status !== "INCOMPATIBLE";
          runner.fireReady = verdict.status === "READY";
        }
      } catch (_) {
        runner.contractStatus = "UNKNOWN";
        runner.stepReady = true;
        runner.fireReady = true;
      }

      const nowText = () => new Date().toLocaleTimeString();
      const push = message => {
        runner.lastAction = message;
        runner.log.push(nowText() + " " + message);
        if (runner.log.length > 80) runner.log.shift();
      };

      function getMe() {
        return state.entities.find(entity => Number(entity.user_id) === Number(state.currentUserId));
      }

      function clearScriptMoveKeys(send) {
        for (const key of runner.scriptMoveKeys) {
          state.keys.delete(key);
        }
        runner.scriptMoveKeys.clear();
        if (send) sendVelocity(true);
      }

      function addScriptMoveKey(key) {
        runner.scriptMoveKeys.add(key);
        state.keys.add(key);
      }

      function setVelocity(dx, dy, options) {
        const preserveUser = options && options.preserveUser;
        if (preserveUser) {
          clearScriptMoveKeys(false);
        } else {
          // §5.10:只清脚本自己添加的键,绝不删除用户真实按下的移动键。
          for (const key of runner.scriptMoveKeys) {
            state.keys.delete(key);
          }
          runner.scriptMoveKeys.clear();
        }
        if (dx < 0) addScriptMoveKey("a");
        if (dx > 0) addScriptMoveKey("d");
        if (dy < 0) addScriptMoveKey("w");
        if (dy > 0) addScriptMoveKey("s");
        sendVelocity(true);
      }

      function stopMove() {
        setVelocity(0, 0);
        runner.lastMoveMode = "idle";
        runner.navTarget = null;
      }

      function movementKeyFromEvent(event) {
        const key = String(event && event.key || "").toLowerCase();
        return MOVE_KEYS.includes(key) ? key : "";
      }

      function isTypingTarget(target) {
        const tag = String(target && target.tagName || "").toLowerCase();
        return tag === "input"
          || tag === "textarea"
          || tag === "select"
          || !!(target && target.isContentEditable);
      }

      function handleMovementKeyDown(event) {
        if (isTypingTarget(event.target)) return;
        const key = movementKeyFromEvent(event);
        if (!key) return;
        runner.userMoveKeys.add(key);
        if (runner.combatMode) {
          clearScriptMoveKeys(true);
          runner.combatManualOverride = true;
          runner.lastMoveMode = "manual-combat";
        }
      }

      function handleMovementKeyUp(event) {
        const key = movementKeyFromEvent(event);
        if (!key) return;
        runner.userMoveKeys.delete(key);
        if (runner.combatMode) clearScriptMoveKeys(true);
      }

      function clearUserMoveKeys() {
        runner.userMoveKeys.clear();
      }

      function manualMoveVector() {
        const keys = new Set(runner.userMoveKeys);
        for (const key of MOVE_KEYS) {
          if (state.keys.has(key) && !runner.scriptMoveKeys.has(key)) keys.add(key);
        }
        const dx = (keys.has("d") || keys.has("arrowright") ? 1 : 0)
          - (keys.has("a") || keys.has("arrowleft") ? 1 : 0);
        const dy = (keys.has("s") || keys.has("arrowdown") ? 1 : 0)
          - (keys.has("w") || keys.has("arrowup") ? 1 : 0);
        return { active: dx !== 0 || dy !== 0, dx, dy };
      }

      function setNavigationTarget(x, y, type) {
        const nx = Number(x);
        const ny = Number(y);
        if (!Number.isFinite(nx) || !Number.isFinite(ny)) {
          runner.navTarget = null;
          return;
        }
        runner.navTarget = {
          x: nx,
          y: ny,
          type: type || "target"
        };
      }

      function clearManualTarget(reason) {
        if (!runner.manualTarget) return;
        runner.manualTarget = null;
        clearCoinRoute();
        runner.planNextAt = 0;
        push("手动坐标目标已清除" + (reason ? "：" + reason : ""));
      }

      function setManualTarget(x, y) {
        if (runner.huntMode) {
          setHuntMode(false, "右键坐标接管");
        }
        runner.manualTarget = {
          x: Math.round(Number(x)),
          y: Math.round(Number(y)),
          setAt: Date.now()
        };
        clearCoinRoute();
        runner.planNextAt = 0;
        push("右键坐标目标 " + runner.manualTarget.x + "," + runner.manualTarget.y);
        if (!runner.running) start();
        renderStatus();
      }

      function huntQueryText() {
        return String((ui.huntQuery && ui.huntQuery.value) || runner.huntQuery || "").trim();
      }

      function clearCoinRoute() {
        runner.targetId = null;
        runner.targetScore = 0;
        runner.routeIds = [];
        runner.routeScore = 0;
        runner.routeValue = 0;
        runner.routeTravelSeconds = 0;
        runner.routeKind = "";
        runner.routeAdvanced = false;
        if (runner.navTarget && runner.navTarget.type === "coin") runner.navTarget = null;
      }

      function adoptCoinRoute(route) {
        const ids = route && Array.isArray(route.ids) ? route.ids.filter(id => Number.isFinite(Number(id))) : [];
        if (!route || !route.target || !ids.length) {
          clearCoinRoute();
          return;
        }
        runner.routeIds = ids.map(id => Number(id));
        runner.targetId = Number(route.target.drop_id);
        runner.targetScore = Number(route.score) || 0;
        runner.routeScore = runner.targetScore;
        runner.routeValue = Number(route.value) || 0;
        runner.routeTravelSeconds = Number(route.travelSeconds) || 0;
        runner.routeKind = route.kind || "";
        runner.routeAdvanced = false;
        runner.planNextAt = Date.now() + REPLAN_MS;
      }

      function clearHuntTarget() {
        runner.huntTargetId = null;
        runner.huntTargetName = "";
        runner.huntLastSeen = null;
        runner.huntLastSeenAt = 0;
      }

      function setHuntMode(active, reason) {
        const next = !!active;
        const query = huntQueryText();
        if (next && !query) {
          runner.lastAction = "追杀：请输入用户名片段";
          renderStatus();
          return;
        }
        if (runner.huntMode === next && (!next || runner.huntQuery === query)) return;
        runner.huntMode = next;
        runner.huntQuery = next ? query : "";
        clearHuntTarget();
        clearCoinRoute();
        runner.planNextAt = 0;
        if (next) {
          if (runner.manualTarget) clearManualTarget("开启自动追杀");
          push("自动追杀已开启：用户名包含 " + query);
          if (!runner.running) start();
        } else {
          if (runner.navTarget && runner.navTarget.type === "hunt") runner.navTarget = null;
          push("自动追杀已关闭" + (reason ? "：" + reason : ""));
        }
        renderLines();
        renderStatus();
      }

      function toggleHuntMode() {
        setHuntMode(!runner.huntMode, "manual");
      }

      function toggleReconnect() {
        runner.autoReconnect = runner.autoReconnect === false ? true : false;
        try {
          const bridge = (typeof window !== "undefined" && window.__crgrReconnect) || null;
          if (bridge && typeof bridge.setSwitch === "function") bridge.setSwitch(runner.autoReconnect);
        } catch (_) {}
        push(runner.autoReconnect ? "自动重连已开启" : "自动重连已关闭");
        renderStatus();
      }

      function driveManualTarget(me, label, options) {
        if (!runner.manualTarget) return false;
        const manual = manualMoveVector();
        if (options && options.respectUserInput && manual.active) {
          clearScriptMoveKeys(true);
          runner.combatManualOverride = true;
          runner.lastMoveMode = "manual-combat";
          runner.lastAction = (label || "手动") + "：WASD 接管，右键坐标保留 "
            + runner.manualTarget.x + "," + runner.manualTarget.y;
          return true;
        }
        const rx = Number(runner.manualTarget.x) - Number(me.x);
        const ry = Number(runner.manualTarget.y) - Number(me.y);
        const dist = Math.hypot(rx, ry);
        if (dist <= MANUAL_TARGET_REACHED_CM) {
          stopMove();
          clearManualTarget("已到达");
          return true;
        }
        moveToward(rx, ry, options && options.preserveUser ? { preserveUser: true } : undefined);
        setNavigationTarget(runner.manualTarget.x, runner.manualTarget.y, "manual");
        runner.lastAction = (label || "前往") + "右键坐标 "
          + runner.manualTarget.x + "," + runner.manualTarget.y
          + "，距离 " + Math.round(dist);
        clearCoinRoute();
        return true;
      }

      function handleContextMenu(event) {
        const target = event.target;
        const worldCanvas = typeof canvas !== "undefined" ? canvas : document.getElementById("world");
        if (worldCanvas && target !== worldCanvas) return;
        event.preventDefault();
        try {
          if (typeof setPointerFromClient === "function") {
            setPointerFromClient(event.clientX, event.clientY);
          }
          const point = state.pointerWorld;
          if (!point || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y))) {
            throw new Error("pointerWorld unavailable");
          }
          setManualTarget(point.x, point.y);
        } catch (err) {
          runner.lastError = "右键坐标读取失败：" + String(err && err.message || err);
          push(runner.lastError);
          renderStatus();
        }
      }

      function setDanger(active, level) {
        danger.classList.toggle("active", !!active);
        danger.classList.toggle("critical", !!active && level === "critical");
        root.classList.toggle("danger", !!active);
      }

      function steerVector(rx, ry) {
        const ax = Math.abs(rx);
        const ay = Math.abs(ry);
        if (ax < 35 && ay < 35) return { dx: 0, dy: 0, mode: "stop" };
        if (ay < 35 || ax / Math.max(1, ay) >= AXIS_DOMINANCE_RATIO) {
          return { dx: Math.sign(rx), dy: 0, mode: "x-axis" };
        }
        if (ax < 35 || ay / Math.max(1, ax) >= AXIS_DOMINANCE_RATIO) {
          return { dx: 0, dy: Math.sign(ry), mode: "y-axis" };
        }
        return { dx: Math.sign(rx), dy: Math.sign(ry), mode: "diagonal" };
      }

      function moveToward(rx, ry, options) {
        const move = steerVector(rx, ry);
        setVelocity(move.dx, move.dy, options);
        runner.lastMoveMode = move.mode;
        return move;
      }

      function enemyDrop(enemy) {
        const value = Number(enemy.death_reward_preview ?? enemy.death_drop_coins ?? 0);
        return Number.isFinite(value) ? value : 0;
      }

      function numberFrom(obj, keys, fallback) {
        for (const key of keys) {
          const value = Number(obj && obj[key]);
          if (Number.isFinite(value)) return value;
        }
        return fallback;
      }

      // 5s 体力必须是有限非负数值才可用于火控预算;未知/缺失/NaN/非数字一律 fail closed。
      // "" 与纯空白串也算未知(Number("")===0 不代表真的 0 体力)。
      function finiteStaminaMs(raw) {
        if (raw === null || raw === undefined) return null;
        if (typeof raw === "string" && raw.trim() === "") return null;
        const value = Number(raw);
        return Number.isFinite(value) && value >= 0 ? value : null;
      }

      function enemyKey(enemy) {
        return String(enemy.user_id ?? enemy.id ?? enemy.name ?? "");
      }

      function trackEnemyMotion(now) {
        now = Number.isFinite(Number(now)) ? Number(now) : Date.now();
        const seen = new Set();
        for (const entity of state.entities || []) {
          if (Number(entity.user_id) === Number(state.currentUserId)) continue;
          if (entity.life !== "Alive") continue;
          const key = enemyKey(entity);
          if (!key) continue;
          const x = Number(entity.x);
          const y = Number(entity.y);
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
          seen.add(key);
          const last = runner.enemyMotion.get(key);
          const moved = last && Math.hypot(x - last.x, y - last.y) >= ENEMY_MOVE_EPSILON_CM;
          const dt = last ? Math.max(0, (now - last.lastSeenAt) / 1000) : 0;
          const vxCmps = last && dt >= 0.05 ? (x - last.x) / dt : (last ? last.vxCmps || 0 : 0);
          const vyCmps = last && dt >= 0.05 ? (y - last.y) / dt : (last ? last.vyCmps || 0 : 0);
          runner.enemyMotion.set(key, {
            x,
            y,
            vxCmps,
            vyCmps,
            lastSeenAt: now,
            lastMovedAt: moved ? now : (last ? last.lastMovedAt : 0)
          });
        }
        for (const [key, value] of runner.enemyMotion) {
          if (!seen.has(key) && now - value.lastSeenAt > MOVING_ENEMY_MEMORY_MS * 3) {
            runner.enemyMotion.delete(key);
          }
        }
      }

      function enemyMovedRecently(enemy, now) {
        const motion = runner.enemyMotion.get(enemyKey(enemy));
        return !!motion && motion.lastMovedAt > 0 && now - motion.lastMovedAt <= MOVING_ENEMY_MEMORY_MS;
      }

      function cleanUserName(value, userId) {
        const name = String(value || "").trim();
        const generatedSuffix = String(userId || "").trim();
        if (!name || !generatedSuffix) return name;
        const lower = name.toLowerCase();
        if (name === generatedSuffix
          || lower === ("user " + generatedSuffix).toLowerCase()
          || lower === ("#" + generatedSuffix).toLowerCase()) {
          return "";
        }
        return name;
      }

      function knownNameForUser(userId) {
        const id = Number(userId);
        if (state.userNames && typeof state.userNames.get === "function") {
          const name = state.userNames.get(id) || state.userNames.get(String(userId));
          if (name) return cleanUserName(name, userId);
        }
        return "";
      }

      function huntNameFromEntity(entity, userId) {
        return cleanUserName(entity && entity.name, userId) || knownNameForUser(userId);
      }

      function leaderboardNameFromEntity(entity, userId) {
        const name = huntNameFromEntity(entity, userId);
        return {
          name: name || ("未知用户 #" + userId),
          copyName: name
        };
      }

      function leaderboardNameForUser(userId) {
        const name = knownNameForUser(userId);
        return {
          name: name || ("未知用户 #" + userId),
          copyName: name
        };
      }

      function mergeDropLeaderboardUser(byUser, userId, drop, names, source) {
        const id = Number(userId);
        const amount = Number(drop);
        if (!Number.isFinite(id) || !(amount > 0)) return;
        const existing = byUser.get(id);
        if (!existing || amount > existing.drop || (!existing.copyName && names.copyName)) {
          byUser.set(id, {
            userId: id,
            drop: amount,
            name: names.name,
            copyName: names.copyName,
            source
          });
        }
      }

      function topDropUsers() {
        const byUser = new Map();
        for (const entity of state.entities || []) {
          const userId = Number(entity && entity.user_id);
          if (!Number.isFinite(userId)) continue;
          if (entity.life && entity.life !== "Alive") continue;
          mergeDropLeaderboardUser(byUser, userId, enemyDrop(entity), leaderboardNameFromEntity(entity, userId), "entity");
        }
        const minimapPoints = state.minimap && Array.isArray(state.minimap.points) ? state.minimap.points : [];
        for (const point of minimapPoints) {
          const userId = Number(point && (point.u ?? point.user_id));
          const drop = Number(point && (point.d ?? point.drop ?? point.death_reward_preview ?? point.death_drop_coins));
          mergeDropLeaderboardUser(byUser, userId, drop, leaderboardNameForUser(userId), "minimap");
        }
        return Array.from(byUser.values())
          .sort((a, b) => b.drop - a.drop || String(a.name).localeCompare(String(b.name)))
          .slice(0, 5);
      }

      function formatClock(ms) {
        const date = new Date(Number.isFinite(Number(ms)) ? Number(ms) : Date.now());
        const pad = value => String(value).padStart(2, "0");
        return pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
      }

      function copyText(text) {
        const value = String(text || "");
        if (!value) return Promise.reject(new Error("empty text"));
        if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
          return navigator.clipboard.writeText(value);
        }
        return new Promise((resolve, reject) => {
          try {
            const textarea = document.createElement("textarea");
            textarea.value = value;
            textarea.setAttribute("readonly", "");
            textarea.style.position = "fixed";
            textarea.style.left = "-9999px";
            textarea.style.top = "0";
            document.body.appendChild(textarea);
            textarea.select();
            textarea.setSelectionRange(0, value.length);
            const ok = document.execCommand("copy");
            textarea.remove();
            if (ok) resolve();
            else reject(new Error("copy command failed"));
          } catch (err) {
            reject(err);
          }
        });
      }

      function renderDropLeaderboard() {
        if (!ui.dropList || !ui.dropRefresh) return;
        const rows = topDropUsers();
        const fragment = document.createDocumentFragment();
        if (!rows.length) {
          const item = document.createElement("li");
          item.textContent = "暂无 Drop 数据";
          fragment.appendChild(item);
        } else {
          rows.forEach((row, index) => {
            const item = document.createElement("li");
            const rank = document.createElement("span");
            const name = document.createElement("button");
            const value = document.createElement("span");
            rank.className = "crgr-drop-rank";
            rank.textContent = "#" + (index + 1);
            name.type = "button";
            name.className = "crgr-drop-name";
            name.textContent = row.name;
            name.title = row.copyName ? "点击复制并填入追杀用户名" : "未识别到真实用户名";
            if (row.copyName) name.dataset.copyName = row.copyName;
            else name.disabled = true;
            value.className = "crgr-drop-value";
            value.textContent = String(Math.round(row.drop));
            item.appendChild(rank);
            item.appendChild(name);
            item.appendChild(value);
            fragment.appendChild(item);
          });
        }
        ui.dropList.replaceChildren(fragment);
        ui.dropRefresh.textContent = "刷新 " + formatClock(Date.now());
      }

      function fillHuntQueryFromLeaderboard(name) {
        const value = String(name || "").trim();
        if (!value || !ui.huntQuery) return false;
        ui.huntQuery.value = value;
        ui.huntQuery.dispatchEvent(new Event("input", { bubbles: true }));
        ui.huntQuery.dispatchEvent(new Event("change", { bubbles: true }));
        if (runner.huntQuery !== value) {
          if (runner.huntMode) clearHuntTarget();
          runner.huntQuery = value;
        }
        return true;
      }

      function handleDropLeaderboardClick(event) {
        const button = event.target && event.target.closest ? event.target.closest(".crgr-drop-name") : null;
        if (!button || !ui.dropList || !ui.dropList.contains(button) || !button.dataset.copyName) return;
        const name = button.dataset.copyName;
        fillHuntQueryFromLeaderboard(name);
        copyText(name)
          .then(() => {
            runner.lastAction = "已复制并填入追杀用户名：" + name;
            runner.lastError = "";
            ui.dropRefresh.textContent = "已填入 " + formatClock(Date.now());
            renderStatus();
          })
          .catch(err => {
            runner.lastAction = "已填入追杀用户名：" + name;
            runner.lastError = "复制用户名失败：" + String(err && err.message || err);
            renderStatus();
          });
      }

      function scheduleEntryDropLeaderboardRefresh() {
        if (runner.dropLeaderboardEntryRefreshScheduled || !getMe()) return;
        runner.dropLeaderboardEntryRefreshScheduled = true;
        runner.dropLeaderboardEntryTimer = window.setTimeout(() => {
          runner.dropLeaderboardEntryTimer = 0;
          renderDropLeaderboard();
          if (ui.dropRefresh) ui.dropRefresh.textContent = "进入刷新 " + formatClock(Date.now());
        }, DROP_LEADERBOARD_ENTRY_REFRESH_DELAY_MS);
      }

      function renderAttackLockList(me) {
        if (!ui.attackList || !ui.attackLockSummary) return;
        const locked = me ? lockedAttackTarget(me) : null;
        if (locked) {
          const rangeText = locked.dist <= AUTO_FIRE_RANGE_CM ? "射程内" : "视野内";
          ui.attackLockSummary.textContent = "LOCK " + (locked.displayName || runner.attackLockName)
            + " / HP " + (Number.isFinite(locked.hpForFire) ? Math.round(locked.hpForFire) : "--")
            + " / " + Math.round(locked.dist / 100) + "m"
            + " / " + rangeText;
        } else {
          ui.attackLockSummary.textContent = "AUTO";
        }

        const enemies = me ? attackBufferEnemies(me) : [];
        const fragment = document.createDocumentFragment();
        if (!enemies.length) {
          const empty = document.createElement("button");
          empty.type = "button";
          empty.disabled = true;
          empty.textContent = "170m 内无敌人";
          fragment.appendChild(empty);
        } else {
          enemies.forEach(enemy => {
            const button = document.createElement("button");
            const name = document.createElement("span");
            const hp = document.createElement("span");
            const dist = document.createElement("span");
            const userId = Number(enemy.user_id);
            button.type = "button";
            button.dataset.userId = String(userId);
            button.classList.toggle("active", runner.attackLockUserId !== null && Number(runner.attackLockUserId) === userId);
            button.title = "点击锁定攻击对象";
            name.className = "crgr-attack-name";
            hp.className = "crgr-attack-hp";
            dist.className = "crgr-attack-dist";
            name.textContent = enemy.displayName || ("#" + userId);
            hp.textContent = "HP " + (Number.isFinite(enemy.hpForFire) ? Math.round(enemy.hpForFire) : "--");
            dist.textContent = Math.round(enemy.dist / 100) + "m";
            button.appendChild(name);
            button.appendChild(hp);
            button.appendChild(dist);
            fragment.appendChild(button);
          });
        }
        ui.attackList.replaceChildren(fragment);
      }

      function handleAttackListClick(event) {
        const button = event.target && event.target.closest ? event.target.closest("button[data-user-id]") : null;
        if (!button || !ui.attackList || !ui.attackList.contains(button)) return;
        const me = getMe();
        if (!me) return;
        const target = visibleAttackTargetById(me, Number(button.dataset.userId));
        if (!target) return;
        setAttackLock(target, "手动选择");
      }

      function huntCandidateFromEntity(entity, me) {
        const userId = Number(entity && entity.user_id);
        const x = Number(entity && entity.x);
        const y = Number(entity && entity.y);
        if (!Number.isFinite(userId) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
        if (Number(userId) === Number(state.currentUserId)) return null;
        if (entity.life && entity.life !== "Alive") return null;
        const name = huntNameFromEntity(entity, userId);
        if (!name) return null;
        return {
          source: "entity",
          userId,
          name,
          x,
          y,
          raw: entity,
          dist: Math.hypot(x - Number(me.x), y - Number(me.y)),
          sourcePenalty: 0
        };
      }

      function huntCandidateFromMinimap(point, me, liveIds) {
        const userId = Number(point && (point.u ?? point.user_id));
        const x = Number(point && point.x);
        const y = Number(point && point.y);
        if (!Number.isFinite(userId) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
        if (Number(userId) === Number(state.currentUserId)) return null;
        if (liveIds && liveIds.has(userId)) return null;
        const name = knownNameForUser(userId);
        if (!name) return null;
        return {
          source: "minimap",
          userId,
          name,
          x,
          y,
          raw: point,
          dist: Math.hypot(x - Number(me.x), y - Number(me.y)),
          sourcePenalty: 240000
        };
      }

      function huntCandidates(me) {
        const out = [];
        const liveIds = new Set();
        for (const entity of state.entities || []) {
          const candidate = huntCandidateFromEntity(entity, me);
          if (!candidate) continue;
          liveIds.add(candidate.userId);
          out.push(candidate);
        }

        const bestMinimapById = new Map();
        const points = state.minimap && Array.isArray(state.minimap.points) ? state.minimap.points : [];
        for (const point of points) {
          const candidate = huntCandidateFromMinimap(point, me, liveIds);
          if (!candidate || !Number.isFinite(candidate.dist)) continue;
          const existing = bestMinimapById.get(candidate.userId);
          if (!existing || candidate.dist < existing.dist) bestMinimapById.set(candidate.userId, candidate);
        }
        for (const candidate of bestMinimapById.values()) out.push(candidate);
        return out.filter(candidate => Number.isFinite(candidate.dist));
      }

      function huntMatchRank(candidate, query) {
        const name = cleanUserName(candidate && candidate.name).toLowerCase();
        const needle = String(query || "").trim().toLowerCase();
        if (!needle) return Infinity;
        if (!name) return Infinity;
        if (name === needle) return 0;
        if (name.startsWith(needle)) return 1;
        if (name.includes(needle)) return 2;
        return Infinity;
      }

      function findHuntTarget(me, query) {
        const candidates = huntCandidates(me)
          .map(candidate => ({
            ...candidate,
            matchRank: huntMatchRank(candidate, query)
          }))
          .filter(candidate => Number.isFinite(candidate.matchRank));
        if (!candidates.length) return null;

        if (runner.huntTargetId !== null) {
          const current = candidates.find(candidate => Number(candidate.userId) === Number(runner.huntTargetId));
          if (current) return current;
        }

        return candidates.sort((a, b) =>
          a.matchRank - b.matchRank
          || a.sourcePenalty - b.sourcePenalty
          || a.dist - b.dist
          || a.userId - b.userId
        )[0];
      }

      function entityVelocityCmps(entity, userId) {
        const rawVx = numberFrom(entity, ["vx", "vel_x", "velocity_x", "velocityX", "speed_x", "speedX"], NaN);
        const rawVy = numberFrom(entity, ["vy", "vel_y", "velocity_y", "velocityY", "speed_y", "speedY"], NaN);
        if (Number.isFinite(rawVx) && Number.isFinite(rawVy) && Math.hypot(rawVx, rawVy) > 0.01) {
          const tickMs = Math.max(1, Number(state.serverTickMs) || 50);
          const rawSpeed = Math.hypot(rawVx, rawVy);
          const scale = rawSpeed <= 250 ? 1000 / tickMs : 1;
          return { vx: rawVx * scale, vy: rawVy * scale };
        }
        const motion = runner.enemyMotion.get(String(userId ?? (entity && entity.user_id) ?? enemyKey(entity)));
        if (motion && (Math.abs(motion.vxCmps || 0) > 0.01 || Math.abs(motion.vyCmps || 0) > 0.01)) {
          return { vx: motion.vxCmps || 0, vy: motion.vyCmps || 0 };
        }
        return { vx: 0, vy: 0 };
      }

      function huntVelocityCmps(candidate) {
        return entityVelocityCmps(candidate.raw, candidate.userId);
      }

      function predictedHuntPoint(candidate, me) {
        const dist = Math.hypot(Number(candidate.x) - Number(me.x), Number(candidate.y) - Number(me.y));
        const leadMs = Math.min(
          HUNT_PREDICT_MAX_MS,
          Math.max(HUNT_PREDICT_MIN_MS, dist / HUNT_PREDICT_DISTANCE_DIVISOR * 1000)
        );
        const velocity = huntVelocityCmps(candidate);
        const leadSeconds = leadMs / 1000;
        return {
          x: Number(candidate.x) + velocity.vx * leadSeconds,
          y: Number(candidate.y) + velocity.vy * leadSeconds,
          leadMs,
          speed: Math.hypot(velocity.vx, velocity.vy)
        };
      }

      function liveEnemies(me, limitCm) {
        const now = Date.now();
        return (state.entities || [])
          .filter(entity => Number(entity.user_id) !== Number(state.currentUserId))
          .filter(entity => entity.life === "Alive")
          .map(entity => ({
            ...entity,
            dropForAvoid: enemyDrop(entity),
            movedRecently: enemyMovedRecently(entity, now),
            dist: Math.hypot(Number(entity.x) - Number(me.x), Number(entity.y) - Number(me.y))
          }))
          .filter(entity => Number.isFinite(entity.dist) && entity.dist <= limitCm)
          .sort((a, b) => a.dist - b.dist);
      }

      function enemyHpForDisplay(enemy) {
        return numberFrom(enemy, ["hp", "health", "life_value", "current_hp"], NaN);
      }

      function enemyDisplayName(enemy) {
        const userId = Number(enemy && enemy.user_id);
        return huntNameFromEntity(enemy, userId) || ("未知用户 #" + userId);
      }

      function decorateAttackEnemy(enemy) {
        if (!enemy) return null;
        return {
          ...enemy,
          displayName: enemyDisplayName(enemy),
          hpForFire: enemyHpForDisplay(enemy)
        };
      }

      function attackBufferEnemies(me) {
        return liveEnemies(me, RICH_ENEMY_ESCAPE_CM)
          .map(decorateAttackEnemy)
          .filter(Boolean)
          .sort((a, b) => a.dist - b.dist);
      }

      function visibleAttackTargetById(me, userId) {
        const id = Number(userId);
        if (!Number.isFinite(id)) return null;
        const target = liveEnemies(me, ENEMY_LINE_SCAN_CM)
          .find(enemy => Number(enemy.user_id) === id);
        return decorateAttackEnemy(target);
      }

      // §6.2:开火目标必须仍存活且可见,否则不能继续锁定旧坐标。
      function burstTargetStillValid(me, enemy) {
        if (!enemy || enemy.user_id == null) return false;
        const fresh = visibleAttackTargetById(me, enemy.user_id);
        if (!fresh || fresh === null) return false;
        if (fresh.life !== "Alive") return false;
        const hp = Number(fresh.hp || 0);
        if (!Number.isFinite(hp) || hp <= 0) return false;
        return true;
      }

      function clearAttackLock(reason) {
        if (runner.attackLockUserId === null) return;
        const name = runner.attackLockName || ("#" + runner.attackLockUserId);
        runner.attackLockUserId = null;
        runner.attackLockName = "";
        runner.attackLockStatus = "AUTO";
        if (reason) push("攻击锁定已解除：" + name + " / " + reason);
      }

      function setAttackLock(enemy, reason) {
        const target = decorateAttackEnemy(enemy);
        const userId = Number(target && target.user_id);
        if (!Number.isFinite(userId)) return;
        runner.attackLockUserId = userId;
        runner.attackLockName = target.displayName || ("#" + userId);
        runner.attackLockStatus = "LOCK";
        runner.autoFireTarget = runner.attackLockName;
        push("攻击目标已锁定：" + runner.attackLockName + (reason ? " / " + reason : ""));
        renderStatus();
      }

      function lockedAttackTarget(me) {
        if (runner.attackLockUserId === null) return null;
        const target = visibleAttackTargetById(me, runner.attackLockUserId);
        if (!target) {
          clearAttackLock("目标离开500m视野或已不存活");
          return null;
        }
        runner.attackLockName = target.displayName || runner.attackLockName;
        runner.attackLockStatus = target.dist <= AUTO_FIRE_RANGE_CM ? "LOCK" : "LOCK-OUT";
        return {
          ...target,
          locked: true,
          inFireRange: target.dist <= AUTO_FIRE_RANGE_CM
        };
      }

      function richEnemies(me, limitCm) {
        return liveEnemies(me, limitCm)
          .filter(entity => entity.dropForAvoid > RICH_ENEMY_MIN_DROP)
          .sort((a, b) => a.dist - b.dist);
      }

      function escapeEnemies(me, limitCm) {
        return liveEnemies(me, limitCm)
          .filter(entity => entity.dropForAvoid > RICH_ENEMY_MIN_DROP
            || (entity.dropForAvoid <= RICH_ENEMY_MIN_DROP && entity.movedRecently))
          .sort((a, b) => a.dist - b.dist);
      }

      function combatEnemies(me) {
        return liveEnemies(me, COMBAT_SCAN_CM)
          .map(enemy => ({
            ...enemy,
            hpForCombat: numberFrom(enemy, ["hp", "health", "life_value", "current_hp"], 0)
          }));
      }

      function combatSpacingEnemies(me) {
        return liveEnemies(me, COMBAT_SPACING_SCAN_CM);
      }

      function projectileSources() {
        const directKeys = ["bullets", "projectiles", "shots", "missiles", "arrows"];
        const sources = [];
        if (typeof getRenderBullets === "function") {
          try {
            const rendered = getRenderBullets();
            if (Array.isArray(rendered) && rendered.length) {
              sources.push({ name: "renderBullets", items: rendered });
            }
          } catch (_) {}
        }
        for (const key of directKeys) {
          const value = state[key];
          if (Array.isArray(value)) {
            sources.push({ name: key, items: value });
          } else if (value instanceof Map) {
            sources.push({ name: key, items: Array.from(value.values()) });
          } else if (value && typeof value === "object") {
            sources.push({ name: key, items: Object.values(value) });
          }
        }
        const entityProjectiles = (state.entities || []).filter(entity => {
          const label = String(entity.type || entity.kind || entity.entity_type || entity.role || "").toLowerCase();
          return label.includes("bullet")
            || label.includes("projectile")
            || label.includes("shot")
            || label.includes("missile");
        });
        if (entityProjectiles.length) sources.push({ name: "entities", items: entityProjectiles });
        return sources;
      }

      function projectileKey(raw, source, index) {
        return String(raw.projectile_id ?? raw.bullet_id ?? raw.shot_id ?? raw.id ?? raw.uid ?? (source + ":" + index));
      }

      function projectileOwner(raw) {
        return numberFrom(raw, ["owner_user_id", "owner_id", "shooter_user_id", "shooter_id", "from_user_id", "user_id"], NaN);
      }

      function projectileVelocity(raw, previous, now) {
        let vx = numberFrom(raw, ["vx", "vel_x", "velocity_x", "velocityX", "speed_x", "speedX", "dx", "dir_x", "direction_x"], NaN);
        let vy = numberFrom(raw, ["vy", "vel_y", "velocity_y", "velocityY", "speed_y", "speedY", "dy", "dir_y", "direction_y"], NaN);
        if ((!Number.isFinite(vx) || !Number.isFinite(vy)) && previous) {
          const dt = Math.max(0.05, (now - previous.seenAt) / 1000);
          vx = (numberFrom(raw, ["x", "pos_x", "world_x", "cx"], previous.x) - previous.x) / dt;
          vy = (numberFrom(raw, ["y", "pos_y", "world_y", "cy"], previous.y) - previous.y) / dt;
        }
        if (!Number.isFinite(vx) || !Number.isFinite(vy)) return { vx: 0, vy: 0 };
        return { vx, vy };
      }

      function renderTickForProjectile(raw) {
        const localNowTick = Number(raw.local_now_tick);
        if (Number.isFinite(localNowTick)) return localNowTick;
        if (typeof getRenderTick === "function") {
          try {
            const tick = Number(getRenderTick());
            if (Number.isFinite(tick)) return tick;
          } catch (_) {}
        }
        const localStartTick = Number(raw.localStartTick);
        const localStartedAt = Number(raw.localStartedAt);
        const tickMs = Number(state.serverTickMs);
        if (Number.isFinite(localStartTick)
          && Number.isFinite(localStartedAt)
          && Number.isFinite(tickMs)
          && tickMs > 0
          && typeof performance !== "undefined") {
          return localStartTick + (performance.now() - localStartedAt) / tickMs;
        }
        return Number(raw.created_tick);
      }

      function projectileFromKinematics(raw) {
        const startX = numberFrom(raw, ["start_x", "origin_x", "from_x"], NaN);
        const startY = numberFrom(raw, ["start_y", "origin_y", "from_y"], NaN);
        const createdTick = Number(raw.created_tick);
        if (!Number.isFinite(startX) || !Number.isFinite(startY) || !Number.isFinite(createdTick)) return null;

        const tick = renderTickForProjectile(raw);
        if (!Number.isFinite(tick)) return null;
        const expireTick = Number(raw.expire_tick);
        if (Number.isFinite(expireTick) && tick > expireTick + 0.5) return null;

        let dx = Number(raw.dir_x_micros) / 1000000;
        let dy = Number(raw.dir_y_micros) / 1000000;
        if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) < 0.001) {
          dx = numberFrom(raw, ["target_x", "to_x"], startX) - startX;
          dy = numberFrom(raw, ["target_y", "to_y"], startY) - startY;
          const length = Math.hypot(dx, dy);
          if (length < 1) return null;
          dx /= length;
          dy /= length;
        } else {
          const length = Math.hypot(dx, dy);
          dx /= length;
          dy /= length;
        }

        const speedPerTick = numberFrom(raw, ["speed_per_tick", "speedPerTick"], 500);
        const range = numberFrom(raw, ["range_cm", "range", "max_range_cm"], 15000);
        const ageTicks = Math.max(0, tick - createdTick);
        const travelled = Math.min(Math.max(0, range), Math.max(0, ageTicks * speedPerTick));
        const tickMs = Math.max(1, Number(state.serverTickMs) || 50);
        const speedPerSecond = speedPerTick * 1000 / tickMs;

        return {
          x: startX + dx * travelled,
          y: startY + dy * travelled,
          vx: dx * speedPerSecond,
          vy: dy * speedPerSecond
        };
      }

      function normalizeProjectile(raw, previous, now) {
        const kinematic = projectileFromKinematics(raw);
        if (kinematic) return kinematic;

        const x = numberFrom(raw, ["x", "pos_x", "world_x", "cx"], NaN);
        const y = numberFrom(raw, ["y", "pos_y", "world_y", "cy"], NaN);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        const velocity = projectileVelocity(raw, previous, now);
        return {
          x,
          y,
          vx: velocity.vx,
          vy: velocity.vy
        };
      }

      function activeProjectiles(me, now) {
        const seen = new Set();
        const projectiles = [];
        for (const source of projectileSources()) {
          source.items.forEach((raw, index) => {
            if (!raw || typeof raw !== "object") return;
            const owner = projectileOwner(raw);
            if (Number.isFinite(owner) && Number(owner) === Number(state.currentUserId)) return;
            const key = projectileKey(raw, source.name, index);
            if (seen.has(key)) return;
            const previous = runner.projectileMotion.get(key);
            const normalized = normalizeProjectile(raw, previous, now);
            if (!normalized) return;
            const dist = Math.hypot(normalized.x - Number(me.x), normalized.y - Number(me.y));
            if (!Number.isFinite(dist) || dist > COMBAT_DODGE_SCAN_CM) return;
            runner.projectileMotion.set(key, {
              x: normalized.x,
              y: normalized.y,
              vx: normalized.vx,
              vy: normalized.vy,
              seenAt: now
            });
            seen.add(key);
            projectiles.push({
              key,
              x: normalized.x,
              y: normalized.y,
              vx: normalized.vx,
              vy: normalized.vy,
              dist
            });
          });
        }
        for (const [key, value] of runner.projectileMotion) {
          if (!seen.has(key) && now - value.seenAt > PROJECTILE_MEMORY_MS) {
            runner.projectileMotion.delete(key);
          }
        }
        return projectiles.sort((a, b) => a.dist - b.dist);
      }

      function projectileRisk(projectile, point, seconds) {
        const speed = Math.hypot(projectile.vx, projectile.vy);
        if (speed < 20) {
          const dist = Math.hypot(Number(point.x) - projectile.x, Number(point.y) - projectile.y);
          return Math.max(0, 1 - dist / 6500) * 120;
        }
        const ux = projectile.vx / speed;
        const uy = projectile.vy / speed;
        const bulletX = projectile.x + projectile.vx * seconds;
        const bulletY = projectile.y + projectile.vy * seconds;
        const relX = Number(point.x) - bulletX;
        const relY = Number(point.y) - bulletY;
        const along = relX * ux + relY * uy;
        const perp = Math.abs(relX * uy - relY * ux);
        const proximity = Math.hypot(relX, relY);
        const forward = along > -1200 ? 1 : 0.28;
        const perpRisk = Math.max(0, 1 - perp / 5600) * 190 * forward;
        const nearRisk = Math.max(0, 1 - proximity / 4600) * 260;
        return perpRisk + nearRisk;
      }

      function combatProjectilePressure(projectiles, me) {
        const point = { x: Number(me.x), y: Number(me.y) };
        let pressure = 0;
        for (const projectile of projectiles.slice(0, 5)) {
          pressure += projectileRisk(projectile, point, 0.1);
          pressure += projectileRisk(projectile, point, 0.35) * 0.75;
        }
        return pressure;
      }

      function combatSpacingState(enemies) {
        const nearest = (enemies || []).find(enemy => Number.isFinite(Number(enemy.dist)));
        if (!nearest) return { state: "none", distance: Infinity };
        const distance = Number(nearest.dist);
        if (distance < COMBAT_RANGE_MIN_CM) return { state: "too-close", distance };
        if (distance > COMBAT_RANGE_MAX_CM) return { state: "too-far", distance };
        return { state: "band", distance };
      }

      function combatRangeError(dist) {
        if (!Number.isFinite(dist)) return 0;
        if (dist < COMBAT_RANGE_HARD_MIN_CM) {
          return (COMBAT_RANGE_MIN_CM - dist) * 1.8
            + (COMBAT_RANGE_HARD_MIN_CM - dist) * 3.2
            + 4200;
        }
        if (dist < COMBAT_RANGE_MIN_CM) return (COMBAT_RANGE_MIN_CM - dist) * 1.8 + 900;
        if (dist > COMBAT_RANGE_MAX_CM) return (dist - COMBAT_RANGE_MAX_CM) * 0.72;
        return Math.abs(dist - COMBAT_RANGE_IDEAL_CM) * 0.16;
      }

      function combatSpacingScore(me, dir, enemies) {
        if (!enemies || !enemies.length) return 0;
        const next = {
          x: Number(me.x) + dir.dx * COMBAT_DODGE_SPEED_CMPS,
          y: Number(me.y) + dir.dy * COMBAT_DODGE_SPEED_CMPS
        };
        let score = 0;
        enemies.slice(0, 3).forEach((enemy, index) => {
          const currentDist = Number(enemy.dist);
          const nextDist = Math.hypot(next.x - Number(enemy.x), next.y - Number(enemy.y));
          if (!Number.isFinite(currentDist) || !Number.isFinite(nextDist)) return;
          const weight = index === 0 ? 1 : index === 1 ? 0.48 : 0.26;
          const improvement = combatRangeError(currentDist) - combatRangeError(nextDist);
          score += improvement * weight / 13;

          if (nextDist < COMBAT_RANGE_HARD_MIN_CM) {
            score -= (720 + (COMBAT_RANGE_HARD_MIN_CM - nextDist) / 12) * weight;
          } else if (nextDist < COMBAT_RANGE_MIN_CM) {
            score -= (310 + (COMBAT_RANGE_MIN_CM - nextDist) / 24) * weight;
          } else if (nextDist <= COMBAT_RANGE_MAX_CM) {
            score += (190 - Math.abs(nextDist - COMBAT_RANGE_IDEAL_CM) / 44) * weight;
          } else {
            score -= Math.min(180, (nextDist - COMBAT_RANGE_MAX_CM) / 42) * weight;
          }

          if (currentDist < COMBAT_RANGE_MIN_CM && nextDist < currentDist - 80) score -= 420 * weight;
          if (currentDist > COMBAT_RANGE_MAX_CM && nextDist > currentDist + 80) score -= 210 * weight;
        });
        return score;
      }

      function scoreCombatDirection(me, dir, projectiles, spacingEnemies, options) {
        const horizons = [0.25, 0.5, 0.85, 1.2];
        let score = 0;
        for (const seconds of horizons) {
          const point = {
            x: Number(me.x) + dir.dx * COMBAT_DODGE_SPEED_CMPS * seconds,
            y: Number(me.y) + dir.dy * COMBAT_DODGE_SPEED_CMPS * seconds
          };
          for (const projectile of projectiles) {
            score -= projectileRisk(projectile, point, seconds);
          }
        }
        const spacingWeight = options && Number.isFinite(options.spacingWeight) ? options.spacingWeight : 1;
        score += combatSpacingScore(me, dir, spacingEnemies) * spacingWeight;
        const last = runner.lastCombatDodge || { dx: 0, dy: 0 };
        if (dir.dx === last.dx && dir.dy === last.dy) {
          score += projectiles.length ? 180 : 90;
        } else {
          score -= Date.now() - runner.lastCombatSwitchAt < COMBAT_DODGE_SWITCH_MS ? 210 : 70;
          if (dir.dx === -last.dx && dir.dy === -last.dy) score -= 180;
        }
        return score;
      }

      function chooseCombatDodge(me, projectiles, spacingEnemies) {
        const spacing = combatSpacingState(spacingEnemies);
        if (!projectiles.length && spacing.state !== "too-close" && spacing.state !== "too-far") {
          return { dx: 0, dy: 0, score: 0, count: 0, spacingState: spacing.state, spacingDistance: spacing.distance };
        }
        const dirs = [
          { dx: 0, dy: 0 },
          { dx: 1, dy: 0 },
          { dx: -1, dy: 0 },
          { dx: 0, dy: 1 },
          { dx: 0, dy: -1 },
          { dx: 1, dy: 1 },
          { dx: 1, dy: -1 },
          { dx: -1, dy: 1 },
          { dx: -1, dy: -1 }
        ];
        const pressure = combatProjectilePressure(projectiles, me);
        const closeProjectile = pressure >= COMBAT_CLOSE_PROJECTILE_PRESSURE
          || projectiles.some(projectile => projectile.dist < COMBAT_RANGE_MIN_CM);
        const options = {
          spacingWeight: closeProjectile ? 0.42 : projectiles.length ? 0.86 : 1.35
        };
        let best = {
          dx: 0,
          dy: 0,
          score: -Infinity,
          count: projectiles.length,
          spacingState: spacing.state,
          spacingDistance: spacing.distance
        };
        for (const dir of dirs) {
          const score = scoreCombatDirection(me, dir, projectiles, spacingEnemies, options);
          if (score > best.score) {
            best = { ...dir, score, count: projectiles.length, spacingState: spacing.state, spacingDistance: spacing.distance };
          }
        }
        const last = runner.lastCombatDodge || { dx: 0, dy: 0, score: -Infinity };
        if ((best.dx !== last.dx || best.dy !== last.dy) && Date.now() - runner.lastCombatSwitchAt < COMBAT_DODGE_SWITCH_MS) {
          const lastScore = scoreCombatDirection(me, last, projectiles, spacingEnemies, options);
          if (lastScore > best.score - 260) {
            best = {
              dx: last.dx,
              dy: last.dy,
              score: lastScore,
              count: projectiles.length,
              spacingState: spacing.state,
              spacingDistance: spacing.distance
            };
          }
        }
        return best;
      }

      function autoFireTarget(me) {
        const locked = lockedAttackTarget(me);
        if (locked) return locked;
        return liveEnemies(me, AUTO_FIRE_RANGE_CM)
          .map(decorateAttackEnemy)
          .filter(enemy => Number.isFinite(enemy.hpForFire) && enemy.hpForFire > 0)
          .sort((a, b) => a.hpForFire - b.hpForFire || a.dist - b.dist || Number(a.user_id) - Number(b.user_id))[0] || null;
      }

      function observedProjectileSpeedCmps() {
        const speeds = [];
        for (const projectile of runner.projectileMotion.values()) {
          const speed = Math.hypot(Number(projectile.vx), Number(projectile.vy));
          if (Number.isFinite(speed) && speed > 1000) speeds.push(speed);
        }
        if (!speeds.length) return NaN;
        speeds.sort((a, b) => a - b);
        return speeds[Math.floor(speeds.length / 2)];
      }

      function autoFireProjectileSpeedCmps() {
        const direct = numberFrom(state, [
          "bullet_speed_cmps",
          "bulletSpeedCmps",
          "projectile_speed_cmps",
          "projectileSpeedCmps"
        ], NaN);
        if (Number.isFinite(direct) && direct > 1000) return direct;
        const perTick = numberFrom(state, [
          "bullet_speed_per_tick",
          "bulletSpeedPerTick",
          "projectile_speed_per_tick",
          "projectileSpeedPerTick",
          "speed_per_tick",
          "speedPerTick"
        ], NaN);
        if (Number.isFinite(perTick) && perTick > 0) {
          const tickMs = Math.max(1, Number(state.serverTickMs) || 50);
          return perTick * 1000 / tickMs;
        }
        const observed = observedProjectileSpeedCmps();
        return Number.isFinite(observed) ? observed : AUTO_FIRE_DEFAULT_PROJECTILE_SPEED_CMPS;
      }

      function interceptLeadSeconds(me, target, velocity, projectileSpeed) {
        const rx = Number(target.x) - Number(me.x);
        const ry = Number(target.y) - Number(me.y);
        const vx = Number(velocity.vx) || 0;
        const vy = Number(velocity.vy) || 0;
        const speed = Math.max(1, Number(projectileSpeed) || AUTO_FIRE_DEFAULT_PROJECTILE_SPEED_CMPS);
        const a = vx * vx + vy * vy - speed * speed;
        const b = 2 * (rx * vx + ry * vy);
        const c = rx * rx + ry * ry;
        let lead = Math.sqrt(c) / speed;
        if (Math.abs(a) > 0.001) {
          const disc = b * b - 4 * a * c;
          if (disc >= 0) {
            const root = Math.sqrt(disc);
            const t1 = (-b - root) / (2 * a);
            const t2 = (-b + root) / (2 * a);
            const positive = [t1, t2].filter(value => Number.isFinite(value) && value > 0).sort((x, y) => x - y)[0];
            if (Number.isFinite(positive)) lead = positive;
          }
        } else if (Math.abs(b) > 0.001) {
          const linear = -c / b;
          if (Number.isFinite(linear) && linear > 0) lead = linear;
        }
        return Math.min(AUTO_FIRE_LEAD_MAX_MS / 1000, Math.max(AUTO_FIRE_LEAD_MIN_MS / 1000, lead));
      }

      function randomBetween(min, max) {
        return min + Math.random() * (max - min);
      }

      function randomInt(min, max) {
        return Math.floor(randomBetween(min, max + 1));
      }

      function predictedAutoFirePoint(me, target, extraLeadSeconds, offset) {
        const velocity = entityVelocityCmps(target, target.user_id);
        const projectileSpeed = autoFireProjectileSpeedCmps();
        const leadSeconds = interceptLeadSeconds(me, target, velocity, projectileSpeed);
        const totalLeadSeconds = leadSeconds + Math.max(0, Number(extraLeadSeconds) || 0);
        const ox = Number(offset && offset.x) || 0;
        const oy = Number(offset && offset.y) || 0;
        return {
          x: Number(target.x) + velocity.vx * totalLeadSeconds + ox,
          y: Number(target.y) + velocity.vy * totalLeadSeconds + oy,
          leadMs: Math.round(totalLeadSeconds * 1000),
          projectileSpeed,
          targetSpeed: Math.hypot(velocity.vx, velocity.vy)
        };
      }

      function autoFireBurstCooldownMs(me, target, shots) {
        const stamina = Number(me && me.stamina_5s_remaining_milli);
        const ratio = Number.isFinite(stamina) ? Math.max(0, Math.min(1, stamina / AUTO_FIRE_STAMINA_MAX_MILLI)) : 0.5;
        const farBias = target && Number(target.dist) > 11000 ? -80 : 0;
        const shotBias = Math.max(0, Number(shots) - AUTO_FIRE_BURST_MIN_SHOTS) * 24;
        if (ratio >= 0.65) return Math.max(90, randomBetween(120, 260) + farBias + shotBias);
        if (ratio >= 0.35) return Math.max(120, randomBetween(240, 520) + farBias + shotBias);
        if (ratio >= 0.16) return Math.max(180, randomBetween(430, 760) + farBias + shotBias);
        return randomBetween(620, 980) + shotBias;
      }

      function autoFireClientPoint(me, point) {
        const toClient = worldToClientFactory(me, root.getBoundingClientRect());
        const client = toClient(point);
        const x = Number(client && client.x);
        const y = Number(client && client.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        const rect = canvasRect();
        const margin = 4;
        if (x < rect.left - margin || x > rect.right + margin || y < rect.top - margin || y > rect.bottom + margin) {
          return null;
        }
        return { x, y };
      }

      function worldCanvasElement() {
        // §6.3:没有已确认的 world canvas 就返回 null,绝不回退 document.body 派发鼠标事件。
        return (typeof canvas !== "undefined" ? canvas : document.getElementById("world")) || null;
      }

      function autoFireCoverageOffsets(me, target, count) {
        const velocity = entityVelocityCmps(target, target.user_id);
        const targetSpeed = Math.hypot(velocity.vx, velocity.vy);
        const rx = Number(target.x) - Number(me.x);
        const ry = Number(target.y) - Number(me.y);
        const dist = Math.max(1, Math.hypot(rx, ry));
        const moveBasis = targetSpeed > 80
          ? { x: velocity.vx / targetSpeed, y: velocity.vy / targetSpeed }
          : { x: rx / dist, y: ry / dist };
        const perp = { x: -moveBasis.y, y: moveBasis.x };
        const along = moveBasis;
        const spread = Math.min(980, Math.max(220, dist * 0.038 + targetSpeed * 0.075));
        const pattern = [0, -0.85, 0.85, -0.42, 0.42, -1.22, 1.22, 0.18];
        const mid = (count - 1) / 2;
        const offsets = [];
        for (let i = 0; i < count; i += 1) {
          const lateral = (pattern[i] ?? randomBetween(-1.15, 1.15)) * spread;
          const forward = (i - mid) * spread * 0.18 + randomBetween(-0.12, 0.12) * spread;
          offsets.push({
            x: perp.x * lateral + along.x * forward,
            y: perp.y * lateral + along.y * forward
          });
        }
        return offsets;
      }

      function autoFireBurstClient(me, target, offset, shotIndex) {
        const freshTarget = visibleAttackTargetById(me, target.user_id) || target;
        const extraLeadSeconds = Math.max(0, Number(shotIndex) || 0) * AUTO_FIRE_BURST_SHOT_MS / 1000;
        return autoFireClientPoint(me, predictedAutoFirePoint(me, freshTarget, extraLeadSeconds, offset));
      }

      function dispatchAutoFireMouse(client, type, buttons) {
        const target = worldCanvasElement();
        if (!target) return; // §6.3:无已确认画布时绝不向 body 派发鼠标事件
        if (typeof setPointerFromClient === "function") {
          try {
            setPointerFromClient(client.x, client.y);
          } catch (_) {}
        }
        const common = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: client.x,
          clientY: client.y,
          screenX: Math.round(window.screenX + client.x),
          screenY: Math.round(window.screenY + client.y)
        };
        target.dispatchEvent(new MouseEvent(type, { ...common, button: 0, buttons }));
      }

      function clearAutoFireBurst(release) {
        for (const timer of runner.autoFireBurstTimers || []) {
          clearTimeout(timer);
        }
        runner.autoFireBurstTimers = [];
        if (release && runner.autoFireBurstClient) {
          dispatchAutoFireMouse(runner.autoFireBurstClient, "mouseup", 0);
          dispatchAutoFireMouse(runner.autoFireBurstClient, "click", 0);
        }
        runner.autoFireBursting = false;
        runner.autoFireBurstClient = null;
      }

      function scheduleAutoFireBurst(fn, delayMs) {
        const timer = window.setTimeout(() => {
          runner.autoFireBurstTimers = runner.autoFireBurstTimers.filter(item => item !== timer);
          fn();
        }, Math.max(0, delayMs));
        runner.autoFireBurstTimers.push(timer);
      }

      function startAutoFireBurst(me, target, targetName) {
        // §6.1/§6.2:5s 体力未知(NaN/缺失/null/非数字字符串)一律 fail closed,
        // 绝不回退到"随机 5-8 发"打空体力。只有有限非负数值才参与连发预算。
        const stamina = finiteStaminaMs(me && me.stamina_5s_remaining_milli);
        if (stamina == null) {
          runner.autoFireStatus = "体力未知·不发射";
          return false;
        }
        // §6.1:为整组连发预留体能预算,并保留余量用于退出/躲避,而不是只查"一发够不够"。
        let shots = randomInt(AUTO_FIRE_BURST_MIN_SHOTS, AUTO_FIRE_BURST_MAX_SHOTS);
        const affordable = Math.max(0, Math.floor(stamina / AUTO_FIRE_STAMINA_COST_MILLI) - AUTO_FIRE_RESERVE_SHOTS);
        if (affordable < AUTO_FIRE_BURST_MIN_SHOTS) {
          runner.autoFireStatus = "体力不足(整组预算)";
          return false;
        }
        shots = Math.min(shots, affordable);
        const offsets = autoFireCoverageOffsets(me, target, shots);
        const firstClient = autoFireBurstClient(me, target, offsets[0], 0);
        if (!firstClient) {
          runner.autoFireStatus = "目标超出画面";
          return false;
        }
        if (!burstTargetStillValid(me, target)) {
          runner.autoFireStatus = "目标已消失·不启动";
          return false;
        }

        clearAutoFireBurst(false);
        runner.autoFireBursting = true;
        runner.autoFireBurstClient = firstClient;
        runner.autoFireLastAt = Date.now();
        runner.plannedShots += shots;
        runner.autoFireTarget = targetName;
        runner.autoFireStatus = "连发 " + shots + " 发 " + targetName
          + " / " + Math.round(target.dist / 100) + "m";

        dispatchAutoFireMouse(firstClient, "mousemove", 0);
        dispatchAutoFireMouse(firstClient, "mousedown", 1);

        for (let i = 1; i < shots; i += 1) {
          scheduleAutoFireBurst(() => {
            const currentMe = getMe();
            if (!currentMe || !runner.autoFireBursting) return;
            // §6.2:目标已消失/死亡/退出视野 → 立即释放,不再沿用旧坐标继续开火。
            if (!burstTargetStillValid(currentMe, target)) {
              clearAutoFireBurst(true);
              runner.autoFireStatus = "目标已消失·中止";
              renderStatus();
              return;
            }
            const client = autoFireBurstClient(currentMe, target, offsets[i], i);
            if (!client) return;
            runner.autoFireBurstClient = client;
            dispatchAutoFireMouse(client, "mousemove", 1);
          }, i * AUTO_FIRE_BURST_SHOT_MS);
        }

        const holdMs = shots * AUTO_FIRE_BURST_SHOT_MS + randomBetween(55, 130);
        scheduleAutoFireBurst(() => {
          const releaseClient = runner.autoFireBurstClient || firstClient;
          dispatchAutoFireMouse(releaseClient, "mouseup", 0);
          dispatchAutoFireMouse(releaseClient, "click", 0);
          runner.autoFireBursting = false;
          runner.autoFireBurstClient = null;
          runner.autoFireNextBurstAt = Date.now() + autoFireBurstCooldownMs(getMe() || me, target, shots);
          runner.autoFireStatus = "连发完成 " + shots + " 发，等待下一组";
          renderStatus();
        }, holdMs);
        return true;
      }

      function handleAutoFire(me) {
        if (!runner.autoFireMode) return false;
        if (runner.autoFireBursting) {
          return true;
        }
        if (!me || me.life !== "Alive" || Number(me.hp || 0) <= COMBAT_LOW_HP) {
          runner.autoFireStatus = "SAFE";
          return false;
        }
        const target = autoFireTarget(me);
        if (!target) {
          runner.autoFireTarget = "";
          runner.autoFireStatus = "无目标";
          return false;
        }
        const targetName = target.displayName || target.name || ("#" + target.user_id);
        if (target.locked && !target.inFireRange) {
          runner.autoFireTarget = targetName;
          runner.autoFireStatus = "锁定超出射程 " + Math.round(target.dist / 100) + "m";
          return false;
        }
        if (!Number.isFinite(target.hpForFire) || !(target.hpForFire > 0)) {
          runner.autoFireTarget = targetName;
          runner.autoFireStatus = "锁定目标HP未知";
          return false;
        }
        const now = Date.now();
        if (now < runner.autoFireNextBurstAt) {
          runner.autoFireTarget = targetName;
          runner.autoFireStatus = "组间等待 " + Math.max(0, Math.ceil(runner.autoFireNextBurstAt - now)) + "ms";
          return false;
        }
        return startAutoFireBurst(me, target, targetName);
      }

      // §5.2/§5.3:点到线段距离 + 循环求最小距离,替代 Math.min(...map)(避免临时数组/参数上限)。
      function minDistanceToEntities(x, y, entities) {
        let min = Infinity;
        for (const entity of entities || []) {
          const d = Math.hypot(Number(entity && entity.x) - x, Number(entity && entity.y) - y);
          if (d < min) min = d;
        }
        return min;
      }

      function pointToSegmentDistance(px, py, ax, ay, bx, by) {
        const vx = bx - ax;
        const vy = by - ay;
        // §11.2:非法坐标按"不可达"(Infinity)处理,绝不返回 NaN。
        if (!Number.isFinite(vx) || !Number.isFinite(vy)) return Infinity;
        const len2 = vx * vx + vy * vy;
        if (len2 <= 1e-9) return Math.hypot(px - ax, py - ay);
        const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2));
        return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
      }

      // 整条线段到最近威胁的距离(覆盖端点/中点未覆盖的 1/4、3/4 等位置),§5.2。
      function minSegmentThreatDistance(ax, ay, bx, by, threats) {
        let min = Infinity;
        for (const t of threats || []) {
          const d = pointToSegmentDistance(Number(t.x), Number(t.y), ax, ay, bx, by);
          if (d < min) min = d;
        }
        return min;
      }

      function minRichEnemyDistanceAt(x, y, enemies) {
        return minDistanceToEntities(x, y, enemies);
      }

      function travelTicks(fromX, fromY, toX, toY) {
        const ax = Math.abs(Number(toX) - Number(fromX));
        const ay = Math.abs(Number(toY) - Number(fromY));
        // §11.2:非法/缺失坐标按"不可达"处理,绝不返回 NaN。
        if (!Number.isFinite(ax) || !Number.isFinite(ay)) return Infinity;
        const diagonal = Math.min(ax, ay);
        const axis = Math.max(ax, ay) - diagonal;
        return diagonal / TRAVEL_TICK_DIAGONAL_DIV + axis / TRAVEL_TICK_AXIS_DIV;
      }

      function dropAmount(drop) {
        return Math.max(1, Number(drop && drop.amount || 1));
      }

      // §5.6:金额缺失/非法返回 null,不作为 1 去追无效目标(由候选过滤)。
      function readDropAmount(drop) {
        const value = Number(drop && drop.amount);
        return Number.isFinite(value) && value > 0 ? value : null;
      }

      function travelSeconds(fromX, fromY, toX, toY) {
        return Math.max(0.2, travelTicks(fromX, fromY, toX, toY) * 0.05);
      }

      function dropClusterValue(drop, candidates, radius, weight) {
        const scanRadius = radius || DROP_CLUSTER_CM;
        const valueWeight = weight == null ? 0.65 : weight;
        let sum = 0;
        for (const other of candidates || []) {
          if (Number(other.drop_id) === Number(drop.drop_id)) continue;
          const dist = Math.hypot(Number(other.x) - Number(drop.x), Number(other.y) - Number(drop.y));
          if (dist > scanRadius) continue;
          sum += dropAmount(other) * (1 - dist / scanRadius) * valueWeight;
        }
        return sum;
      }

      function routeFirstLegPreferFactor(firstLegCm) {
        const dist = Number(firstLegCm) || 0;
        if (dist <= ROUTE_NEAR_PREFER_CM) return 1;
        if (dist >= ROUTE_FAR_SOFT_CM) return ROUTE_FAR_FACTOR_FLOOR;
        const t = (dist - ROUTE_NEAR_PREFER_CM) / (ROUTE_FAR_SOFT_CM - ROUTE_NEAR_PREFER_CM);
        return 1 - (1 - ROUTE_FAR_FACTOR_FLOOR) * t;
      }

      function scoreDrop(drop, me, threats, candidates) {
        const amount = dropAmount(drop);
        const seconds = travelSeconds(Number(me.x), Number(me.y), Number(drop.x), Number(drop.y));
        const firstLeg = Math.hypot(Number(drop.x) - Number(me.x), Number(drop.y) - Number(me.y));
        const cluster = dropClusterValue(drop, candidates);
        // 整条路径(从玩家到金币)到最近威胁的最近距离,而非只查端点/中点,§5.2。
        const safety = minSegmentThreatDistance(Number(me.x), Number(me.y), Number(drop.x), Number(drop.y), threats);
        if (safety < RICH_ENEMY_KEEP_CM) return -Infinity;
        const safetyFactor = safety < RICH_ENEMY_SCAN_CM
          ? 0.55 + 0.45 * ((safety - RICH_ENEMY_KEEP_CM) / (RICH_ENEMY_SCAN_CM - RICH_ENEMY_KEEP_CM))
          : 1;
        const sameTargetBias = Number(drop.drop_id) === Number(runner.targetId) ? 1.12 : 1;
        return ((amount + cluster) / (seconds + 1.6)) * safetyFactor * sameTargetBias * routeFirstLegPreferFactor(firstLeg);
      }

      function routeClusterStats(drop, candidates) {
        let count = 0;
        let amount = 0;
        let weighted = 0;
        for (const other of candidates) {
          if (Number(other.drop_id) === Number(drop.drop_id)) continue;
          const dist = Math.hypot(Number(other.x) - Number(drop.x), Number(other.y) - Number(drop.y));
          if (dist > ROUTE_CLUSTER_CM) continue;
          const value = dropAmount(other);
          count += 1;
          amount += value;
          weighted += value * (1 - dist / ROUTE_CLUSTER_CM);
        }
        return { count, amount, weighted };
      }

      function isCoinBlacklisted(id) {
        const until = runner.coinBlacklist.get(Number(id));
        if (until == null) return false;
        if (until <= Date.now()) { runner.coinBlacklist.delete(Number(id)); return false; }
        return true;
      }

      function coinCandidates(me, enemies) {
        const threats = enemies || richEnemies(me, RICH_ENEMY_SCAN_CM);
        const drops = Array.isArray(state.coinDrops) ? state.coinDrops : [];
        const candidates = drops
          .map(drop => {
            const amountValue = readDropAmount(drop);
            return {
              ...drop,
              amountValue,
              dist: Math.hypot(Number(drop.x) - Number(me.x), Number(drop.y) - Number(me.y)),
              richEnemyDist: minRichEnemyDistanceAt(Number(drop.x), Number(drop.y), threats)
            };
          })
          .filter(drop => drop.amountValue !== null
            && !isCoinBlacklisted(drop.drop_id)
            && Number.isFinite(drop.dist) && Number.isFinite(Number(drop.x)) && Number.isFinite(Number(drop.y)));
        const safeBase = (threats.length
          ? candidates.filter(drop => drop.richEnemyDist >= RICH_ENEMY_KEEP_CM)
          : candidates);
        const safe = safeBase
          .map(drop => ({
            ...drop,
            score: scoreDrop(drop, me, threats, safeBase),
            routeCluster: routeClusterStats(drop, safeBase)
          }))
          .filter(drop => Number.isFinite(drop.score));
        return safe;
      }

      function routeLimitForAnchor(anchor) {
        const count = anchor && anchor.routeCluster ? anchor.routeCluster.count : 0;
        if (count >= 7) return ROUTE_MAX_POINTS_DENSE;
        if (count >= 3) return ROUTE_MAX_POINTS_MID;
        if (count >= 1) return ROUTE_MAX_POINTS_SPARSE;
        return 1;
      }

      function routeLegSafetyFactor(fromX, fromY, toX, toY, threats) {
        // 整条腿到威胁的最近距离(§5.2),而非只查端点/中点。
        const safety = minSegmentThreatDistance(fromX, fromY, toX, toY, threats);
        if (safety < RICH_ENEMY_KEEP_CM) return 0;
        if (safety >= RICH_ENEMY_SCAN_CM) return 1;
        return 0.55 + 0.45 * ((safety - RICH_ENEMY_KEEP_CM) / (RICH_ENEMY_SCAN_CM - RICH_ENEMY_KEEP_CM));
      }

      function routeTurnFactor(prevDx, prevDy, nextDx, nextDy) {
        const prevLen = Math.hypot(prevDx, prevDy);
        const nextLen = Math.hypot(nextDx, nextDy);
        if (prevLen < 1 || nextLen < 1) return 1;
        const cos = (prevDx * nextDx + prevDy * nextDy) / (prevLen * nextLen);
        if (cos < -0.45) return 0.58;
        if (cos < -0.12) return 0.76;
        if (cos > 0.72) return 1.08;
        return 1;
      }

      function routeStepScore(drop, currentX, currentY, prevDx, prevDy, remaining, threats, linkLimit) {
        const dx = Number(drop.x) - currentX;
        const dy = Number(drop.y) - currentY;
        const legDist = Math.hypot(dx, dy);
        const allowLongValue = drop.amountValue >= 10 && legDist <= ROUTE_MAX_LINK_CM;
        if (legDist > linkLimit && !allowLongValue) return null;
        const safetyFactor = routeLegSafetyFactor(currentX, currentY, Number(drop.x), Number(drop.y), threats);
        if (safetyFactor <= 0) return null;
        const seconds = travelSeconds(currentX, currentY, Number(drop.x), Number(drop.y));
        const localCluster = Math.min(drop.amountValue * 2.4, dropClusterValue(drop, remaining, ROUTE_CLUSTER_CM, 0.38));
        const turnFactor = routeTurnFactor(prevDx, prevDy, dx, dy);
        const score = ((drop.amountValue + localCluster) / (seconds + 0.75)) * safetyFactor * turnFactor;
        return { drop, dx, dy, legDist, seconds, safetyFactor, score };
      }

      function chooseNextRouteDrop(currentX, currentY, prevDx, prevDy, remaining, threats, linkLimit) {
        let best = null;
        for (const drop of remaining.values()) {
          const scored = routeStepScore(drop, currentX, currentY, prevDx, prevDy, remaining.values(), threats, linkLimit);
          if (!scored) continue;
          if (!best || scored.score > best.score || (scored.score === best.score && scored.legDist < best.legDist)) {
            best = scored;
          }
        }
        return best;
      }

      function buildRouteFromAnchor(anchor, candidates, me, threats) {
        const maxPoints = routeLimitForAnchor(anchor);
        const linkLimit = anchor.routeCluster.count >= 5 ? ROUTE_MAX_LINK_CM : ROUTE_LINK_CM;
        const remaining = new Map(candidates.map(drop => [Number(drop.drop_id), drop]));
        const route = [];
        let currentX = Number(me.x);
        let currentY = Number(me.y);
        let prevDx = 0;
        let prevDy = 0;
        let totalValue = 0;
        let totalSeconds = 0;
        let totalLegCm = 0;
        let minSafetyFactor = 1;

        for (let step = 0; step < maxPoints; step += 1) {
          const next = step === 0
            ? routeStepScore(anchor, currentX, currentY, prevDx, prevDy, remaining.values(), threats, Infinity)
            : chooseNextRouteDrop(currentX, currentY, prevDx, prevDy, remaining, threats, linkLimit);
          if (!next) break;
          if (step > 0) {
            const currentEfficiency = totalValue / Math.max(0.8, totalSeconds);
            const densityAllowance = anchor.routeCluster.count >= 5 ? 0.30 : 0.43;
            if (next.score < currentEfficiency * densityAllowance) break;
          }
          route.push(next.drop);
          remaining.delete(Number(next.drop.drop_id));
          totalValue += next.drop.amountValue;
          totalSeconds += next.seconds;
          totalLegCm += Number(next.legDist) || 0;
          minSafetyFactor = Math.min(minSafetyFactor, next.safetyFactor);
          currentX = Number(next.drop.x);
          currentY = Number(next.drop.y);
          prevDx = next.dx;
          prevDy = next.dy;
        }

        if (!route.length) return null;
        const ids = route.map(drop => Number(drop.drop_id));
        const densityBonus = Math.min(
          totalValue * 0.75,
          route.reduce((sum, drop) => sum + Math.min(drop.amountValue * 2, drop.routeCluster.weighted) * 0.18, 0)
        );
        const countBonus = 1 + Math.min(0.18, (route.length - 1) * 0.045);
        const sameRouteBias = ids[0] === Number(runner.targetId) ? 1.08 : 1;
        const kind = route.length >= 3 ? "cluster" : route.length === 2 ? "pair" : "single";
        // 路线总长软折扣:超过起点阈值的部分按斜率压分,让近处金团路线相对胜出、远离处长路线变贵。
        const lengthExcessCm = Math.max(0, totalLegCm - ROUTE_LENGTH_PENALTY_START_CM);
        const lengthFactorBase = 1 - ROUTE_LENGTH_PENALTY_PER_CM * lengthExcessCm;
        const lengthFactor = Math.max(ROUTE_LENGTH_PENALTY_FLOOR, lengthFactorBase);
        // 首段偏好:第一颗金币很远时再压一档,避免高金额/金团密度把脚本拽到远处。
        const firstLegCm = route.length
          ? Math.hypot(Number(route[0].x) - Number(me.x), Number(route[0].y) - Number(me.y))
          : 0;
        const firstLegFactor = routeFirstLegPreferFactor(firstLegCm);
        const score = ((totalValue + densityBonus) / (totalSeconds + 1.4))
          * minSafetyFactor * countBonus * sameRouteBias * lengthFactor * firstLegFactor;
        return {
          ids,
          target: route[0],
          drops: route,
          score,
          value: totalValue,
          travelSeconds: totalSeconds,
          travelCm: totalLegCm,
          kind
        };
      }

      function uniqueDrops(groups, limit) {
        const anchors = new Map();
        for (const group of groups) {
          for (const drop of group) {
            const id = Number(drop.drop_id);
            if (!anchors.has(id)) anchors.set(id, drop);
            if (anchors.size >= limit) return Array.from(anchors.values());
          }
        }
        return Array.from(anchors.values());
      }

      function uniqueAnchors(groups) {
        return uniqueDrops(groups, ROUTE_ANCHOR_LIMIT);
      }

      function bestDropRoute(me, enemies) {
        const threats = enemies || richEnemies(me, RICH_ENEMY_SCAN_CM);
        const candidates = coinCandidates(me, threats);
        if (!candidates.length) return null;
        const bySingleAll = [...candidates].sort((a, b) => b.score - a.score || a.dist - b.dist);
        const bySingle = bySingleAll.slice(0, 12);
        const byCluster = [...candidates]
          .sort((a, b) =>
            ((b.amountValue + b.routeCluster.weighted) / (travelSeconds(Number(me.x), Number(me.y), Number(b.x), Number(b.y)) + 1.4))
            - ((a.amountValue + a.routeCluster.weighted) / (travelSeconds(Number(me.x), Number(me.y), Number(a.x), Number(a.y)) + 1.4))
            || a.dist - b.dist
          )
        const byNearAll = [...candidates].sort((a, b) => a.dist - b.dist);
        const byAmountAll = [...candidates].sort((a, b) => b.amountValue - a.amountValue || a.dist - b.dist);
        const byNear = byNearAll.slice(0, 6);
        const byAmount = byAmountAll.slice(0, 6);
        const current = runner.targetId
          ? candidates.filter(drop => Number(drop.drop_id) === Number(runner.targetId))
          : [];
        const routePool = uniqueDrops([
          current,
          bySingleAll.slice(0, 36),
          byCluster.slice(0, 36),
          byNearAll.slice(0, 18),
          byAmountAll.slice(0, 18)
        ], ROUTE_POOL_LIMIT);
        const anchors = uniqueAnchors([current, bySingle, byCluster, byNear, byAmount]);
        let best = null;
        for (const anchor of anchors) {
          const route = buildRouteFromAnchor(anchor, routePool, me, threats);
          if (!route) continue;
          if (!best || route.score > best.score || (route.score === best.score && route.travelSeconds < best.travelSeconds)) {
            best = route;
          }
        }
        return best;
      }

      function currentCoinRouteTarget(me, threats) {
        const drops = Array.isArray(state.coinDrops) ? state.coinDrops : [];
        while (runner.routeIds && runner.routeIds.length) {
          const id = Number(runner.routeIds[0]);
          const target = drops.find(drop => Number(drop.drop_id) === id);
          if (!target) {
            runner.routeIds.shift();
            runner.routeAdvanced = true;
            runner.planNextAt = 0;
            runner.targetScore *= 0.68;
            continue;
          }
          if (minRichEnemyDistanceAt(Number(target.x), Number(target.y), threats) < RICH_ENEMY_KEEP_CM) {
            clearCoinRoute();
            return null;
          }
          runner.targetId = id;
          return {
            ...target,
            amountValue: dropAmount(target),
            dist: Math.hypot(Number(target.x) - Number(me.x), Number(target.y) - Number(me.y)),
            score: runner.targetScore
          };
        }

        if (runner.targetId) {
          const target = drops.find(drop => Number(drop.drop_id) === Number(runner.targetId));
          if (!target || isCoinBlacklisted(target.drop_id)
            || minRichEnemyDistanceAt(Number(target.x), Number(target.y), threats) < RICH_ENEMY_KEEP_CM) {
            clearCoinRoute();
            return null;
          }
          return {
            ...target,
            amountValue: dropAmount(target),
            dist: Math.hypot(Number(target.x) - Number(me.x), Number(target.y) - Number(me.y)),
            score: runner.targetScore
          };
        }

        clearCoinRoute();
        return null;
      }

      function nearestDrop(me, enemies) {
        const route = bestDropRoute(me, enemies);
        return route ? route.target : null;
      }

      // 选一颗“安全金币锚点”作为撤离目标:离自己近、离当前威胁远,且远离所有 170m 逃离威胁敌人。
      // 用于两阶段撤离的“稳态撤离”阶段——逃离顺路收币,避免纯反向来回横跳空耗体力。
      // excludeId 用于到达/过期后排除当前金币,避免在同一点原地转圈。
      function safeFleeAnchor(me, enemy, escapeThreats, excludeId) {
        const drops = Array.isArray(state.coinDrops) ? state.coinDrops : [];
        if (!drops.length) return null;
        const threats = Array.isArray(escapeThreats) && escapeThreats.length ? escapeThreats : [];
        const awayX = Number(me.x) - Number(enemy.x);
        const awayY = Number(me.y) - Number(enemy.y);
        const awayLen = Math.hypot(awayX, awayY) || 1;
        let best = null;
        for (const drop of drops) {
          if (excludeId != null && Number(drop.drop_id) === Number(excludeId)) continue;
          const dx = Number(drop.x);
          const dy = Number(drop.y);
          if (!Number.isFinite(dx) || !Number.isFinite(dy)) continue;
          // 锚点必须远离所有 170m 逃离威胁敌人(包括当前这只),否则逃过去又陷入危险。
          if (threats.length) {
            const minThreatDist = minDistanceToEntities(dx, dy, threats);
            if (!Number.isFinite(minThreatDist) || minThreatDist < FLEE_ANCHOR_SAFE_RADIUS_CM) continue;
          } else {
            const distFromEnemy = Math.hypot(dx - Number(enemy.x), dy - Number(enemy.y));
            if (distFromEnemy < FLEE_ANCHOR_SAFE_RADIUS_CM) continue;
          }
          const distToMe = Math.hypot(dx - Number(me.x), dy - Number(me.y));
          const distToEnemy = Math.hypot(dx - Number(enemy.x), dy - Number(enemy.y));
          if (!Number.isFinite(distToMe) || !Number.isFinite(distToEnemy)) continue;
          // 评分:离自己越近越好、离当前敌人越远越好;再加半平面偏置,偏好继续远离敌人的方向。
          if (distToMe > 500000) continue;
          const toDropX = dx - Number(me.x);
          const toDropY = dy - Number(me.y);
          const align = (awayX * toDropX + awayY * toDropY) / awayLen;
          const score = (distToEnemy + 1) / (distToMe + 1) + Math.max(0, align) / 20000;
          if (!best || score > best.score) {
            best = { x: dx, y: dy, drop_id: drop.drop_id, score, distToMe, distToEnemy };
          }
        }
        return best;
      }

      function fleeFrom(enemy, me, reason, urgent) {
        const now = Date.now();
        const key = enemyKey(enemy) || String(enemy.user_id || "");
        // 撤离阶段状态:
        //   - 无状态或换了威胁敌人 → 进入“纯反向撤离”阶段,记录开始时刻(1.5s 内纯反向拉开,避免路过者抖动)。
        //   - 同敌人持续逼近超 hold 仍未摆脱 → 转向“安全金币锚点”稳态撤离顺路收币。
        //   - 锚点到达/过期 → 排除当前金币换下一颗;没有下一颗则回纯反向,绝不在同一点原地转圈。
        let evade = runner.fleeAnchor;
        const sameEnemy = evade && evade.key && evade.key === key;
        if (!sameEnemy) {
          evade = { key, startedAt: now, x: null, y: null, drop_id: null, anchorAt: 0 };
        } else {
          evade = { ...evade };
        }

        const trySetAnchor = (excludeId) => {
          const escapeThreats = escapeEnemies(me, RICH_ENEMY_ESCAPE_CM);
          const safeAnchor = safeFleeAnchor(me, enemy, escapeThreats, excludeId);
          if (safeAnchor) {
            return {
              key,
              startedAt: evade.startedAt || now,
              x: Number(safeAnchor.x),
              y: Number(safeAnchor.y),
              drop_id: safeAnchor.drop_id,
              anchorAt: now
            };
          }
          return null;
        };

        if (evade.x != null) {
          const distToAnchor = Math.hypot(Number(evade.x) - Number(me.x), Number(evade.y) - Number(me.y));
          const stale = evade.anchorAt && (now - evade.anchorAt) >= FLEE_ANCHOR_MAX_MS;
          if (distToAnchor <= COIN_REACHED_CM || stale) {
            const refreshed = trySetAnchor(evade.drop_id);
            evade = refreshed || { key, startedAt: now, x: null, y: null, drop_id: null, anchorAt: 0 };
          }
        } else if ((now - evade.startedAt) >= FLEE_ANCHOR_HOLD_MS) {
          const anchored = trySetAnchor(null);
          if (anchored) evade = anchored;
        }
        runner.fleeAnchor = evade;

        let label;
        if (evade.x != null) {
          // 锚点撤离阶段
          moveToward(Number(evade.x) - Number(me.x), Number(evade.y) - Number(me.y));
          setNavigationTarget(Number(evade.x), Number(evade.y), "evade");
          label = reason + "：逃向安全金币 #" + evade.drop_id;
        } else {
          // 纯反向撤离阶段
          const rx = Number(me.x) - Number(enemy.x);
          const ry = Number(me.y) - Number(enemy.y);
          moveToward(rx || 1, ry);
          const length = Math.max(1, Math.hypot(rx, ry));
          setNavigationTarget(
            Number(me.x) + (rx || 1) / length * 12000,
            Number(me.y) + ry / length * 12000,
            "evade"
          );
          label = reason + "：纯反向撤离";
        }
        setDanger(urgent);
        clearCoinRoute();
        // §5.9: 只在"进入逃离"或"威胁目标变化"时计入规避事件,避免 150ms tick 反复加。
        if (!runner.fleeing || (runner.fleeKey && runner.fleeKey !== key)) {
          runner.avoidances += 1;
        }
        runner.fleeing = true;
        runner.fleeKey = key;
        runner.lastThreat = {
          name: enemy.name || ("User " + enemy.user_id),
          drop: enemy.dropForAvoid,
          dist: Math.round(enemy.dist)
        };
        runner.lastAction = label + " " + runner.lastThreat.name
          + " 距离 " + runner.lastThreat.dist + "cm Drop " + runner.lastThreat.drop;
      }

      function driveHuntTarget(me) {
        if (!runner.huntMode) return false;
        const query = huntQueryText();
        if (!query) {
          clearHuntTarget();
          stopMove();
          runner.lastAction = "追杀：请输入用户名片段";
          return true;
        }
        if (query !== runner.huntQuery) {
          runner.huntQuery = query;
          clearHuntTarget();
        }

        const now = Date.now();
        const target = findHuntTarget(me, query);
        let point = null;
        let label = "";
        let source = "";
        let distToEntity = 0;

        if (target) {
          const predicted = predictedHuntPoint(target, me);
          point = predicted;
          label = target.name + " #" + target.userId;
          source = target.source === "entity" ? "实时" : "快照";
          distToEntity = target.dist;
          runner.huntTargetId = target.userId;
          runner.huntTargetName = target.name;
          runner.huntLastSeen = {
            userId: target.userId,
            name: target.name,
            x: Number(target.x),
            y: Number(target.y),
            predictedX: Number(point.x),
            predictedY: Number(point.y),
            source: target.source
          };
          runner.huntLastSeenAt = now;
        } else if (runner.huntLastSeen && now - runner.huntLastSeenAt <= HUNT_LOST_MEMORY_MS) {
          point = {
            x: Number(runner.huntLastSeen.predictedX || runner.huntLastSeen.x),
            y: Number(runner.huntLastSeen.predictedY || runner.huntLastSeen.y),
            leadMs: 0,
            speed: 0
          };
          label = runner.huntLastSeen.name + " #" + runner.huntLastSeen.userId;
          source = "记忆";
          distToEntity = Math.hypot(point.x - Number(me.x), point.y - Number(me.y));
        } else {
          clearHuntTarget();
          stopMove();
          clearCoinRoute();
          runner.lastAction = "追杀：未找到匹配用户名 " + query;
          return true;
        }

        const rx = Number(point.x) - Number(me.x);
        const ry = Number(point.y) - Number(me.y);
        const dist = Math.hypot(rx, ry);
        clearCoinRoute();
        setDanger(false);
        setNavigationTarget(point.x, point.y, "hunt");

        if (!Number.isFinite(dist)) {
          stopMove();
          runner.lastAction = "追杀：" + label + " 坐标异常";
          return true;
        }
        if (dist <= HUNT_REACHED_CM) {
          stopMove();
          runner.lastAction = "追杀：" + label + " 已贴近，保持观察";
          return true;
        }

        moveToward(rx, ry);
        runner.lastAction = "追杀：" + label
          + " / " + source
          + " / 距离 " + Math.round(distToEntity || dist)
          + " / 预判 " + Math.round(point.leadMs || 0) + "ms";
        return true;
      }

      function canvasRect() {
        const worldCanvas = typeof canvas !== "undefined" ? canvas : document.getElementById("world");
        if (worldCanvas && typeof worldCanvas.getBoundingClientRect === "function") {
          const rect = worldCanvas.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) return rect;
        }
        return document.body.getBoundingClientRect();
      }

      function overlaySceneRect(rootRect) {
        if (rootRect && rootRect.width > 0 && rootRect.height > 0) return rootRect;
        return canvasRect();
      }

      function renderWorldPoint(point) {
        const userId = Number(point && point.user_id);
        const currentUserId = Number(state.currentUserId);
        if (Number.isFinite(userId) && Number.isFinite(currentUserId) && userId === currentUserId) {
          const visual = state.localVisual;
          if (visual && Number.isFinite(Number(visual.x)) && Number.isFinite(Number(visual.y))) {
            return { ...point, x: Number(visual.x), y: Number(visual.y) };
          }
        }
        const visuals = state.visualEntities;
        if (Number.isFinite(userId) && visuals && typeof visuals.get === "function") {
          const visual = visuals.get(userId);
          if (visual && Number.isFinite(Number(visual.x)) && Number.isFinite(Number(visual.y))) {
            return { ...point, x: Number(visual.x), y: Number(visual.y) };
          }
        }
        return point;
      }

      function gameScreenCenter(rect) {
        if (typeof screenCenter === "function") {
          try {
            const point = screenCenter();
            const x = Number(point && point.x);
            const y = Number(point && point.y);
            if (Number.isFinite(x) && Number.isFinite(y)) {
              return { x: rect.left + x, y: rect.top + y };
            }
          } catch (_) {}
        }
        const reservedLeft = window.matchMedia("(max-aspect-ratio: 1/1)").matches
          ? 0
          : Math.min(368, Math.max(0, rect.width - 320));
        return {
          x: rect.left + reservedLeft + (rect.width - reservedLeft) / 2,
          y: rect.top + rect.height / 2
        };
      }

      function gameCameraCenter(me) {
        const visual = state.localVisual;
        if (visual && Number.isFinite(Number(visual.x)) && Number.isFinite(Number(visual.y))) {
          return { x: Number(visual.x), y: Number(visual.y) };
        }
        return {
          x: Number(me.x),
          y: Number(me.y)
        };
      }

      function fallbackWorldToClient(me, rect) {
        const shortSide = Math.max(1, Math.min(rect.width, rect.height));
        const viewRadius = Number(state.viewRadiusCm);
        const units = Number.isFinite(viewRadius) && viewRadius > 0
          ? (viewRadius * 2) / shortSide
          : (ENEMY_LINE_SCAN_CM * 2) / shortSide;
        const origin = gameScreenCenter(rect);
        const camera = gameCameraCenter(me);
        return point => ({
          x: origin.x + (Number(point.x) - camera.x) / units,
          y: origin.y + (Number(point.y) - camera.y) / units
        });
      }

      function worldToClientFactory(me, rootRect) {
        const rect = canvasRect();
        if (typeof viewParams === "function" && typeof worldToScreen === "function") {
          try {
            const view = viewParams();
            return point => {
              const screenPoint = worldToScreen(Number(point.x), Number(point.y), view);
              return {
                x: rect.left + Number(screenPoint.x),
                y: rect.top + Number(screenPoint.y)
              };
            };
          } catch (_) {}
        }
        if (!rect || rect.width <= 0 || rect.height <= 0) return fallbackWorldToClient(me, overlaySceneRect(rootRect));
        return fallbackWorldToClient(me, rect);
      }

      function clientPoint(worldPoint, toClient, rootRect) {
        const clientPoint = toClient(renderWorldPoint(worldPoint));
        const x = Number(clientPoint.x) - rootRect.left;
        const y = Number(clientPoint.y) - rootRect.top;
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        return { x, y };
      }

      function lineMayBeVisible(a, b, width, height) {
        const margin = 120;
        if (a.x < -margin && b.x < -margin) return false;
        if (a.y < -margin && b.y < -margin) return false;
        if (a.x > width + margin && b.x > width + margin) return false;
        if (a.y > height + margin && b.y > height + margin) return false;
        return true;
      }

      function prepareLineCanvas(rootRect) {
        const canvasEl = ui.lineCanvas;
        const ctx = runner.lineCtx;
        if (!canvasEl || !ctx) return null;
        const width = Math.max(1, Math.round(rootRect.width));
        const height = Math.max(1, Math.round(rootRect.height));
        const dpr = Math.min(LINE_CANVAS_MAX_DPR, Math.max(1, Number(window.devicePixelRatio || 1)));
        const pixelWidth = Math.max(1, Math.round(width * dpr));
        const pixelHeight = Math.max(1, Math.round(height * dpr));
        if (canvasEl.width !== pixelWidth || canvasEl.height !== pixelHeight) {
          canvasEl.width = pixelWidth;
          canvasEl.height = pixelHeight;
          canvasEl.style.width = width + "px";
          canvasEl.style.height = height + "px";
        }
        runner.lineDpr = dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);
        return { ctx, width, height };
      }

      function clearLineCanvas() {
        const canvasEl = ui.lineCanvas;
        const ctx = runner.lineCtx;
        if (!canvasEl || !ctx) return;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
      }

      function drawLine(ctx, a, b, type) {
        const styles = {
          enemy: {
            color: "rgba(56, 189, 248, .72)",
            width: 1.6,
            glow: "rgba(56, 189, 248, .62)",
            blur: 8,
            dash: []
          },
          danger: {
            color: "rgba(248, 113, 113, .95)",
            width: 2.4,
            glow: "rgba(248, 113, 113, .72)",
            blur: 10,
            dash: []
          },
          target: {
            color: "rgba(250, 204, 21, .95)",
            width: 2.3,
            glow: "rgba(250, 204, 21, .72)",
            blur: 10,
            dash: [10, 8]
          }
        };
        const style = styles[type] || styles.enemy;
        ctx.save();
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = "rgba(2, 6, 23, .42)";
        ctx.lineWidth = Math.max(4, style.width + 3);
        ctx.setLineDash([]);
        ctx.shadowBlur = 0;
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = style.color;
        ctx.lineWidth = style.width;
        ctx.setLineDash(style.dash);
        ctx.shadowBlur = style.blur;
        ctx.shadowColor = style.glow;
        ctx.stroke();
        ctx.restore();
      }

      function drawCombatTriangle(ctx, point) {
        ctx.save();
        ctx.translate(point.x, point.y - 30);
        ctx.beginPath();
        ctx.moveTo(0, 12);
        ctx.lineTo(-12, -9);
        ctx.lineTo(12, -9);
        ctx.closePath();
        ctx.fillStyle = "rgba(248, 38, 38, .92)";
        ctx.shadowBlur = 14;
        ctx.shadowColor = "rgba(248, 38, 38, .8)";
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = "rgba(254, 226, 226, .85)";
        ctx.stroke();
        ctx.restore();
      }

      function drawCombatOverlay(surface, me, toClient, rootRect) {
        const meHp = numberFrom(me, ["hp", "health", "life_value", "current_hp"], 0);
        if (meHp <= 0) return;
        const enemies = combatEnemies(me);
        runner.combatTargets = 0;
        for (const enemy of enemies) {
          if (!(enemy.hpForCombat > 0) || enemy.hpForCombat >= meHp) continue;
          const point = clientPoint(enemy, toClient, rootRect);
          if (!point || point.x < -40 || point.y < -40 || point.x > rootRect.width + 40 || point.y > rootRect.height + 40) continue;
          drawCombatTriangle(surface.ctx, point);
          runner.combatTargets += 1;
        }
      }

      function currentNavigationTarget() {
        if (!runner.running) return null;
        if (runner.manualTarget) return runner.manualTarget;
        if (runner.navTarget) return runner.navTarget;
        if (runner.targetId) {
          const target = state.coinDrops.find(drop => Number(drop.drop_id) === Number(runner.targetId));
          if (target) return target;
        }
        return null;
      }

      function renderLines() {
        try {
          const me = getMe();
          if (!me) {
            clearLineCanvas();
            return;
          }
          const now = Date.now();
          trackEnemyMotion(now);
          const rootRect = root.getBoundingClientRect();
          if (rootRect.width <= 0 || rootRect.height <= 0 || document.hidden) {
            clearLineCanvas();
            return;
          }
          const surface = prepareLineCanvas(rootRect);
          if (!surface) return;
          const toClient = worldToClientFactory(me, rootRect);
          const mePoint = clientPoint(me, toClient, rootRect);
          if (!mePoint) return;

          if (runner.combatMode) {
            drawCombatOverlay(surface, me, toClient, rootRect);
            return;
          }

          const enemies = liveEnemies(me, ENEMY_LINE_SCAN_CM)
            .filter(enemy => enemy.dropForAvoid >= ENEMY_LINE_MIN_DROP);
          const dangerEnemies = [];
          for (const enemy of enemies) {
            const enemyPoint = clientPoint(enemy, toClient, rootRect);
            if (!enemyPoint || !lineMayBeVisible(mePoint, enemyPoint, rootRect.width, rootRect.height)) continue;
            drawLine(surface.ctx, mePoint, enemyPoint, "enemy");
            if (enemy.dist <= RICH_ENEMY_ESCAPE_CM) dangerEnemies.push(enemyPoint);
          }
          for (const enemyPoint of dangerEnemies) {
            drawLine(surface.ctx, mePoint, enemyPoint, "danger");
          }

          const target = currentNavigationTarget();
          const targetPoint = target ? clientPoint(target, toClient, rootRect) : null;
          if (targetPoint && lineMayBeVisible(mePoint, targetPoint, rootRect.width, rootRect.height)) {
            drawLine(surface.ctx, mePoint, targetPoint, "target");
          }
        } catch (_) {
          clearLineCanvas();
        }
      }

      function renderLineFrame() {
        runner.lineRaf = 0;
        renderLines();
        if (root.isConnected) {
          runner.lineRaf = window.requestAnimationFrame(renderLineFrame);
        }
      }

      function startLineLoop() {
        if (!runner.lineRaf) {
          runner.lineRaf = window.requestAnimationFrame(renderLineFrame);
        }
      }

      function leftSidebarText() {
        const side = document.querySelector(".side");
        if (!side) return "";
        return side.innerText || side.textContent || "";
      }

      function hasHourlyStaminaLimit() {
        return leftSidebarText().includes("1h体力限制");
      }

      function checkHourlyStaminaLimitLeave() {
        if (!hasHourlyStaminaLimit()) {
          runner.hourlyLimitLeaveTriggered = false;
          return false;
        }
        if (runner.hourlyLimitLeaveTriggered) return true;
        runner.hourlyLimitLeaveTriggered = true;
        clickLeave("左侧边栏检测到1h体力限制");
        return true;
      }

      // 记录离开信息,供授权页(connect.linux.do)上的脚本据此算冷却决定是否自动重连。
      // type: manual=手动不重连 / stamina=1h体力耗尽 / lowhp=掉血且离开时HP≤25 /
      //       damage=掉血但HP>25 / other=兜底不重连。开关关闭时仍写记录便于排查,
      //       但授权页会读到开关并直接不点允许。
      function recordLeave(reason, me, options) {
        try {
          const bridge = (typeof window !== "undefined" && window.__crgrReconnect) || null;
          if (!bridge || typeof bridge.writeLeave !== "function") return;
          const noReconnect = !!(options && options.noReconnect);
          let type = "other";
          if (noReconnect) {
            type = "other";
          } else if (reason === "manual") {
            type = "manual";
          } else if (runner.hourlyLimitLeaveTriggered && /1h体力限制/.test(String(reason || ""))) {
            type = "stamina";
          } else {
            const hp = me ? Number(me.hp || 0) : NaN;
            if (Number.isFinite(hp)) {
              type = hp <= COMBAT_CRITICAL_HP ? "lowhp" : "damage";
            } else {
              type = "damage";
            }
          }
          const enabled = !noReconnect && runner.autoReconnect !== false;
          const rec = {
            ts: Date.now(),
            type,
            hp: me ? Number(me.hp || 0) : null,
            reason: String(reason || ""),
            enabled,
            v: 2
          };
          bridge.writeLeave(rec);
          if (enabled && (type === "damage" || type === "lowhp" || type === "stamina")
            && typeof bridge.markLeaveFlow === "function") {
            if (typeof bridge.clearAck === "function") bridge.clearAck();
            bridge.markLeaveFlow(rec.ts);
          } else {
            if (typeof bridge.clearFlow === "function") bridge.clearFlow();
            if (typeof bridge.clearAck === "function") bridge.clearAck();
          }
          return rec;
        } catch (_) {
          // 写记录失败不影响离开本身
        }
        return null;
      }

      function clearReconnectState() {
        try {
          const bridge = (typeof window !== "undefined" && window.__crgrReconnect) || null;
          if (!bridge) return;
          if (typeof bridge.clearLeave === "function") bridge.clearLeave();
          if (typeof bridge.clearAck === "function") bridge.clearAck();
          if (typeof bridge.clearFlow === "function") bridge.clearFlow();
        } catch (_) {}
      }

      // "仅本次手动重试":清掉失败/终态流程与 ack,按当前离开记录重建 leave 阶段流程,
      // 让看护视作一轮全新流程重试一次。
      function retryReconnectOnce() {
        try {
          const bridge = (typeof window !== "undefined" && window.__crgrReconnect) || null;
          const rec = bridge && bridge.readLeave ? bridge.readLeave() : null;
          if (!bridge || !rec || !rec.ts) return;
          if (typeof bridge.clearAck === "function") bridge.clearAck();
          if (typeof bridge.markLeaveFlow === "function") bridge.markLeaveFlow(rec.ts);
          push("重连状态已重置,仅本次重试");
          renderStatus();
        } catch (_) {}
      }

      function clickLeave(reason, options) {
        if (runner.leaveInProgress) return false;
        const noReconnect = !!(options && options.noReconnect) || runner.rejoinRecovery;
        runner.leaveInProgress = true;
        let button = null;
        try {
          button = els.leaveBtn
            || Array.from(document.querySelectorAll("button")).find(btn => (btn.textContent || "").trim() === "离开");
        } catch (_) {}
        stopMove();
        setDanger(false);
        runner.leaves += 1;
        runner.running = false;
        runner.combatMode = false;
        runner.huntMode = false;
        runner.autoFireMode = false;
        runner.autoFireStatus = "OFF";
        if (noReconnect) {
          runner.rejoinRecovery = false;
          runner.rejoinSafeSince = 0;
          runner.rejoinPeakHp = null;
        }
        const me = getMe();
        runner.stoppedHpBaseline = me ? Number(me.hp || 0) : null;
        if (!button) {
          clearReconnectState();
          runner.lastError = "leave button not found";
          push("离开失败：" + runner.lastError + "（已停止自动重连）");
          renderStatus();
          return false;
        }
        // 写离开记录供授权页(另一个域名)读、按类型算冷却决定是否自动重连
        recordLeave(reason, me, { noReconnect });
        clearAutoFireBurst(true);
        clearAttackLock("离开脱战");
        clearHuntTarget();
        clearCoinRoute();
        runner.fleeAnchor = null;
        runner.cruiseDodgeUntil = 0;
        runner.combatRisk = "clear";
        if (runner.timer) {
          clearInterval(runner.timer);
          runner.timer = 0;
        }
        runner.tickMs = STEP_TICK_MS;
        try {
          button.click();
          push("已点击离开脱战：" + reason);
        } catch (err) {
          clearReconnectState();
          runner.lastError = String(err && err.message || err);
          push("离开失败：" + runner.lastError + "（已停止自动重连）");
        }
        renderStatus();
        return true;
      }

      function monitorStoppedDamage() {
        if (runner.leaveInProgress) return true;
        const me = getMe();
        if (runner.running) {
          runner.stoppedHpBaseline = me ? Number(me.hp || 0) : null;
          return false;
        }
        if (!me) {
          runner.stoppedHpBaseline = null;
          return false;
        }
        const hp = Number(me.hp || 0);
        if (!Number.isFinite(hp)) return false;
        if (runner.stoppedHpBaseline === null || me.life !== "Alive" || hp <= 0) {
          runner.stoppedHpBaseline = hp;
          return false;
        }
        if (hp < runner.stoppedHpBaseline) {
          const previousHp = runner.stoppedHpBaseline;
          runner.stoppedHpBaseline = hp;
          clickLeave("停止模式血量下降 " + previousHp + " -> " + hp);
          return true;
        }
        if (hp > runner.stoppedHpBaseline) runner.stoppedHpBaseline = hp;
        return false;
      }

      // 识别"刚通过自动重连回到游戏":授权页点允许前写过 ack(=离开 ts),
      // 游戏侧读到的 ack 对得上最近一条离开记录 → 进入安全恢复态。仅在 pageMain
      // 起始探测一次。
      function detectRejoinOnLoad() {
        try {
          const bridge = (typeof window !== "undefined" && window.__crgrReconnect) || null;
          if (!bridge) return;
          const ack = typeof bridge.readAck === "function" ? bridge.readAck() : null;
          const leave = typeof bridge.readLeave === "function" ? bridge.readLeave() : null;
          const flow = typeof bridge.readFlow === "function" ? bridge.readFlow() : null;
          const active = typeof bridge.isRecordActive === "function" ? bridge.isRecordActive(leave) : true;
          if (!ack || !leave || !leave.ts || String(ack) !== String(leave.ts)
            || !active || leave.enabled === false
            || !flow || String(flow.ts) !== String(leave.ts)) return;
          // 命中:刚自动重连回来。lowhp 离开的格外危险,用更大发车范围 + 不自动启动。
          runner.rejoinRecovery = true;
          runner.rejoinLeaveType = leave.type || "damage";
          runner.rejoinSafeSince = 0;
          runner.rejoinPeakHp = null;
          push("检测到自动重连回游戏,进入安全恢复态(type=" + runner.rejoinLeaveType + ")…");
          // 不自动恢复运行:停留 !running,由 monitorRejoinRecovery 看护
        } catch (_) {}
      }

      // 安全恢复态看护:每 500ms 由 renderStatus 调用。
      // - 若 170m(lowhp 时放宽到 250m)内出现富敌/移动威胁 → 立刻再离开,别在原地被秒。
      // - 一旦 HP 已恢复过安全阈值 且 连续"耐力"看护无近身威胁持续 8s → 自动解除恢复态并 start()。
      // - 用户手动点"启动"会覆盖:见 start() 内对 rejoin 的处理。
      function monitorRejoinRecovery() {
        if (!runner.rejoinRecovery) return;
        if (runner.leaveInProgress) return;
        const me = getMe();
        if (!me) return; // 还没识别到玩家实体,继续等
        const hp = Number(me.hp || 0);
        if (!Number.isFinite(hp)) return;
        if (runner.rejoinPeakHp === null) runner.rejoinPeakHp = hp;
        if (hp > runner.rejoinPeakHp) runner.rejoinPeakHp = hp;
        if (hp < runner.rejoinPeakHp) {
          push("重连恢复态血量下降，停止本轮自动重连");
          clickLeave("重连恢复态血量下降 " + runner.rejoinPeakHp + " -> " + hp, { noReconnect: true });
          return;
        }
        const isLowHpRejoin = runner.rejoinLeaveType === "lowhp";
        const scanCm = isLowHpRejoin ? 25000 : RICH_ENEMY_ESCAPE_CM;
        try {
          const threats = escapeEnemies(me, scanCm);
          if (threats.length > 0) {
            const t = threats[0];
            if (!runner.running) {
              push("重连恢复态:近身威胁(" + Math.round(t.dist / 100) + "m)再离开——排除出生即被秒");
              clickLeave("重连恢复态近身威胁 " + Math.round(t.dist / 100) + "m", { noReconnect: true });
            } else {
              // 已被用户手动启动,仍有近身威胁:不重启恢复态流程,交给主循环逃离分支
            }
            runner.rejoinSafeSince = 0;
            return;
          }
        } catch (_) {
          // escapeEnemies 异常不致命,继续看后续判定
        }
        if (runner.running) { // 用户已手动接管,退出恢复态由 start() 处理
          runner.rejoinRecovery = false;
          runner.rejoinPeakHp = null;
          return;
        }
        if (hp < runner.rejoinTargetHpSafe) {
          runner.rejoinSafeSince = 0;
          return;
        }
        if (!runner.rejoinSafeSince) runner.rejoinSafeSince = Date.now();
        if (Date.now() - runner.rejoinSafeSince >= 8000) {
          runner.rejoinRecovery = false;
          runner.rejoinSafeSince = 0;
          runner.rejoinPeakHp = null;
          // 重连已确认安全:清掉所有流程标记,自动恢复挂机。
          clearReconnectState();
          push("重连恢复态已解除(HP=" + hp + ",近身无威胁),自动恢复挂机");
          start();
        }
      }

      function setStepInterval(ms) {
        const next = Number(ms) || STEP_TICK_MS;
        if (runner.tickMs === next && runner.timer) return;
        runner.tickMs = next;
        if (!runner.running || !runner.timer) return;
        clearInterval(runner.timer);
        runner.timer = window.setInterval(step, runner.tickMs);
      }

      function setAutoFireMode(active, reason) {
        const next = !!active;
        if (runner.autoFireMode === next) return;
        runner.autoFireMode = next;
        runner.autoFireLastAt = 0;
        runner.autoFireNextBurstAt = 0;
        runner.autoFireStatus = next ? "待机" : "OFF";
        runner.autoFireTarget = "";
        if (next) {
          push("自动攻击已开启：使用长按连发覆盖目标");
          if (!runner.running) start();
          else setStepInterval(AUTO_FIRE_LOOP_MS);
        } else {
          clearAutoFireBurst(true);
          push("自动攻击已关闭" + (reason ? "：" + reason : ""));
          if (runner.running && !runner.combatMode) setStepInterval(STEP_TICK_MS);
        }
        renderStatus();
      }

      function toggleAutoFireMode() {
        setAutoFireMode(!runner.autoFireMode, "manual");
      }

      function setCombatMode(active, reason) {
        const next = !!active;
        if (runner.combatMode === next) return;
        const clearedManualTarget = next && reason === "manual" && !!runner.manualTarget;
        if (clearedManualTarget) {
          clearManualTarget("手动开启临时交战");
        }
        runner.combatMode = next;
        clearCoinRoute();
        runner.planNextAt = 0;
        runner.navTarget = null;
        runner.lastCombatDodge = { dx: 0, dy: 0, score: 0 };
        runner.lastCombatSwitchAt = 0;
        runner.combatManualOverride = false;
        runner.combatProjectiles = 0;
        runner.combatTargets = 0;
        runner.combatRisk = next ? "watch" : "clear";
        runner.combatSpacingState = "none";
        runner.combatSpacingMeters = null;
        if (next) {
          clearScriptMoveKeys(true);
          push("临时交战已开启，暂停金币巡航" + (clearedManualTarget ? "，已取消右键目标" : ""));
          if (!runner.running) start();
        } else {
          runner.projectileMotion.clear();
          setStepInterval(STEP_TICK_MS);
          stopMove();
          setDanger(false);
          push("临时交战已关闭，恢复金币巡航" + (reason ? "：" + reason : ""));
        }
        renderLines();
        renderStatus();
      }

      function toggleCombatMode() {
        setCombatMode(!runner.combatMode, "manual");
      }

      function combatDangerLevel(me, enemies) {
        const hp = numberFrom(me, ["hp", "health", "life_value", "current_hp"], 0);
        if (hp <= COMBAT_CRITICAL_HP) return "critical";
        const outmatched = enemies.some(enemy => enemy.hpForCombat > 0 && enemy.hpForCombat >= hp * 1.15);
        return outmatched ? "outmatched" : "clear";
      }

      function applyCombatDodge(me, spacingEnemies) {
        const now = Date.now();
        const projectiles = activeProjectiles(me, now);
        runner.combatProjectiles = projectiles.length;
        const manual = manualMoveVector();
        if (manual.active) {
          clearScriptMoveKeys(true);
          runner.combatManualOverride = true;
          runner.lastMoveMode = "manual-combat";
          runner.combatSpacingState = combatSpacingState(spacingEnemies).state;
          runner.combatSpacingMeters = null;
          return projectiles.length;
        }
        runner.combatManualOverride = false;
        const dodge = chooseCombatDodge(me, projectiles, spacingEnemies);
        const changed = dodge.dx !== runner.lastCombatDodge.dx || dodge.dy !== runner.lastCombatDodge.dy;
        if (changed) runner.lastCombatSwitchAt = now;
        runner.lastCombatDodge = dodge;
        runner.combatSpacingState = dodge.spacingState || "none";
        runner.combatSpacingMeters = Number.isFinite(dodge.spacingDistance)
          ? Math.round(dodge.spacingDistance / 100)
          : null;
        if (dodge.dx === 0 && dodge.dy === 0) {
          setVelocity(0, 0, { preserveUser: true });
          runner.lastMoveMode = projectiles.length ? "combat-hold" : "combat-spacing-hold";
        } else {
          setVelocity(dodge.dx, dodge.dy, { preserveUser: true });
          runner.lastMoveMode = projectiles.length ? "combat-dodge" : "combat-spacing";
        }
        return projectiles.length;
      }

      // 常态巡航轻量弹道躲避：复用交战弹道预测数学，但不进 combatMode、不清 coin route。
      // 仅在追杀/交战之外生效；压迫度低或子弹飞过后立刻还控制权给金币规划。
      function handleCruiseProjectileDodge(me) {
        if (runner.combatMode || runner.huntMode) return false;
        const now = Date.now();
        const projectiles = activeProjectiles(me, now);
        const pressure = combatProjectilePressure(projectiles, me);
        const near = projectiles.some(projectile => projectile.dist < CRUISE_DODGE_NEAR_CM);
        const hot = pressure >= CRUISE_DODGE_PRESSURE || near;
        if (hot) runner.cruiseDodgeUntil = now + CRUISE_DODGE_HOLD_MS;
        if (!projectiles.length || (!hot && now >= (runner.cruiseDodgeUntil || 0))) {
          if (!hot) runner.cruiseDodgeUntil = 0;
          return false;
        }

        // 巡航躲避只看子弹，不维护交战距离带（spacing 传空）。
        const dodge = chooseCombatDodge(me, projectiles, []);
        const changed = dodge.dx !== (runner.lastCombatDodge && runner.lastCombatDodge.dx)
          || dodge.dy !== (runner.lastCombatDodge && runner.lastCombatDodge.dy);
        if (changed) runner.lastCombatSwitchAt = now;
        runner.lastCombatDodge = dodge;
        if (dodge.dx === 0 && dodge.dy === 0) {
          setVelocity(0, 0);
          runner.lastMoveMode = "cruise-dodge-hold";
        } else {
          setVelocity(dodge.dx, dodge.dy);
          runner.lastMoveMode = "cruise-dodge";
          setNavigationTarget(
            Number(me.x) + dodge.dx * 8000,
            Number(me.y) + dodge.dy * 8000,
            "evade"
          );
        }
        if (near) setDanger(true);
        else setDanger(false);
        runner.lastAction = "巡航躲弹：弹体 " + projectiles.length
          + " 压迫 " + Math.round(pressure)
          + (near ? " 近弹" : "");
        return true;
      }

      function handleCombatMode(me, hp) {
        if (!runner.combatMode) return false;
        setStepInterval(hp < COMBAT_FAST_CHECK_HP ? COMBAT_FAST_TICK_MS : (runner.autoFireMode ? AUTO_FIRE_LOOP_MS : STEP_TICK_MS));
        clearCoinRoute();
        runner.planNextAt = 0;
        runner.navTarget = null;

        const enemies = combatEnemies(me);
        const spacingEnemies = combatSpacingEnemies(me);
        runner.combatTargets = enemies.filter(enemy => enemy.hpForCombat > 0 && enemy.hpForCombat < hp).length;

        if (hp <= COMBAT_LOW_HP) {
          runner.combatRisk = "critical";
          setDanger(true, "critical");
          clickLeave("临时交战血量≤" + COMBAT_LOW_HP + "：" + hp);
          return true;
        }

        runner.combatRisk = combatDangerLevel(me, enemies);
        if (runner.combatRisk === "critical") {
          setDanger(true, "critical");
        } else if (runner.combatRisk === "outmatched") {
          setDanger(true);
        } else {
          setDanger(false);
        }

        handleAutoFire(me);

        if (runner.manualTarget) {
          runner.combatProjectiles = activeProjectiles(me, Date.now()).length;
          runner.combatSpacingState = combatSpacingState(spacingEnemies).state;
          runner.combatSpacingMeters = null;
          runner.combatManualOverride = false;
          if (driveManualTarget(me, "临时交战：前往", { preserveUser: true, respectUserInput: true })) {
            return true;
          }
        }

        const projectileCount = applyCombatDodge(me, spacingEnemies);
        const spacingText = runner.combatSpacingMeters === null
          ? ""
          : "，距离 " + runner.combatSpacingMeters + "m";
        runner.lastAction = runner.combatManualOverride
          ? "临时交战：手动 WASD 接管，自动躲避暂停，标记 " + runner.combatTargets + " 个低血目标"
          : projectileCount
          ? "临时交战：躲避 " + projectileCount + " 个弹体" + spacingText + "，标记 " + runner.combatTargets + " 个低血目标"
          : runner.lastMoveMode === "combat-spacing"
          ? "临时交战：调整距离到100-150m" + spacingText + "，标记 " + runner.combatTargets + " 个低血目标"
          : "临时交战：未识别到弹体，保持观察" + spacingText + "，标记 " + runner.combatTargets + " 个低血目标";
        return true;
      }

      function step() {
        try {
          if (checkHourlyStaminaLimitLeave()) return;

          const me = getMe();
          if (!me) {
            stopMove();
            runner.lastAction = "等待玩家实体";
            return;
          }

          const hp = Number(me.hp || 0);
          const balance = Number(me.external_balance_snapshot || 0);

          if (runner.lastHp === null) runner.lastHp = hp;
          if (runner.lastBalance === null) runner.lastBalance = balance;

          if (balance > runner.lastBalance) {
            runner.deltaBalance += balance - runner.lastBalance;
            push("收益 +" + (balance - runner.lastBalance) + "，本次累计 +" + runner.deltaBalance);
          }
          runner.lastBalance = balance;

          if (hp < runner.lastHp && !runner.combatMode) {
            setDanger(false);
            clickLeave("常态血量下降 " + runner.lastHp + " -> " + hp);
            runner.lastHp = hp;
            return;
          }
          runner.lastHp = hp;

          if (me.life !== "Alive" || hp <= 0) {
            stopMove();
            setDanger(false);
            runner.lastAction = "非存活状态，停止移动";
            return;
          }

          if (Number(me.stamina_5s_remaining_milli || 0) <= 0) {
            stopMove();
            setDanger(false);
            runner.lastAction = "短时体力耗尽，等待恢复";
            return;
          }

          // 契约未知 → fail closed:只保留上层(血量离开/体力/非存活)安全逻辑,
          // 停用自动移动/追杀/交战/攻击/金币巡航,并在 HUD 提示导出诊断。
          if (runner.stepReady === false) {
            stopMove();
            setDanger(false);
            runner.lastAction = runner.contractReason || "页面契约未知·停用自动移动";
            return;
          }

          trackEnemyMotion(Date.now());

          if (handleCombatMode(me, hp)) return;

          if (runner.autoFireMode) {
            if (runner.fireReady !== false) {
              setStepInterval(AUTO_FIRE_LOOP_MS);
              handleAutoFire(me);
            } else {
              runner.autoFireStatus = "页面契约不满足·自动攻击不可用";
              setStepInterval(STEP_TICK_MS);
            }
          } else {
            setStepInterval(STEP_TICK_MS);
          }

          if (driveHuntTarget(me)) return;

          const threats = richEnemies(me, RICH_ENEMY_SCAN_CM);
          const urgentThreat = escapeEnemies(me, RICH_ENEMY_ESCAPE_CM)[0];
          if (urgentThreat) {
            const reason = urgentThreat.dropForAvoid > RICH_ENEMY_MIN_DROP
              ? "高Drop敌人进入170m射程缓冲，立即逃离"
              : "低Drop移动敌人进入170m射程缓冲，立即逃离";
            fleeFrom(urgentThreat, me, reason, true);
            return;
          }
          setDanger(false);

          const keepawayThreat = threats.find(enemy => enemy.dist < RICH_ENEMY_KEEP_CM);
          if (keepawayThreat) {
            fleeFrom(keepawayThreat, me, "富敌过近，拉开到200-250m外", false);
            return;
          }
          // 两类威胁都不在 170m/220m 范围内 → 已脱险,清掉撤离锚点状态,回到正常巡航/手动/金币规划。
          if (runner.fleeAnchor) runner.fleeAnchor = null;
          runner.fleeing = false;
          runner.fleeKey = "";

          if (handleCruiseProjectileDodge(me)) return;

          if (driveManualTarget(me, "前往")) return;

          let target = currentCoinRouteTarget(me, threats);

          const shouldReplan = !target || Date.now() >= runner.planNextAt;
          if (shouldReplan) {
            const planned = bestDropRoute(me, threats);
            const switchFactor = runner.routeAdvanced ? 0.98 : ROUTE_SWITCH_FACTOR;
            if (planned && (!target || planned.score > runner.targetScore * switchFactor)) {
              adoptCoinRoute(planned);
              target = currentCoinRouteTarget(me, threats);
              push("规划金币路线 " + runner.routeIds.join(">")
                + " / " + (runner.routeKind || "single")
                + " / " + planned.drops.length + "点"
                + " / 总额 " + Math.round(planned.value)
                + " / 路程 " + planned.travelSeconds.toFixed(1) + "s"
                + " / 评分 " + planned.score.toFixed(3));
            } else {
              runner.planNextAt = Date.now() + REPLAN_MS;
            }
            runner.routeAdvanced = false;
          }

          if (!target) {
            stopMove();
            runner.lastAction = threats.length
              ? "富敌250m内，无安全金币，保持距离"
              : "视野内没有金币";
            return;
          }

          const rx = Number(target.x) - Number(me.x);
          const ry = Number(target.y) - Number(me.y);
          const dist = Math.hypot(rx, ry);

          if (dist <= COIN_REACHED_CM) {
            // §5.7:贴近金币后先等确认;若迟迟不入账,小幅正交轻推;仍不消失则临时黑名单重规划。
            const id = runner.targetId;
            const nowArr = Date.now();
            if (runner.coinArrivalId !== id) {
              runner.coinArrivalId = id;
              runner.coinArrivalAt = nowArr;
              runner.coinArrivalNudges = 0;
            }
            if (nowArr - runner.coinArrivalAt < 600) {
              stopMove();
              runner.lastAction = "贴近金币 " + id + "，等待入账";
              return;
            }
            if (runner.coinArrivalNudges < 2) {
              runner.coinArrivalNudges += 1;
              runner.coinArrivalAt = nowArr;
              const len = Math.max(1, Math.hypot(rx, ry));
              moveToward(-ry / len, rx / len); // 正交轻推
              runner.lastAction = "金币未入账·正交轻推 " + runner.coinArrivalNudges;
              return;
            }
            runner.coinBlacklist.set(id, nowArr + 8000);
            runner.coinArrivalId = null;
            runner.coinArrivalAt = 0;
            runner.coinArrivalNudges = 0;
            clearCoinRoute();
            runner.lastAction = "金币 " + id + " 未入账·临时跳过";
            return;
          }

          const move = moveToward(rx, ry);
          setNavigationTarget(target.x, target.y, "coin");
          runner.lastAction = "前往金币 " + runner.targetId
            + "，距离 " + Math.round(dist)
            + "，路线 " + Math.max(1, runner.routeIds.length) + "点";
        } catch (err) {
          runner.lastError = String(err && err.message || err);
          stopMove();
          setDanger(false);
          push("循环错误：" + runner.lastError);
        }
      }

      function start() {
        if (runner.running) return;
        const me = getMe();
        // 用户手动启动 = 接管运行,解除重连安全恢复态,清掉旧离开记录
        runner.rejoinRecovery = false;
        runner.rejoinSafeSince = 0;
        runner.rejoinPeakHp = null;
        runner.leaveInProgress = false;
        clearReconnectState();
        runner.running = true;
        runner.startedAt = Date.now();
        runner.lastHp = me ? Number(me.hp || 0) : null;
        runner.stoppedHpBaseline = runner.lastHp;
        runner.lastBalance = me ? Number(me.external_balance_snapshot || 0) : null;
        runner.hourlyLimitLeaveTriggered = false;
        clearCoinRoute();
        runner.planNextAt = 0;
        runner.tickMs = STEP_TICK_MS;
        runner.timer = window.setInterval(step, runner.tickMs);
        push("已启动");
        step();
        renderStatus();
      }

      function stop(reason) {
        runner.running = false;
        runner.combatMode = false;
        runner.huntMode = false;
        clearHuntTarget();
        runner.combatRisk = "clear";
        runner.combatProjectiles = 0;
        runner.combatTargets = 0;
        runner.combatManualOverride = false;
        runner.autoFireMode = false;
        runner.autoFireStatus = "OFF";
        runner.autoFireTarget = "";
        clearAutoFireBurst(true);
        clearAttackLock("停止脚本");
        runner.projectileMotion.clear();
        runner.fleeAnchor = null;
        runner.cruiseDodgeUntil = 0;
        if (runner.timer) {
          clearInterval(runner.timer);
          runner.timer = 0;
        }
        runner.tickMs = STEP_TICK_MS;
        const me = getMe();
        runner.stoppedHpBaseline = me ? Number(me.hp || 0) : null;
        stopMove();
        setDanger(false);
        push("已停止" + (reason ? "：" + reason : ""));
        renderLines();
        renderStatus();
      }

      function destroy(reason) {
        stop(reason || "destroy");
        if (runner.statusTimer) clearInterval(runner.statusTimer);
        if (runner.sidebarSafetyTimer) clearInterval(runner.sidebarSafetyTimer);
        if (runner.dropLeaderboardTimer) clearInterval(runner.dropLeaderboardTimer);
        if (runner.dropLeaderboardEntryTimer) clearTimeout(runner.dropLeaderboardEntryTimer);
        if (runner.lineRaf) {
          window.cancelAnimationFrame(runner.lineRaf);
          runner.lineRaf = 0;
        }
        window.removeEventListener("resize", updateHudSceneBounds);
        window.removeEventListener("contextmenu", handleContextMenu, true);
        window.removeEventListener("keydown", handleMovementKeyDown, true);
        window.removeEventListener("keyup", handleMovementKeyUp, true);
        window.removeEventListener("blur", clearUserMoveKeys);
        root.remove();
        danger.remove();
        style.remove();
      }

      function snapshot() {
        const me = getMe();
        const enemies = me ? richEnemies(me, RICH_ENEMY_SCAN_CM) : [];
        const drop = me && !runner.combatMode && !runner.huntMode ? nearestDrop(me, enemies) : null;
        const threat = enemies[0] || runner.lastThreat;
        const manual = runner.manualTarget;
        const huntLabel = runner.huntMode
          ? ("HUNT " + (runner.huntTargetName || (runner.huntLastSeen && runner.huntLastSeen.name) || runner.huntQuery || "-"))
          : "";
        return {
          running: runner.running,
          combatMode: runner.combatMode,
          huntMode: runner.huntMode,
          huntQuery: runner.huntQuery,
          huntTargetId: runner.huntTargetId,
          huntTargetName: runner.huntTargetName || (runner.huntLastSeen && runner.huntLastSeen.name) || "",
          huntLastSeen: runner.huntLastSeen,
          combatRisk: runner.combatRisk,
          combatProjectiles: runner.combatProjectiles,
          combatTargets: runner.combatTargets,
          combatManualOverride: runner.combatManualOverride,
          autoFireMode: runner.autoFireMode,
          autoFireStatus: runner.autoFireStatus,
          autoFireTarget: runner.autoFireTarget,
          plannedShots: runner.plannedShots,
          attackLockUserId: runner.attackLockUserId,
          attackLockName: runner.attackLockName,
          attackLockStatus: runner.attackLockStatus,
          hp: me && me.hp,
          life: me && me.life,
          balance: me && me.external_balance_snapshot,
          value: me && me.coin_value_snapshot,
          delta: runner.deltaBalance,
          leaves: runner.leaves,
          avoidances: runner.avoidances,
          target: huntLabel || (manual ? (manual.x + "," + manual.y) : runner.targetId),
          nearest: drop ? Math.round(drop.dist) : "-",
          targetScore: runner.targetScore ? runner.targetScore.toFixed(3) : "-",
          routeCount: runner.routeIds ? runner.routeIds.length : 0,
          routeKind: runner.routeKind || "",
          routeValue: runner.routeValue || 0,
          routeTravelSeconds: runner.routeTravelSeconds || 0,
          moveMode: runner.lastMoveMode,
          manualTarget: manual ? { x: manual.x, y: manual.y } : null,
          threat: threat ? {
            name: threat.name || "unknown",
            drop: threat.dropForAvoid ?? threat.drop,
            dist: Math.round(threat.dist)
          } : null,
          stamina5s: me && Math.round((me.stamina_5s_remaining_milli || 0) / 1000),
          stamina1h: me && Math.round((me.stamina_1h_remaining_milli || 0) / 1000),
          action: runner.lastAction,
          error: runner.lastError
        };
      }

      function renderStatus() {
        monitorStoppedDamage();
        monitorRejoinRecovery();
        const s = snapshot();
        scheduleEntryDropLeaderboardRefresh();
        renderAttackLockList(getMe());
        root.classList.toggle("running", !!s.running);
        ui.mode.textContent = runner.rejoinRecovery
          ? ("REJOIN " + (runner.rejoinLeaveType || "").toUpperCase())
          : (s.combatMode ? "COMBAT" : s.huntMode ? "HUNT" : (s.running ? "ACTIVE" : "STANDBY"));
        ui.action.textContent = s.error ? ("ERROR: " + s.error) : (s.action || "等待指令");
        ui.hp.textContent = s.hp ? String(s.hp) : "--";
        ui.gain.textContent = "+" + (s.delta || 0);
        ui.target.textContent = s.combatMode ? "COMBAT" : s.huntMode ? ("HUNT " + (s.huntTargetName || s.huntQuery || "-")) : (s.target ? String(s.target) : "--");
        ui.move.textContent = s.moveMode || "idle";
        ui.threat.textContent = s.combatMode
          ? ((s.combatManualOverride ? "手动 / " : "") + "弹体 " + s.combatProjectiles + " / 标记 " + s.combatTargets + " / " + s.combatRisk)
          : s.threat
          ? (s.threat.name + " / " + s.threat.dist + "cm / Drop " + s.threat.drop)
          : s.autoFireMode
          ? ("射击 " + (s.autoFireTarget || "-") + " / " + s.autoFireStatus)
          : "clear";
        ui.stamina.textContent = "5s " + (s.stamina5s ?? "--") + " / 1h " + (s.stamina1h ?? "--");
        ui.safety.textContent = "LEAVE " + s.leaves + " / EVADE " + s.avoidances;
        ui.status.textContent = s.combatMode
          ? ("COMBAT / " + (s.combatManualOverride ? "MANUAL / " : "") + "BULLETS " + s.combatProjectiles + " / TARGETS " + s.combatTargets
            + (s.autoFireMode ? " / FIRE " + s.autoFireStatus : ""))
          : s.huntMode
          ? ("HUNT / QUERY " + (s.huntQuery || "-") + " / TARGET " + (s.huntTargetName || "-")
            + (s.autoFireMode ? " / FIRE " + s.autoFireStatus : ""))
          : "BAL " + (s.balance ?? "--")
            + " / VALUE " + (s.value ?? "--")
            + " / NEAREST " + s.nearest
            + " / ROUTE " + (s.routeKind || "single") + ":" + (s.routeCount || 0)
            + " / SCORE " + s.targetScore
            + (s.autoFireMode ? " / FIRE " + s.autoFireStatus : "");
        if (runner.contractStatus && runner.contractStatus !== "READY") {
          ui.status.textContent += " / 契约 " + runner.contractStatus
            + (runner.contractReason ? ":" + runner.contractReason : "");
        }
        ui.combat.classList.toggle("active", !!s.combatMode);
        ui.combat.textContent = s.combatMode ? "交战 ON" : "临时交战";
        ui.autoFire.classList.toggle("active", !!s.autoFireMode);
        ui.autoFire.textContent = s.autoFireMode ? "攻击 ON" : "自动攻击";
        ui.hunt.classList.toggle("active", !!s.huntMode);
        ui.hunt.textContent = s.huntMode ? "追杀 ON" : "追杀";
        ui.reconnect.classList.toggle("active", runner.autoReconnect !== false);
        ui.reconnect.textContent = runner.autoReconnect !== false ? "重连 ON" : "重连 OFF";
      }

      // 导出诊断:契约字段类型 + 重连摘要 + 页面指纹(不含 Cookie/token/localStorage)。
      function exportContractDiagnostics() {
        let rec = null;
        let flow = null;
        let mode = "NAVIGATE_ONLY";
        try {
          const bridge = (typeof window !== "undefined" && window.__crgrReconnect) || null;
          if (bridge) {
            const leave = bridge.readLeave ? bridge.readLeave() : null;
            const f = bridge.readFlow ? bridge.readFlow() : null;
            const m = bridge.readConsentMode ? bridge.readConsentMode() : null;
            rec = leave ? { type: leave.type, enabled: !!leave.enabled, at: Number(leave.ts || 0) } : null;
            flow = f ? { phase: f.phase, type: f.type, attempt: Number(f.attempt || 0), lastError: f.lastError || null } : null;
            mode = m || "NAVIGATE_ONLY";
          }
        } catch (_) {}
        return {
          contract: {
            status: runner.contractStatus || "UNKNOWN",
            fieldTypes: runner.contractReport || null,
            reason: runner.contractReason || ""
          },
          reconnect: {
            enabled: runner.autoReconnect !== false,
            consentMode: mode,
            leave: rec,
            flow
          },
          page: { url: location.href.replace(/[?#].*$/, ""), title: document.title || "" }
        };
      }

      runner.start = start;
      runner.stop = stop;
      runner.destroy = destroy;
      runner.leave = reason => clickLeave(reason || "manual");
      runner.setCombatMode = setCombatMode;
      runner.setHuntMode = setHuntMode;
      runner.setAutoFireMode = setAutoFireMode;
      runner.setManualTarget = setManualTarget;
      runner.clearManualTarget = clearManualTarget;
      runner.status = snapshot;
      runner.exportDiagnostics = exportContractDiagnostics;

      window.addEventListener("contextmenu", handleContextMenu, true);
      window.addEventListener("keydown", handleMovementKeyDown, true);
      window.addEventListener("keyup", handleMovementKeyUp, true);
      window.addEventListener("blur", clearUserMoveKeys);
      ui.start.addEventListener("click", start);
      ui.stop.addEventListener("click", () => stop("manual"));
      ui.combat.addEventListener("click", toggleCombatMode);
      ui.autoFire.addEventListener("click", toggleAutoFireMode);
      ui.hunt.addEventListener("click", toggleHuntMode);
      ui.huntQuery.addEventListener("keydown", event => {
        if (event.key === "Enter") {
          event.preventDefault();
          setHuntMode(true, "enter");
        }
      });
      ui.leave.addEventListener("click", () => clickLeave("manual"));
      ui.reconnect.addEventListener("click", toggleReconnect);
      root.querySelector('[data-crgr="reconnect-clear"]').addEventListener("click", () => {
        clearReconnectState();
        push("已清理重连状态");
        renderStatus();
      });
      root.querySelector('[data-crgr="reconnect-retry"]').addEventListener("click", retryReconnectOnce);
      ui.dropList.addEventListener("click", handleDropLeaderboardClick);
      ui.attackList.addEventListener("click", handleAttackListClick);
      ui.collapse.addEventListener("click", () => {
        root.classList.toggle("collapsed");
        ui.collapse.textContent = root.classList.contains("collapsed") ? "SHOW" : "HUD";
      });

      runner.statusTimer = window.setInterval(renderStatus, 500);
      runner.sidebarSafetyTimer = window.setInterval(checkHourlyStaminaLimitLeave, 1000);
      runner.dropLeaderboardTimer = window.setInterval(renderDropLeaderboard, DROP_LEADERBOARD_REFRESH_MS);
      startLineLoop();
      checkHourlyStaminaLimitLeave();
      renderDropLeaderboard();
      detectRejoinOnLoad();
      renderStatus();
    }
  }
})();
