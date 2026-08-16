// ==UserScript==
// @name Grasp Rat Raider Runner
// @namespace https://grasp-rat-game.h-e.top/
// @version 2.0.0
// @description Raider profile: profitable target pursuit, combat fire, post-kill loot, stall recovery, and reconnect support.
// @match https://grasp-rat-game.h-e.top/*
// @match https://connect.linux.do/oauth2/authorize*
// @noframes
// @run-at document-end
// @grant unsafeWindow
// @grant GM_setValue
// @grant GM_getValue
// @grant GM_deleteValue
// ==/UserScript==

(() => {
  // artifacts/prepared-desktop.user.js
  (function() {
    "use strict";
    let RECONNECT_KEY_LEAVE = "crgrLeaveRecord", RECONNECT_KEY_ACK = "crgrReconnectAck", RECONNECT_KEY_FLOW = "crgrReconnectFlow", RECONNECT_KEY_SWITCH = "crgrAutoReconnect", RECONNECT_KEY_CONSENT = "crgrConsentMode", RECONNECT_AUTO_TYPES = /* @__PURE__ */ new Set(["damage", "lowhp", "stamina"]), RECONNECT_TERMINAL = /* @__PURE__ */ new Set(["FAILED_RETRYABLE", "FAILED_MANUAL", "CANCELLED", "EXPIRED", "DONE"]);
    function gmGet(key) {
      try {
        if (typeof GM_getValue == "function") return GM_getValue(key);
      } catch {
      }
    }
    function gmSet(key, val) {
      try {
        typeof GM_setValue == "function" && GM_setValue(key, val);
      } catch {
      }
    }
    function gmDel(key) {
      try {
        typeof GM_deleteValue == "function" && GM_deleteValue(key);
      } catch {
      }
    }
    function reconnectCooldownMs(type) {
      return type === "damage" ? 0 : type === "lowhp" ? 18e5 : type === "stamina" ? 36e5 : -1;
    }
    function reconnectRecordIsActive(rec, now) {
      if (!rec || !RECONNECT_AUTO_TYPES.has(rec.type)) return !1;
      let ts = Number(rec.ts);
      if (!Number.isFinite(ts)) return !1;
      let age = (Number(now) || Date.now()) - ts;
      return age < -60 * 1e3 ? !1 : age <= reconnectCooldownMs(rec.type) + 6e5;
    }
    function reconnectId() {
      try {
        if (typeof crypto < "u" && crypto.randomUUID) return crypto.randomUUID();
      } catch {
      }
      return "f" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
    }
    function isExpectedOAuthUrl(raw) {
      try {
        let url = new URL(String(raw || ""), location.href);
        return url.protocol === "https:" && url.hostname === "connect.linux.do" && url.pathname === "/oauth2/authorize";
      } catch {
        return !1;
      }
    }
    function isOAuthAuthorizePage() {
      try {
        return location.origin === "https://connect.linux.do" && (location.pathname === "/oauth2/authorize" || location.pathname.indexOf("/oauth2/authorize/") === 0);
      } catch {
        return !1;
      }
    }
    function contractPresent(value, expectation) {
      return typeof value > "u" || value === null || value === !1 ? !1 : expectation === "function" ? typeof value == "function" : expectation === "array" ? Array.isArray(value) : expectation === "Set-like" ? value && (value instanceof Set || typeof value.add == "function" || typeof value.has == "function" || typeof value.delete == "function") : expectation === "HTMLElement" ? typeof value == "object" && typeof value.getContext == "function" : expectation === "present" ? !0 : expectation === "object" ? typeof value == "object" && !Array.isArray(value) : !0;
    }
    let GAME_CONTRACT_REQUIRED = [
      ["state", "object"],
      ["state.entities", "array"],
      ["state.coinDrops", "array"],
      ["state.keys", "Set-like"],
      ["state.currentUserId", "present"],
      ["sendVelocity", "function"]
    ], GAME_CONTRACT_OPTIONAL_CRITICAL = [
      ["canvas", "HTMLElement"],
      ["setPointerFromClient", "function"],
      ["screenCenter", "function"]
    ];
    function classifyGameContract(report) {
      let out = { status: "READY", missing: [], criticalMissing: [], report: {} };
      for (let [key, expect] of GAME_CONTRACT_REQUIRED) {
        let value = report ? report[key] : void 0, ok = contractPresent(value, expect);
        out.report[key] = ok ? expect : "missing", ok || out.missing.push(key);
      }
      for (let [key, expect] of GAME_CONTRACT_OPTIONAL_CRITICAL) {
        let value = report ? report[key] : void 0, ok = contractPresent(value, expect);
        out.report[key] = ok ? expect : "missing", ok || out.criticalMissing.push(key);
      }
      return out.missing.length ? out.status = "INCOMPATIBLE" : out.criticalMissing.length ? out.status = "DEGRADED" : out.status = "READY", out;
    }
    try {
      typeof unsafeWindow < "u" && (unsafeWindow.__crgrContract = Object.freeze({ classify: classifyGameContract }));
    } catch {
    }
    function newFlow(leave) {
      let ts = Number(leave && leave.ts);
      return {
        version: 3,
        flowId: reconnectId(),
        ts: String(leave && leave.ts),
        type: leave && leave.type || "damage",
        phase: "leave",
        reason: leave && leave.reason || "",
        at: Date.now(),
        dueAt: Number.isFinite(ts) ? ts + reconnectCooldownMs(leave && leave.type || "damage") : 0,
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
      return gmGet(RECONNECT_KEY_SWITCH) === !0;
    }
    function reconnectReadConsentMode() {
      return gmGet(RECONNECT_KEY_CONSENT) === "STRICT_AUTO_CONSENT" ? "STRICT_AUTO_CONSENT" : "NAVIGATE_ONLY";
    }
    function flowWriteMerge(ts, patch) {
      let flow = gmGet(RECONNECT_KEY_FLOW);
      if (!flow || String(flow.ts) !== String(ts)) return null;
      let next = Object.assign({}, flow, patch, {
        lastTransitionAt: Date.now()
      });
      return gmSet(RECONNECT_KEY_FLOW, next), gmGet(RECONNECT_KEY_FLOW);
    }
    let reconnectBridge = {
      readLeave() {
        return gmGet(RECONNECT_KEY_LEAVE) || null;
      },
      writeLeave(rec) {
        gmSet(RECONNECT_KEY_LEAVE, rec);
      },
      clearLeave() {
        gmDel(RECONNECT_KEY_LEAVE);
      },
      readFlow() {
        return gmGet(RECONNECT_KEY_FLOW) || null;
      },
      markLeaveFlow(ts) {
        let leave = gmGet(RECONNECT_KEY_LEAVE);
        if (!leave || String(leave.ts) !== String(ts)) return null;
        let flow = newFlow(leave);
        return gmSet(RECONNECT_KEY_FLOW, flow), flow;
      },
      readSwitch: reconnectReadSwitch,
      setSwitch(on) {
        gmSet(RECONNECT_KEY_SWITCH, !!on);
      },
      readConsentMode: reconnectReadConsentMode,
      setConsentMode(mode) {
        gmSet(RECONNECT_KEY_CONSENT, mode === "STRICT_AUTO_CONSENT" ? "STRICT_AUTO_CONSENT" : "NAVIGATE_ONLY");
      },
      readAck() {
        return gmGet(RECONNECT_KEY_ACK);
      },
      clearAck() {
        gmDel(RECONNECT_KEY_ACK);
      },
      clearFlow() {
        gmDel(RECONNECT_KEY_FLOW);
      },
      claimAck(ts) {
        let ack = gmGet(RECONNECT_KEY_ACK);
        if (ack && String(ack) === String(ts)) return !1;
        let leave = gmGet(RECONNECT_KEY_LEAVE);
        return !leave || String(leave.ts) !== String(ts) ? !1 : (gmSet(RECONNECT_KEY_ACK, ts), !0);
      },
      // 冷却映射(ms):供游戏域名页算"距离开多久才能重连"
      cooldownMs: reconnectCooldownMs,
      isRecordActive: reconnectRecordIsActive
    };
    try {
      typeof unsafeWindow < "u" ? unsafeWindow.__crgrReconnect = reconnectBridge : window.__crgrReconnect = reconnectBridge;
    } catch {
      try {
        window.__crgrReconnect = reconnectBridge;
      } catch {
      }
    }
    function isVisibleEnabledAction(el) {
      if (!el || !el.isConnected || el.disabled || el.getAttribute("aria-disabled") === "true") return !1;
      try {
        let rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) return !1;
        let style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || style.pointerEvents === "none")
          return !1;
      } catch {
      }
      return !0;
    }
    function findAuthorizeButton() {
      if (!isOAuthAuthorizePage()) return null;
      let denyRe = /拒绝|取消|deny|cancel|decline|reject|refuse|不同意|不授权|不允许|not now|退出|登出|logout/, allowExact = /* @__PURE__ */ new Set(["允许", "授权", "同意", "确认", "authorize", "accept", "approve", "allow", "grant"]), normalize = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
      try {
        let primary = document.querySelector(
          "a.btn-pill-primary, a.btn-pill.btn-pill-primary, button.btn-pill-primary, input.btn-pill-primary"
        );
        if (primary && isVisibleEnabledAction(primary)) {
          let t = normalize(primary.innerText || primary.textContent || primary.value || "");
          if (allowExact.has(t) && !denyRe.test(t)) return primary;
        }
      } catch {
      }
      try {
        let targetForm = Array.from(document.forms || []).find((f) => {
          let action = f.getAttribute && (f.getAttribute("action") || f.action || "");
          return isExpectedOAuthUrl(action);
        });
        if (targetForm) {
          let els2 = Array.from(targetForm.querySelectorAll(
            "button, input[type='submit'], a[role='button'], input[type='button']"
          )).filter(isVisibleEnabledAction);
          for (let el of els2) {
            let t = normalize(el.innerText || el.textContent || el.value || el.getAttribute && el.getAttribute("value") || "");
            if (allowExact.has(t) && !denyRe.test(t)) return el;
          }
          return null;
        }
      } catch {
      }
      return null;
    }
    function oauthReconnectMain() {
      try {
        if (!isOAuthAuthorizePage()) {
          document.title = "[非授权页·自动重连不动作] " + (document.title || "");
          return;
        }
        if (!reconnectBridge.readSwitch()) {
          document.title = "[自动重连已关闭·不点允许] " + (document.title || "");
          return;
        }
        let consentMode = reconnectBridge.readConsentMode(), rec = reconnectBridge.readLeave(), flow = reconnectBridge.readFlow();
        if (!reconnectBridge.isRecordActive(rec) || rec.enabled === !1 || !flow || !rec.ts || String(flow.ts) !== String(rec.ts)) {
          document.title = "[无有效重连流程·不点允许] " + (document.title || "");
          return;
        }
        if (RECONNECT_TERMINAL.has(flow.phase)) {
          document.title = "[重连已终止·" + flow.phase + "] " + (document.title || "");
          return;
        }
        let ack = reconnectBridge.readAck();
        if (ack && String(ack) === String(rec.ts)) {
          document.title = "[已重连过·不重复点] " + (document.title || "");
          return;
        }
        if (flow.phase === "auth") {
          document.title = "[授权动作已占用·不重复点] " + (document.title || "");
          return;
        }
        if (flow.phase !== "game-login") {
          flow.phase === "leave" && (reconnectBridge.clearLeave(), reconnectBridge.clearAck(), reconnectBridge.clearFlow()), document.title = "[未确认游戏页登录·不点允许] " + (document.title || "");
          return;
        }
        if (consentMode === "NAVIGATE_ONLY") {
          document.title = "[请手动允许授权]" + (document.title ? " " + document.title : "");
          return;
        }
        if (!flowWriteMerge(rec.ts, { phase: "auth", deadline: Date.now() + 12e4 })) {
          document.title = "[授权动作已占用·不重复点] " + (document.title || "");
          return;
        }
        let baseTitle = document.title || "", startedAt = Date.now(), poll = 0, hookedAuthorizeButton = null, cancelForManualAuthorize = () => {
          reconnectBridge.clearLeave(), reconnectBridge.clearAck(), reconnectBridge.clearFlow(), document.title = "[手动允许·自动重连已取消] " + baseTitle, poll && clearInterval(poll), poll = 0;
        }, hookManualAuthorize = (button) => {
          if (!(!button || button === hookedAuthorizeButton)) {
            hookedAuthorizeButton = button;
            try {
              button.addEventListener("click", (event) => {
                event && event.isTrusted === !0 && cancelForManualAuthorize();
              }, !0);
            } catch {
            }
          }
        };
        poll = window.setInterval(() => {
          try {
            let current = reconnectBridge.readLeave(), currentFlow = reconnectBridge.readFlow(), now = Date.now();
            if (!reconnectBridge.readSwitch() || !reconnectBridge.isRecordActive(current) || current.enabled === !1 || !current.ts || String(current.ts) !== String(rec.ts) || !currentFlow || String(currentFlow.ts) !== String(rec.ts) || currentFlow.phase !== "auth" || RECONNECT_TERMINAL.has(currentFlow.phase)) {
              clearInterval(poll), poll = 0;
              return;
            }
            let currentAck = reconnectBridge.readAck();
            if (currentAck && String(currentAck) === String(rec.ts)) {
              clearInterval(poll), document.title = "[已重连过·不重复点] " + baseTitle;
              return;
            }
            let cooldown = reconnectBridge.cooldownMs(current.type), dueAt = Number(current.ts) + cooldown;
            if (now < dueAt) {
              document.title = "[冷却中·不点允许] " + baseTitle;
              return;
            }
            if (now - startedAt > 12e4) {
              flowWriteMerge(rec.ts, {
                phase: "FAILED_MANUAL",
                deadline: now,
                lastError: "授权按钮超时未见,页面结构未知,需要手动授权"
              }), clearInterval(poll), poll = 0, document.title = "[页面结构未知·需要手动授权] " + baseTitle;
              return;
            }
            let btn = findAuthorizeButton();
            if (btn) {
              if (hookManualAuthorize(btn), !reconnectBridge.claimAck(rec.ts)) {
                clearInterval(poll), poll = 0;
                return;
              }
              clearInterval(poll), poll = 0, document.title = "[已点击允许·重连中] " + baseTitle;
              try {
                btn.click();
              } catch {
                try {
                  btn.dispatchEvent(new MouseEvent("click", { bubbles: !0, cancelable: !0 }));
                } catch {
                }
              }
              return;
            }
            document.title = "[等待授权页加载·找允许] " + baseTitle;
          } catch (err) {
            try {
              flowWriteMerge(rec.ts, { lastError: "授权轮询异常: " + String(err && err.message || err) });
            } catch {
            }
          }
        }, 400);
      } catch (err) {
        try {
          let f = reconnectBridge.readFlow();
          f && f.ts && flowWriteMerge(f.ts, { phase: "FAILED_RETRYABLE", lastError: "授权流程异常: " + String(err && err.message || err), deadline: Date.now() });
        } catch {
        }
      }
    }
    function findLinuxDoLoginButton() {
      let denyRe = /离开|退出|exit|sign\s*out|log\s*out|logout|disconnect|不登录|取消/;
      try {
        let btn = document.getElementById("joinBtn");
        if (btn && isVisibleEnabledAction(btn)) return btn;
      } catch {
      }
      try {
        let links = Array.from(document.querySelectorAll("a[href]"));
        for (let a of links) {
          if (!isVisibleEnabledAction(a)) continue;
          let href = a.getAttribute("href") || "";
          if (!isExpectedOAuthUrl(href)) continue;
          let text = (a.innerText || a.textContent || "").trim().toLowerCase();
          if (!denyRe.test(text))
            return a;
        }
      } catch {
      }
      return null;
    }
    function gameReconnectWatcher() {
      let watcherHost = typeof unsafeWindow < "u" ? unsafeWindow : window, watcherKey = "__crgrGameReconnectWatcher";
      try {
        if (watcherHost[watcherKey]) return;
        watcherHost[watcherKey] = !0;
      } catch {
      }
      let baseTitle = document.title || "", POLL_MS = 1e3, jumped = !1, loginVisibleSince = 0, observedTs = "", hookedLoginButton = null, poll = 0, manualLoginListener = null, release = () => {
        if (poll && clearInterval(poll), poll = 0, manualLoginListener) {
          try {
            document.removeEventListener("click", manualLoginListener, !0);
          } catch {
          }
          manualLoginListener = null;
        }
        try {
          watcherHost[watcherKey] = !1;
        } catch {
        }
      }, cancelForManualLogin = () => {
        reconnectBridge.clearLeave(), reconnectBridge.clearAck(), reconnectBridge.clearFlow(), jumped = !0, document.title = "[手动登录·自动重连已取消] " + baseTitle, release();
      }, hookManualLogin = (button) => {
        if (!(!button || button === hookedLoginButton)) {
          hookedLoginButton = button;
          try {
            button.addEventListener("click", (event) => {
              event && event.isTrusted === !0 && cancelForManualLogin();
            }, !0);
          } catch {
          }
        }
      };
      manualLoginListener = (event) => {
        if (!event || event.isTrusted !== !0) return;
        let button = findLinuxDoLoginButton(), target = event.target;
        !button || target !== button && !(button.contains && button.contains(target)) || cancelForManualLogin();
      };
      try {
        document.addEventListener("click", manualLoginListener, !0);
      } catch {
      }
      poll = window.setInterval(() => {
        try {
          if (jumped) {
            release();
            return;
          }
          if (!reconnectBridge.readSwitch()) return;
          let rec = reconnectBridge.readLeave();
          if (!rec || !rec.ts || !RECONNECT_AUTO_TYPES.has(rec.type) || rec.enabled === !1)
            return;
          if (!reconnectBridge.isRecordActive(rec)) {
            reconnectBridge.clearLeave(), reconnectBridge.clearAck(), reconnectBridge.clearFlow();
            return;
          }
          let flow = reconnectBridge.readFlow();
          if (!flow || String(flow.ts) !== String(rec.ts)) return;
          let ack = reconnectBridge.readAck();
          if (ack && String(ack) === String(rec.ts)) return;
          if (flow.phase !== "leave") {
            if (RECONNECT_TERMINAL.has(flow.phase)) {
              release();
              return;
            }
            if (flow.phase === "game-login") {
              if (Date.now() - (Number(flow.lastTransitionAt) || Number(flow.at) || 0) > 15e3) {
                let attempt = (Number(flow.attempt) || 0) + 1;
                if (attempt <= 2) {
                  flowWriteMerge(rec.ts, { phase: "leave", attempt, deadline: 0, lastError: "登录导航回退重试" }), document.title = "[登录导航回退·重试] " + baseTitle;
                  return;
                }
                flowWriteMerge(rec.ts, {
                  phase: "FAILED_MANUAL",
                  deadline: Date.now(),
                  attempt,
                  lastError: "登录导航失败超过重试上限,请手动登录"
                }), release(), document.title = "[登录导航失败·请手动登录] " + baseTitle;
                return;
              }
              return;
            }
            release();
            return;
          }
          observedTs !== String(rec.ts) && (observedTs = String(rec.ts), loginVisibleSince = 0);
          let loginBtn = findLinuxDoLoginButton();
          if (!loginBtn) {
            loginVisibleSince = 0;
            return;
          }
          hookManualLogin(loginBtn);
          let cd = reconnectBridge.cooldownMs(rec.type);
          if (cd < 0) return;
          let dueAt = rec.ts + cd, now = Date.now();
          if (now < dueAt) {
            let rem = dueAt - now, mm = String(Math.floor(rem / 6e4)).padStart(2, "0"), ss = String(Math.floor(rem % 6e4 / 1e3)).padStart(2, "0");
            document.title = "[待重连·还需 " + mm + ":" + ss + "] " + baseTitle, loginVisibleSince = 0;
            return;
          }
          if (loginVisibleSince || (loginVisibleSince = now), now - loginVisibleSince < 2500) {
            document.title = "[确认登出态·暂不登录] " + baseTitle;
            return;
          }
          try {
            let prev = reconnectBridge.readFlow();
            if (!prev || prev.phase !== "leave" || RECONNECT_TERMINAL.has(prev.phase)) {
              jumped = !0, release();
              return;
            }
            let navId = reconnectId();
            if (!flowWriteMerge(rec.ts, {
              phase: "game-login",
              deadline: Date.now() + 15e3,
              ownerId: navId,
              leaseUntil: Date.now() + 15e3
            })) {
              jumped = !0, release();
              return;
            }
            if (jumped = !0, document.title = "[冷却到期·跳授权页] " + baseTitle, release(), loginBtn.id === "joinBtn" && !loginBtn.getAttribute("href"))
              try {
                loginBtn.click();
              } catch {
                try {
                  loginBtn.dispatchEvent(new MouseEvent("click", { bubbles: !0, cancelable: !0 }));
                } catch {
                }
              }
            else {
              let href = loginBtn.getAttribute && loginBtn.getAttribute("href");
              href && isExpectedOAuthUrl(href) && !/^javascript:/i.test(href) ? location.href = href : (flowWriteMerge(rec.ts, { phase: "FAILED_MANUAL", lastError: "登录链接不是预期 OAuth 地址,已 fail closed", deadline: Date.now() }), document.title = "[登录入口未知·请手动登录] " + baseTitle);
            }
          } catch (err) {
            try {
              flowWriteMerge(rec.ts, { phase: "FAILED_RETRYABLE", lastError: "登录导航异常: " + String(err && err.message || err), deadline: Date.now() });
            } catch {
            }
            release();
          }
        } catch {
        }
      }, POLL_MS);
    }
    if (location.hostname === "connect.linux.do" || location.hostname.endsWith(".connect.linux.do")) {
      try {
        oauthReconnectMain();
      } catch {
      }
      return;
    }
    if (location.hostname !== "grasp-rat-game.h-e.top") return;
    try {
      gameReconnectWatcher();
    } catch {
    }
    let code = `(${pageMain.toString()})();`;
    try {
      if (typeof unsafeWindow < "u" && unsafeWindow.eval) {
        unsafeWindow.eval(code);
        return;
      }
    } catch {
    }
    let script = document.createElement("script");
    script.textContent = code, (document.documentElement || document.head || document.body).appendChild(script), script.remove();
    function pageMain() {
      "use strict";
      let BUILD_PROFILE = "raider", IS_RAIDER_PROFILE = BUILD_PROFILE === "raider", PROFILE_TAG = IS_RAIDER_PROFILE ? "RAT RAIDER" : "RAT SCAVENGER", RUNNER_KEY = "__codexRatGoldRunner", PANEL_ID = "codex-rat-gold-runner-panel", RICH_ENEMY_MIN_DROP = 10, RICH_ENEMY_SCAN_CM = 25e3, RICH_ENEMY_KEEP_CM = 22e3, RICH_ENEMY_ESCAPE_CM = 17e3, FLEE_ANCHOR_HOLD_MS = 1500, FLEE_ANCHOR_MAX_MS = 3500, FLEE_ANCHOR_SAFE_RADIUS_CM = 19e3, COIN_REACHED_CM = 160, ENEMY_LINE_SCAN_CM = 5e4, ENEMY_LINE_MIN_DROP = 1, COMBAT_SCAN_CM = 17e3, COMBAT_LOW_HP = 9, COMBAT_FAST_CHECK_HP = 22, COMBAT_CRITICAL_HP = 25, COMBAT_DODGE_SCAN_CM = 36e3, COMBAT_DODGE_SPEED_CMPS = 1300, COMBAT_DODGE_SWITCH_MS = 650, COMBAT_SPACING_SCAN_CM = 19e3, COMBAT_RANGE_HARD_MIN_CM = 8500, COMBAT_RANGE_MIN_CM = 1e4, COMBAT_RANGE_IDEAL_CM = 12500, COMBAT_RANGE_MAX_CM = 15e3, COMBAT_CLOSE_PROJECTILE_PRESSURE = 520, CRUISE_DODGE_PRESSURE = 380, CRUISE_DODGE_NEAR_CM = 12e3, CRUISE_DODGE_HOLD_MS = 450, AUTO_FIRE_RANGE_CM = 15e3, AUTO_FIRE_DEFAULT_PROJECTILE_SPEED_CMPS = 1e4, AUTO_FIRE_MAX_RATE_MS = 100, AUTO_FIRE_LOOP_MS = 100, AUTO_FIRE_STAMINA_COST_MILLI = 500, AUTO_FIRE_STAMINA_MAX_MILLI = 1e4, AUTO_FIRE_RESERVE_SHOTS = 2, AUTO_FIRE_LEAD_MIN_MS = 60, AUTO_FIRE_LEAD_MAX_MS = 1150, AUTO_FIRE_BURST_MIN_SHOTS = 5, AUTO_FIRE_BURST_MAX_SHOTS = 8, AUTO_FIRE_BURST_SHOT_MS = AUTO_FIRE_MAX_RATE_MS, PROJECTILE_MEMORY_MS = 1800, MOVING_ENEMY_MEMORY_MS = 1e4, ENEMY_MOVE_EPSILON_CM = 30, LINE_CANVAS_MAX_DPR = 1.75, DROP_CLUSTER_CM = 9e3, ROUTE_CLUSTER_CM = 13e3, ROUTE_LINK_CM = 15e3, ROUTE_MAX_LINK_CM = 22e3, ROUTE_ANCHOR_LIMIT = 22, ROUTE_POOL_LIMIT = 72, ROUTE_MAX_POINTS_DENSE = 6, ROUTE_MAX_POINTS_MID = 4, ROUTE_MAX_POINTS_SPARSE = 2, ROUTE_SWITCH_FACTOR = 1.14, REPLAN_MS = 1800, ROUTE_LENGTH_PENALTY_START_CM = 3e4, ROUTE_LENGTH_PENALTY_PER_CM = 18e-6, ROUTE_LENGTH_PENALTY_FLOOR = 0.5, ROUTE_NEAR_PREFER_CM = 12e3, ROUTE_FAR_SOFT_CM = 35e3, ROUTE_FAR_FACTOR_FLOOR = 0.28, DROP_LEADERBOARD_REFRESH_MS = 1e4, DROP_LEADERBOARD_ENTRY_REFRESH_DELAY_MS = 3e3, STEP_TICK_MS = 150, COMBAT_FAST_TICK_MS = 50, AXIS_DOMINANCE_RATIO = 1.65, TRAVEL_TICK_DIAGONAL_DIV = 35, TRAVEL_TICK_AXIS_DIV = 42, HUNT_REACHED_CM = 260, HUNT_LOST_MEMORY_MS = 12e3, HUNT_PREDICT_MIN_MS = 350, HUNT_PREDICT_MAX_MS = 1300, HUNT_PREDICT_DISTANCE_DIVISOR = 9e3, RAID_REPLAN_MS = 1800, RAID_LOOT_WAIT_MS = 1200, RAID_LOOT_HOLD_MS = 6e3, RAID_LOOT_RADIUS_CM = 2800, WATCHDOG_STALL_MS = 4500, WATCHDOG_STALE_MS = 12e3, WATCHDOG_FALLBACK_RELOAD_MS = 6e3, DANGER_ID = "codex-rat-danger-vignette", MANUAL_TARGET_REACHED_CM = 160, MOVE_KEYS = ["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"];
      function idKey(value) {
        return value == null ? "" : String(value);
      }
      function numberFrom(obj, keys, fallback) {
        for (let key of keys) {
          let value = Number(obj && obj[key]);
          if (Number.isFinite(value)) return value;
        }
        return fallback;
      }
      function finiteStaminaMs(raw) {
        if (raw == null || typeof raw == "string" && raw.trim() === "") return null;
        let value = Number(raw);
        return Number.isFinite(value) && value >= 0 ? value : null;
      }
      function dropAmount(drop) {
        return Math.max(1, Number(drop && drop.amount || 1));
      }
      function readDropAmount(drop) {
        let value = Number(drop && drop.amount);
        return Number.isFinite(value) && value > 0 ? value : null;
      }
      function minDistanceToEntities(x, y, entities) {
        let min = 1 / 0;
        for (let entity of entities || []) {
          let d = Math.hypot(Number(entity && entity.x) - x, Number(entity && entity.y) - y);
          d < min && (min = d);
        }
        return min;
      }
      function pointToSegmentDistance(px, py, ax, ay, bx, by) {
        let vx = bx - ax, vy = by - ay;
        if (!Number.isFinite(vx) || !Number.isFinite(vy)) return 1 / 0;
        let len2 = vx * vx + vy * vy;
        if (len2 <= 1e-9) return Math.hypot(px - ax, py - ay);
        let t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2));
        return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
      }
      function minSegmentThreatDistance(ax, ay, bx, by, threats) {
        let min = 1 / 0;
        for (let t of threats || []) {
          let d = pointToSegmentDistance(Number(t.x), Number(t.y), ax, ay, bx, by);
          d < min && (min = d);
        }
        return min;
      }
      function travelTicks(fromX, fromY, toX, toY) {
        let ax = Math.abs(Number(toX) - Number(fromX)), ay = Math.abs(Number(toY) - Number(fromY));
        if (!Number.isFinite(ax) || !Number.isFinite(ay)) return 1 / 0;
        let diagonal = Math.min(ax, ay), axis = Math.max(ax, ay) - diagonal;
        return diagonal / TRAVEL_TICK_DIAGONAL_DIV + axis / TRAVEL_TICK_AXIS_DIV;
      }
      function travelSeconds(fromX, fromY, toX, toY) {
        return Math.max(0.2, travelTicks(fromX, fromY, toX, toY) * 0.05);
      }
      function steerVector(rx, ry) {
        let ax = Math.abs(rx), ay = Math.abs(ry);
        return ax < 35 && ay < 35 ? { dx: 0, dy: 0, mode: "stop" } : ay < 35 || ax / Math.max(1, ay) >= AXIS_DOMINANCE_RATIO ? { dx: Math.sign(rx), dy: 0, mode: "x-axis" } : ax < 35 || ay / Math.max(1, ax) >= AXIS_DOMINANCE_RATIO ? { dx: 0, dy: Math.sign(ry), mode: "y-axis" } : { dx: Math.sign(rx), dy: Math.sign(ry), mode: "diagonal" };
      }
      function formatClock(ms) {
        let date = new Date(Number.isFinite(Number(ms)) ? Number(ms) : Date.now()), pad = (value) => String(value).padStart(2, "0");
        return pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
      }
      function randomEntities(count, maxCoord = 5e5, seed = 1) {
        let out = [], s = seed >>> 0, rnd = () => (s = s * 1664525 + 1013904223 >>> 0, s / 4294967296);
        for (let i = 0; i < count; i += 1)
          out.push({ x: rnd() * maxCoord, y: rnd() * maxCoord });
        return out;
      }
      class SpatialGrid {
        constructor(cellSize = 9e3) {
          this.cellSize = cellSize, this.map = /* @__PURE__ */ new Map();
        }
        _key(x, y) {
          return Math.floor(x / this.cellSize) + "," + Math.floor(y / this.cellSize);
        }
        clear() {
          return this.map.clear(), this;
        }
        insert(entity) {
          let k = this._key(Number(entity.x), Number(entity.y)), arr = this.map.get(k);
          return arr || (arr = [], this.map.set(k, arr)), arr.push(entity), this;
        }
        build(entities) {
          this.clear();
          for (let e of entities || []) this.insert(e);
          return this;
        }
        /** 返回圆心 (x,y)、半径 r 覆盖的所有格内的实体(未做圆内精筛)。 */
        cellsRadius(x, y, r) {
          let cs = this.cellSize, minX = Math.floor((x - r) / cs), maxX = Math.floor((x + r) / cs), minY = Math.floor((y - r) / cs), maxY = Math.floor((y + r) / cs), out = [];
          for (let cx = minX; cx <= maxX; cx += 1)
            for (let cy = minY; cy <= maxY; cy += 1) {
              let arr = this.map.get(cx + "," + cy);
              arr && arr.length && out.push(...arr);
            }
          return out;
        }
        /** 半径 r 圆内实体(含精筛)。 */
        queryRadius(x, y, r) {
          let r2 = r * r, out = [];
          for (let e of this.cellsRadius(x, y, r)) {
            let dx = Number(e.x) - x, dy = Number(e.y) - y;
            dx * dx + dy * dy <= r2 && out.push(e);
          }
          return out;
        }
        /** 半径 r 内最近实体;无则 null。 */
        nearestWithin(x, y, r) {
          let best = null, bestD = 1 / 0;
          for (let e of this.cellsRadius(x, y, r)) {
            let d = Math.hypot(Number(e.x) - x, Number(e.y) - y);
            d <= r && d < bestD && (bestD = d, best = e);
          }
          return best ? { entity: best, dist: bestD } : null;
        }
      }
      function routeFirstLegPreferFactor(firstLegCm) {
        let dist = Number(firstLegCm) || 0;
        if (dist <= ROUTE_NEAR_PREFER_CM) return 1;
        if (dist >= ROUTE_FAR_SOFT_CM) return ROUTE_FAR_FACTOR_FLOOR;
        let t = (dist - ROUTE_NEAR_PREFER_CM) / (ROUTE_FAR_SOFT_CM - ROUTE_NEAR_PREFER_CM);
        return 1 - (1 - ROUTE_FAR_FACTOR_FLOOR) * t;
      }
      function routeLegSafetyFactor(fromX, fromY, toX, toY, threats) {
        let safety = minSegmentThreatDistance(fromX, fromY, toX, toY, threats);
        return safety < RICH_ENEMY_KEEP_CM ? 0 : safety >= RICH_ENEMY_SCAN_CM ? 1 : 0.55 + 0.45 * ((safety - RICH_ENEMY_KEEP_CM) / (RICH_ENEMY_SCAN_CM - RICH_ENEMY_KEEP_CM));
      }
      function routeTurnFactor(prevDx, prevDy, nextDx, nextDy) {
        let prevLen = Math.hypot(prevDx, prevDy), nextLen = Math.hypot(nextDx, nextDy);
        if (prevLen < 1 || nextLen < 1) return 1;
        let cos = (prevDx * nextDx + prevDy * nextDy) / (prevLen * nextLen);
        return cos < -0.45 ? 0.58 : cos < -0.12 ? 0.76 : cos > 0.72 ? 1.08 : 1;
      }
      function buildRouteGrids(candidates, threats, clusterRadius) {
        let coinGrid = new SpatialGrid(clusterRadius || 9e3).build(candidates || []), threatGrid = new SpatialGrid(13e3).build(threats || []);
        return { coinGrid, threatGrid, clusterRadius: clusterRadius || 9e3 };
      }
      function dropClusterValueGrid(grid, drop, candidatesIndex, radius, weight) {
        let scanRadius = radius || grid.clusterRadius, valueWeight = weight ?? 0.65, x = Number(drop.x), y = Number(drop.y), selfId = idKey(drop.drop_id), sum = 0;
        for (let other of grid.coinGrid.queryRadius(x, y, scanRadius)) {
          if (idKey(other.drop_id) === selfId) continue;
          let dist = Math.hypot(Number(other.x) - x, Number(other.y) - y);
          dist > scanRadius || (sum += dropAmount(other) * (1 - dist / scanRadius) * valueWeight);
        }
        return sum;
      }
      function routeClusterStatsGrid(grid, drop, radius) {
        let scanRadius = radius || grid.clusterRadius, x = Number(drop.x), y = Number(drop.y), selfId = idKey(drop.drop_id), count = 0, amount = 0, weighted = 0;
        for (let other of grid.coinGrid.queryRadius(x, y, scanRadius)) {
          if (idKey(other.drop_id) === selfId) continue;
          let dist = Math.hypot(Number(other.x) - x, Number(other.y) - y);
          if (dist > scanRadius) continue;
          let value = dropAmount(other);
          count += 1, amount += value, weighted += value * (1 - dist / scanRadius);
        }
        return { count, amount, weighted };
      }
      function nearestThreatDistGrid(grid, x, y, radius) {
        let r = radius ?? 25e3, min = 1 / 0;
        for (let t of grid.threatGrid.queryRadius(x, y, r)) {
          let d = Math.hypot(Number(t.x) - x, Number(t.y) - y);
          d < min && (min = d);
        }
        return min;
      }
      function dropClusterValueBrute(drop, candidates, radius, weight) {
        let scanRadius = radius || 9e3, valueWeight = weight ?? 0.65, selfId = idKey(drop.drop_id), sum = 0;
        for (let other of candidates || []) {
          if (idKey(other.drop_id) === selfId) continue;
          let dist = Math.hypot(Number(other.x) - Number(drop.x), Number(other.y) - Number(drop.y));
          dist > scanRadius || (sum += dropAmount(other) * (1 - dist / scanRadius) * valueWeight);
        }
        return sum;
      }
      function nearestThreatDistBrute(x, y, threats, radius) {
        let r = radius ?? 25e3, min = 1 / 0;
        for (let t of threats || []) {
          let d = Math.hypot(Number(t.x) - x, Number(t.y) - y);
          d <= r && d < min && (min = d);
        }
        return min;
      }
      function makeRoutePlan(route, snapshotVersion, me) {
        let coinIds = (route && route.drops ? route.drops : []).map((d) => idKey(d.drop_id));
        return {
          id: "route:" + (snapshotVersion || 0) + ":" + (coinIds[0] || "none"),
          coinIds,
          score: route ? route.score : 0,
          value: route ? route.value : 0,
          travelSeconds: route ? route.travelSeconds : 0,
          minSafetyCm: route && route.minSafetyFactor != null ? route.minSafetyFactor * 25e3 : 25e3,
          createdAt: me && me.__now || Date.now(),
          snapshotVersion: snapshotVersion || 0
        };
      }
      function createArrivalController(opts) {
        let now = opts && opts.now || (() => Date.now()), confirmMs = opts && opts.confirmMs || 600, maxNudges = opts && opts.maxNudges || 2, blacklistMs = opts && opts.blacklistMs || 8e3, arrivalId = null, arrivedAt = 0, nudges = 0;
        return {
          // 每拍调用:areWeAtCoin = 当前是否已贴近某枚金币;coinId = 该金币 id。
          // 返回 { action: "wait"|"nudge"|"skip"|"move", coinId, nudgeIndex }
          tick(areWeAtCoin, coinId) {
            let t = now();
            if (!areWeAtCoin)
              return arrivalId = null, arrivedAt = 0, nudges = 0, { action: null };
            let id = String(coinId);
            return arrivalId !== id && (arrivalId = id, arrivedAt = t, nudges = 0), t - arrivedAt < confirmMs ? { action: "wait", coinId: id } : nudges < maxNudges ? (nudges += 1, arrivedAt = t, { action: "nudge", coinId: id, nudgeIndex: nudges }) : (arrivalId = null, arrivedAt = 0, nudges = 0, { action: "skip", coinId: id, blacklistMs });
          },
          reset() {
            arrivalId = null, arrivedAt = 0, nudges = 0;
          },
          get state() {
            return { arrivalId, arrivedAt, nudges };
          }
        };
      }
      function isRichEnemy(enemy, minDrop) {
        return !!enemy && enemy.dropForAvoid > (minDrop ?? 10);
      }
      function isEscapeThreat(enemy, minDrop, movedRecently) {
        if (!enemy) return !1;
        let drop = enemy.dropForAvoid;
        return drop > (minDrop ?? 10) ? !0 : drop <= (minDrop ?? 10) && !!(movedRecently ?? enemy.movedRecently);
      }
      function pursuitStatus(enemy, enemyMotion, now) {
        let key = enemy && enemy.key, motion = key && enemyMotion ? enemyMotion.get(key) : null;
        if (!motion) return { pursuing: !1, durationMs: 0 };
        let firstSeenAt = motion.firstSeenAt || motion.lastSeenAt || 0;
        return {
          pursuing: now - motion.lastSeenAt <= 1e4,
          // 最近 10s 内仍见(与 MOVING_ENEMY_MEMORY 一致)
          durationMs: Math.max(0, now - firstSeenAt)
        };
      }
      function sortByThreat(enemies) {
        return (enemies || []).filter(Boolean).sort((a, b) => Number(b.dropForAvoid || 0) - Number(a.dropForAvoid || 0) || Number(a.dist) - Number(b.dist));
      }
      function nextFleeStage(evade, now, sameEnemy, arrivedAtAnchor, staleAnchor, anchorAvailable, excludeId, holdMs, maxMs) {
        let hold = holdMs ?? 1500, max = maxMs ?? 3500;
        if (!sameEnemy || !evade || evade.startedAt == null)
          return { stage: FLEE_STAGE_REVERSE, drop_id: null, x: null, y: null, anchorAt: 0 };
        if (evade.x != null) {
          if (arrivedAtAnchor || staleAnchor) {
            let anchor = anchorAvailable ? { x: anchorAvailable.x, y: anchorAvailable.y, drop_id: anchorAvailable.drop_id } : null;
            return anchor ? { stage: FLEE_STAGE_ANCHOR, ...anchor, anchorAt: now } : { stage: FLEE_STAGE_REVERSE, drop_id: null, x: null, y: null, anchorAt: 0 };
          }
          return { stage: FLEE_STAGE_ANCHOR, x: evade.x, y: evade.y, drop_id: evade.drop_id, anchorAt: evade.anchorAt };
        }
        return now - evade.startedAt >= hold && anchorAvailable ? { stage: FLEE_STAGE_ANCHOR, x: anchorAvailable.x, y: anchorAvailable.y, drop_id: anchorAvailable.drop_id, anchorAt: now } : { stage: FLEE_STAGE_REVERSE, drop_id: null, x: null, y: null, anchorAt: 0 };
      }
      function fleeEpisode(fleeing, fleeKey, newKey) {
        let key = String(newKey || "");
        return !fleeing || fleeKey && fleeKey !== key ? { countIncrement: 1, fleeing: !0, fleeKey: key } : { countIncrement: 0, fleeing: !0, fleeKey: fleeKey || key };
      }
      let FLEE_STAGE_REVERSE = "reverse", FLEE_STAGE_ANCHOR = "anchor";
      function classifyLeave(reason, hp, noReconnect, criticalHp) {
        if (noReconnect) return LEAVE_TYPE.OTHER;
        if (String(reason || "") === "manual") return LEAVE_TYPE.MANUAL;
        if (/1h体力限制/.test(String(reason || ""))) return LEAVE_TYPE.STAMINA;
        let h = Number(hp);
        return Number.isFinite(h) && h <= (criticalHp ?? 25) ? LEAVE_TYPE.LOWHP : LEAVE_TYPE.DAMAGE;
      }
      function shouldAutoReconnect(type, autoReconnectOn, noReconnect) {
        return noReconnect || !autoReconnectOn ? !1 : type === LEAVE_TYPE.DAMAGE || type === LEAVE_TYPE.LOWHP || type === LEAVE_TYPE.STAMINA;
      }
      function shouldLeaveOnHpDrop(prevHp, hp, combatMode, alreadyTriggered) {
        if (combatMode || alreadyTriggered) return !1;
        let prev = Number(prevHp), cur = Number(hp);
        return !Number.isFinite(prev) || !Number.isFinite(cur) ? !1 : cur < prev;
      }
      let LEAVE_TYPE = {
        MANUAL: "manual",
        STAMINA: "stamina",
        LOWHP: "lowhp",
        DAMAGE: "damage",
        OTHER: "other"
      };
      function interceptLeadSeconds(me, target, velocity, projectileSpeed, leadMinMs, leadMaxMs) {
        let rx = Number(target.x) - Number(me.x), ry = Number(target.y) - Number(me.y), vx = Number(velocity.vx) || 0, vy = Number(velocity.vy) || 0, speed = Math.max(1, Number(projectileSpeed) || 1e4), min = (leadMinMs ?? 60) / 1e3, max = (leadMaxMs ?? 1150) / 1e3, a = vx * vx + vy * vy - speed * speed, b = 2 * (rx * vx + ry * vy), c = rx * rx + ry * ry, lead = Math.sqrt(c) / speed;
        if (Math.abs(a) > 1e-3) {
          let disc = b * b - 4 * a * c;
          if (disc >= 0) {
            let root = Math.sqrt(disc), t1 = (-b - root) / (2 * a), t2 = (-b + root) / (2 * a), positive = [t1, t2].filter((value) => Number.isFinite(value) && value > 0).sort((x, y) => x - y)[0];
            Number.isFinite(positive) && (lead = positive);
          }
        } else if (Math.abs(b) > 1e-3) {
          let linear = -c / b;
          Number.isFinite(linear) && linear > 0 && (lead = linear);
        }
        return Math.min(max, Math.max(min, lead));
      }
      function predictedPoint(target, velocity, leadSeconds) {
        return {
          x: Number(target.x) + (Number(velocity.vx) || 0) * leadSeconds,
          y: Number(target.y) + (Number(velocity.vy) || 0) * leadSeconds,
          leadSeconds
        };
      }
      function velocityFromHistory(prev, cur, dtMs) {
        if (!prev || !cur) return { vx: 0, vy: 0 };
        let dt = Math.max(0.05, (dtMs ?? 0) / 1e3), vx = (Number(cur.x) - Number(prev.x)) / dt, vy = (Number(cur.y) - Number(prev.y)) / dt;
        return { vx: Number.isFinite(vx) ? vx : 0, vy: Number.isFinite(vy) ? vy : 0 };
      }
      function planBurstShots(staminaMs, minShots, maxShots, costPerShotMs, reserveShots) {
        let min = minShots ?? 5, max = maxShots ?? 8, cost = costPerShotMs ?? 500, reserve = reserveShots ?? 2, s = Number(staminaMs);
        if (!Number.isFinite(s) || s < 0) return { shots: 0, reason: "stamina-unknown" };
        let affordable = Math.max(0, Math.floor(s / cost) - reserve);
        if (affordable < min) return { shots: 0, reason: "insufficient" };
        let base = min + Math.floor(Math.random() * (max - min + 1));
        return { shots: Math.min(base, affordable), reason: "ok" };
      }
      function planCoverageOffsets(me, target, velocity, count, random) {
        let rnd = random || Math.random, targetSpeed = Math.hypot(Number(velocity.vx) || 0, Number(velocity.vy) || 0), rx = Number(target.x) - Number(me.x), ry = Number(target.y) - Number(me.y), dist = Math.max(1, Math.hypot(rx, ry)), moveBasis = targetSpeed > 80 ? { x: (Number(velocity.vx) || 0) / targetSpeed, y: (Number(velocity.vy) || 0) / targetSpeed } : { x: rx / dist, y: ry / dist }, perp = { x: -moveBasis.y, y: moveBasis.x }, along = moveBasis, spread = Math.min(980, Math.max(220, dist * 0.038 + targetSpeed * 0.075)), pattern = [0, -0.85, 0.85, -0.42, 0.42, -1.22, 1.22, 0.18], mid = (count - 1) / 2, offsets = [];
        for (let i = 0; i < count; i += 1) {
          let lateral = (pattern[i] != null ? pattern[i] : rnd() * 2.3 - 1.15) * spread, forward = (i - mid) * spread * 0.18 + (rnd() * 0.24 - 0.12) * spread;
          offsets.push({
            x: perp.x * lateral + along.x * forward,
            y: perp.y * lateral + along.y * forward
          });
        }
        return offsets;
      }
      function selectAutoTarget(enemies, lockedEnemy) {
        if (lockedEnemy && lockedEnemy.life === "Alive")
          return { target: lockedEnemy, locked: !0 };
        let candidates = (enemies || []).filter((e) => e && e.life === "Alive" && Number.isFinite(e.hpForFire) && e.hpForFire > 0);
        return candidates.length ? { target: candidates.sort(
          (a, b) => a.hpForFire - b.hpForFire || a.dist - b.dist || String(a.user_id).localeCompare(String(b.user_id))
        )[0], locked: !1 } : null;
      }
      function validateFireTarget(enemy) {
        if (!enemy) return { ok: !1, reason: "no-target" };
        if (enemy.life !== "Alive") return { ok: !1, reason: "not-alive" };
        let hp = Number(enemy.hpForFire);
        return !Number.isFinite(hp) || hp <= 0 ? { ok: !1, reason: "no-hp" } : { ok: !0, reason: "ok" };
      }
      function lockFireRange(lockedEnemy, fireRangeCm) {
        return lockedEnemy ? {
          inRange: Number.isFinite(Number(lockedEnemy.dist)) && Number(lockedEnemy.dist) <= fireRangeCm,
          locked: !0
        } : { inRange: !1, locked: !1 };
      }
      function createFireController(opts) {
        let setTimeoutFn = opts && opts.setTimeout || ((fn, ms) => setTimeout(fn, ms)), clearTimeoutFn = opts && opts.clearTimeout || ((id) => clearTimeout(id)), getMe = opts && opts.getMe || (() => null), dispatch = opts && opts.dispatch || (() => {
        }), validateShot = opts && opts.validateShot || (() => ({ ok: !0, reason: "ok" })), shotMs = opts && opts.shotMs || 100, randomDelay = opts && opts.randomDelay || (() => 0), token = 0, timers = [], active = !1, stats = { planned: 0, dispatched: 0, confirmed: null };
        function clearAll(release) {
          for (let id of timers) clearTimeoutFn(id);
          if (timers = [], release && active) {
            let client = stats.lastClient;
            client && (dispatch(client, "mouseup", 0), dispatch(client, "click", 0));
          }
          active = !1;
        }
        return {
          // 启动一组连发。shots 已由 burst-planner 预算好。
          // begin(x, y) 派发首发 mousedown;每发前回调 beforeShot(shotIndex) 做校验。
          startBurst(shots, begin, beforeShot) {
            let gen = ++token;
            clearAll(!1), active = !0, stats = { planned: shots, dispatched: 0, confirmed: null };
            let v0 = validateShot();
            if (!v0.ok)
              return active = !1, { ok: !1, reason: v0.reason };
            let first = begin(0);
            if (!first)
              return active = !1, { ok: !1, reason: "no-client" };
            stats.lastClient = first, stats.dispatched += 1, dispatch(first, "mousemove", 0), dispatch(first, "mousedown", 1);
            for (let i = 1; i < shots; i += 1) {
              let id = setTimeoutFn(() => {
                if (token !== gen || !active) return;
                let v = validateShot();
                if (!v.ok)
                  return clearAll(!0), { ok: !1, reason: v.reason, aborted: !0 };
                let me = getMe(), client = beforeShot ? beforeShot(i, me) : null;
                client && (stats.lastClient = client, stats.dispatched += 1, dispatch(client, "mousemove", 1));
              }, i * shotMs);
              timers.push(id);
            }
            let holdMs = shots * shotMs + randomDelay(), releaseId = setTimeoutFn(() => {
              if (token !== gen || !active) return;
              let releaseClient = stats.lastClient;
              dispatch(releaseClient, "mouseup", 0), dispatch(releaseClient, "click", 0), active = !1, stats.confirmed = null;
            }, holdMs);
            return timers.push(releaseId), { ok: !0, reason: "ok" };
          },
          // 取消当前连发。release=true 时补发 mouseup/click 让游戏按键复位。
          cancel(release) {
            return token += 1, clearAll(!!release), this;
          },
          get active() {
            return active;
          },
          get stats() {
            return { ...stats };
          }
        };
      }
      function contractPresent2(value, expectation) {
        return typeof value > "u" || value === null || value === !1 ? !1 : expectation === "function" ? typeof value == "function" : expectation === "array" ? Array.isArray(value) : expectation === "Set-like" ? value && (value instanceof Set || typeof value.add == "function" || typeof value.has == "function" || typeof value.delete == "function") : expectation === "HTMLElement" ? typeof value == "object" && typeof value.getContext == "function" : expectation === "present" ? !0 : expectation === "object" ? typeof value == "object" && !Array.isArray(value) : !0;
      }
      function classifyGameContract2(report) {
        let out = { status: "READY", missing: [], criticalMissing: [], report: {} };
        for (let [key, expect] of GAME_CONTRACT_REQUIRED) {
          let value = report ? report[key] : void 0, ok = contractPresent2(value, expect);
          out.report[key] = ok ? expect : "missing", ok || out.missing.push(key);
        }
        for (let [key, expect] of GAME_CONTRACT_OPTIONAL_CRITICAL) {
          let value = report ? report[key] : void 0, ok = contractPresent2(value, expect);
          out.report[key] = ok ? expect : "missing", ok || out.criticalMissing.push(key);
        }
        return out.missing.length ? out.status = "INCOMPATIBLE" : out.criticalMissing.length ? out.status = "DEGRADED" : out.status = "READY", out;
      }
      function buildContractReport(game) {
        let s = game && game.state, d = game && game.els;
        return {
          state: s,
          "state.entities": s && s.entities,
          "state.coinDrops": s && s.coinDrops,
          "state.keys": s && s.keys,
          "state.currentUserId": s && s.currentUserId,
          "state.minimap": s && s.minimap ? s.minimap.points : void 0,
          "state.pointerWorld": s && s.pointerWorld,
          sendVelocity: game && game.sendVelocity,
          canvas: d && d.canvas || game.canvas,
          screenCenter: d && d.screenCenter || game.screenCenter,
          setPointerFromClient: d && d.setPointerFromClient || game.setPointerFromClient
        };
      }
      function normalizePlayer(raw) {
        if (!raw || typeof raw != "object") return null;
        let x = numberFrom(raw, ["x", "pos_x", "world_x", "cx"], null), y = numberFrom(raw, ["y", "pos_y", "world_y", "cy"], null);
        return {
          id: String(raw.user_id ?? raw.userId ?? raw.uid ?? ""),
          x,
          y,
          hp: numberFrom(raw, ["hp", "health", "life_value", "current_hp"], null),
          life: raw.life ?? null,
          name: (raw.name ?? raw.userName ?? raw.username) != null ? String(raw.name ?? raw.userName ?? raw.username) : null,
          vx: numberFrom(raw, ["vx", "vel_x", "velocity_x", "speed_x"], 0),
          vy: numberFrom(raw, ["vy", "vel_y", "velocity_y", "speed_y"], 0),
          drop: numberFrom(raw, ["death_reward_preview", "death_drop_coins"], 0)
        };
      }
      function normalizeCoin(raw) {
        if (!raw || typeof raw != "object") return null;
        let x = numberFrom(raw, ["x", "pos_x", "world_x", "cx"], null), y = numberFrom(raw, ["y", "pos_y", "world_y", "cy"], null), amount = Number(raw.amount);
        return {
          id: String(raw.drop_id ?? raw.coinId ?? raw.id ?? ""),
          x,
          y,
          amount: Number.isFinite(amount) && amount > 0 ? amount : null
        };
      }
      function normalizeProjectile(raw) {
        return !raw || typeof raw != "object" ? null : {
          id: String(raw.projectile_id ?? raw.bullet_id ?? raw.shot_id ?? raw.id ?? raw.uid ?? ""),
          startX: numberFrom(raw, ["start_x", "pos_x", "world_x", "x"], null),
          startY: numberFrom(raw, ["start_y", "pos_y", "world_y", "y"], null),
          vx: numberFrom(raw, ["vx", "vel_x", "velocity_x", "speed_x"], 0),
          vy: numberFrom(raw, ["vy", "vel_y", "velocity_y", "speed_y"], 0),
          owner: raw.owner_user_id != null ? String(raw.owner_user_id) : null
        };
      }
      function gameStateSnapshot(deps) {
        let state2 = deps && deps.state, now = deps && deps.now != null ? deps.now : Date.now(), selfId = deps && deps.selfId != null ? String(deps.selfId) : null, snapshot = {
          now,
          self: null,
          players: [],
          coins: [],
          projectiles: [],
          input: { userKeys: [] },
          contract: { status: "UNKNOWN", missing: [] }
        }, entities = Array.isArray(state2 && state2.entities) ? state2.entities : [];
        if (selfId)
          for (let raw of entities)
            try {
              if (raw && String(raw.user_id ?? raw.userId ?? raw.uid) === selfId) {
                let p = normalizePlayer(raw);
                p && (snapshot.self = {
                  ...p,
                  stamina5sMs: numberFrom(raw, ["stamina_5s_remaining_milli", "stamina5s"], null),
                  stamina1hMs: numberFrom(raw, ["stamina_1h_remaining_milli", "stamina1h"], null),
                  balance: numberFrom(raw, ["external_balance_snapshot", "balance"], null)
                });
                break;
              }
            } catch {
            }
        for (let raw of entities)
          try {
            let p = normalizePlayer(raw);
            if (!p || selfId && p.id === selfId) continue;
            snapshot.players.push(p);
          } catch {
          }
        let coinDrops = Array.isArray(state2 && state2.coinDrops) ? state2.coinDrops : [];
        for (let raw of coinDrops)
          try {
            let c = normalizeCoin(raw);
            if (!c) continue;
            snapshot.coins.push(c);
          } catch {
          }
        let keys = state2 && state2.keys;
        if (keys && typeof keys.has == "function") {
          let userKeys = [];
          for (let k of ["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"])
            try {
              keys.has(k) && userKeys.push(k);
            } catch {
            }
          snapshot.input.userKeys = userKeys;
        }
        return snapshot;
      }
      function createControlAdapter(deps) {
        let state2 = deps && deps.state, sendVelocity2 = deps && deps.sendVelocity, scriptMoveKeys = deps && deps.scriptMoveKeys || /* @__PURE__ */ new Set(), findLeaveBtn = deps && deps.findLeaveBtn;
        function clearScriptKeys() {
          if (state2 && state2.keys && typeof state2.keys.delete == "function")
            for (let key of scriptMoveKeys)
              try {
                state2.keys.delete(key);
              } catch {
              }
          scriptMoveKeys.clear();
        }
        function addKey(key) {
          if (scriptMoveKeys.add(key), state2 && state2.keys && typeof state2.keys.add == "function")
            try {
              state2.keys.add(key);
            } catch {
            }
        }
        return {
          move(vector) {
            let dx = vector && vector.dx ? vector.dx : 0, dy = vector && vector.dy ? vector.dy : 0;
            if (clearScriptKeys(), dx < 0 && addKey("a"), dx > 0 && addKey("d"), dy < 0 && addKey("w"), dy > 0 && addKey("s"), typeof sendVelocity2 == "function")
              try {
                sendVelocity2(!0);
              } catch {
              }
          },
          stop() {
            if (clearScriptKeys(), typeof sendVelocity2 == "function")
              try {
                sendVelocity2(!0);
              } catch {
              }
          },
          leave() {
            if (!findLeaveBtn) return !1;
            let btn = findLeaveBtn();
            if (!btn) return !1;
            try {
              return btn.click(), !0;
            } catch {
              return !1;
            }
          },
          fire(pointer) {
            return { pointer, ok: !!(pointer && Number.isFinite(pointer.x) && Number.isFinite(pointer.y)) };
          }
        };
      }
      function gameScreenCenter(rect, screenCenter2) {
        if (typeof screenCenter2 == "function")
          try {
            let point = screenCenter2(), x = Number(point && point.x), y = Number(point && point.y);
            if (Number.isFinite(x) && Number.isFinite(y))
              return { x: rect.left + x, y: rect.top + y };
          } catch {
          }
        let reservedLeft = window.matchMedia("(max-aspect-ratio: 1/1)").matches ? 0 : Math.min(368, Math.max(0, rect.width - 320));
        return {
          x: rect.left + reservedLeft + (rect.width - reservedLeft) / 2,
          y: rect.top + rect.height / 2
        };
      }
      function gameCameraCenter(me, localVisual) {
        let visual = localVisual;
        return visual && Number.isFinite(Number(visual.x)) && Number.isFinite(Number(visual.y)) ? { x: Number(visual.x), y: Number(visual.y) } : {
          x: me ? Number(me.x) : 0,
          y: me ? Number(me.y) : 0
        };
      }
      function fallbackWorldToClient(me, rect, viewRadiusCm, localVisual) {
        let shortSide = Math.max(1, Math.min(rect.width, rect.height)), viewRadius = Number(viewRadiusCm), units = Number.isFinite(viewRadius) && viewRadius > 0 ? viewRadius * 2 / shortSide : 5e4 * 2 / shortSide, origin = gameScreenCenter(rect), camera = gameCameraCenter(me, localVisual);
        return (point) => ({
          x: origin.x + (Number(point.x) - camera.x) / units,
          y: origin.y + (Number(point.y) - camera.y) / units
        });
      }
      function worldToClientFactory(me, rootRect, deps) {
        let rect = deps && deps.canvasRect ? deps.canvasRect() : null;
        if (typeof deps.viewParams == "function" && typeof deps.worldToScreen == "function")
          try {
            let view = deps.viewParams();
            return (point) => {
              let screenPoint = deps.worldToScreen(Number(point.x), Number(point.y), view);
              return {
                x: (rect ? rect.left : 0) + Number(screenPoint.x),
                y: (rect ? rect.top : 0) + Number(screenPoint.y)
              };
            };
          } catch {
          }
        return !rect || rect.width <= 0 || rect.height <= 0 ? fallbackWorldToClient(me, deps.overlayRect || rootRect, deps.viewRadiusCm, deps.localVisual) : fallbackWorldToClient(me, rect, deps.viewRadiusCm, deps.localVisual);
      }
      function makeCandidate(type, source, priority, reason, extra) {
        return Object.assign({
          type,
          source,
          priority,
          reason,
          vector: null,
          // { x, y } 仅在 MOVE 时有效
          target: null,
          // { x, y } 世界坐标(导航/逃离用)
          expiresAt: null
          // 该动作的过期时刻(可选)
        }, extra || {});
      }
      function candidateNeedsMove(c) {
        return c && c.type === "MOVE" && c.vector && (c.vector.x !== 0 || c.vector.y !== 0);
      }
      let ACTION_PRIORITY = {
        DEAD: 1e3,
        // 已死亡/页面离开/实例销毁
        HP_LEAVE: 950,
        // 血量下降/低血/小时体力限制
        REJOIN_SAFETY_LEAVE: 900,
        // 重连恢复态附近危险或再次掉血
        USER_MANUAL_INPUT: 850,
        // 真实 WASD/方向键接管
        PROJECTILE_DODGE: 800,
        // 近弹或高压弹道规避
        THREAT_FLEE: 750,
        // 危险玩家过近
        COMBAT_SPACING: 650,
        // 临时交战距离调节
        MANUAL_TARGET: 600,
        // 用户右键/长按目标
        HUNT_TARGET: 550,
        // 自动追杀目标
        COIN_ROUTE: 400,
        // 金币路线
        IDLE: 0
        // 停止移动
      };
      function pickAction(candidates) {
        if (!candidates || !candidates.length)
          return { type: "STOP", source: "idle", priority: 0, reason: "无动作候选", vector: null, target: null };
        let best = candidates[0];
        for (let i = 1; i < candidates.length; i++) {
          let c = candidates[i];
          c.priority > best.priority && (best = c);
        }
        return best.type === "MOVE" && !best.vector && (best = { ...best, vector: { x: 0, y: 0 } }), best;
      }
      function withUserInput(candidates, userKeys) {
        if (!(Array.isArray(userKeys) && userKeys.length > 0)) return candidates;
        let rest = (candidates || []).filter((c) => c.source !== "user");
        return rest.push({
          type: "MOVE",
          source: "user",
          priority: 850,
          reason: "用户手动输入接管",
          vector: null,
          // 由 ControlAdapter 保留用户按键,不清空
          target: null
        }), rest;
      }
      function createStateMachine(initial) {
        let state2 = initial || RUNNER_STATES.STANDBY, listeners = [];
        return {
          get() {
            return state2;
          },
          is(...names) {
            return names.includes(state2);
          },
          can(target) {
            return (ALLOWED_TRANSITIONS[state2] || /* @__PURE__ */ new Set()).has(target);
          },
          transition(target, reason) {
            if (target === state2) return !0;
            if (!this.can(target)) return !1;
            let prev = state2;
            state2 = target;
            for (let fn of listeners)
              try {
                fn(prev, state2, reason);
              } catch {
              }
            return !0;
          },
          onTransition(fn) {
            return listeners.push(fn), () => {
              let i = listeners.indexOf(fn);
              i >= 0 && listeners.splice(i, 1);
            };
          }
        };
      }
      let RUNNER_STATES = {
        STANDBY: "STANDBY",
        CRUISE: "CRUISE",
        RAID: "RAID",
        HUNT: "HUNT",
        COMBAT: "COMBAT",
        REJOIN: "REJOIN",
        LEAVING: "LEAVING",
        STOPPED: "STOPPED"
      }, ALLOWED_TRANSITIONS = {
        STANDBY: /* @__PURE__ */ new Set(["CRUISE", "RAID", "HUNT", "COMBAT", "REJOIN", "LEAVING", "STOPPED"]),
        CRUISE: /* @__PURE__ */ new Set(["RAID", "HUNT", "COMBAT", "REJOIN", "LEAVING", "STOPPED", "STANDBY"]),
        RAID: /* @__PURE__ */ new Set(["CRUISE", "HUNT", "COMBAT", "REJOIN", "LEAVING", "STOPPED", "STANDBY"]),
        HUNT: /* @__PURE__ */ new Set(["CRUISE", "RAID", "COMBAT", "REJOIN", "LEAVING", "STOPPED", "STANDBY"]),
        COMBAT: /* @__PURE__ */ new Set(["CRUISE", "RAID", "HUNT", "REJOIN", "LEAVING", "STOPPED", "STANDBY"]),
        REJOIN: /* @__PURE__ */ new Set(["CRUISE", "RAID", "COMBAT", "LEAVING", "STOPPED", "STANDBY"]),
        LEAVING: /* @__PURE__ */ new Set(["STOPPED", "STANDBY"]),
        STOPPED: /* @__PURE__ */ new Set(["CRUISE", "RAID", "HUNT", "COMBAT", "REJOIN", "STANDBY"])
      };
      function createScheduler(inject) {
        let setInt = inject && inject.setInterval || ((fn, ms) => setInterval(fn, ms)), clearInt = inject && inject.clearInterval || ((id) => clearInterval(id)), now = inject && inject.now || (() => Date.now()), tasks = /* @__PURE__ */ new Map(), timer = 0, driverMs = 50, lastTick = 0, running = !1;
        function tick() {
          let t = now();
          lastTick = t;
          for (let [name, task] of tasks)
            if (task.lastRunAt === 0 || t - task.lastRunAt >= task.periodMs) {
              task.lastRunAt = t;
              try {
                task.fn(t);
              } catch {
              }
            }
        }
        return {
          // 注册/更新一个周期任务。periodMs 为最小周期(实际按 driver 粒度触发)。
          register(name, periodMs, fn) {
            let p = Math.max(1, Number(periodMs) || 0);
            tasks.set(name, { periodMs: p, lastRunAt: 0, fn }), p < driverMs && (driverMs = p), running && tasks.size === 1 && (clearInt(timer), timer = setInt(tick, driverMs));
          },
          unregister(name) {
            tasks.delete(name);
          },
          start() {
            if (running) return;
            running = !0, lastTick = now();
            let minPeriod = driverMs;
            for (let t of tasks.values()) minPeriod = Math.min(minPeriod, t.periodMs);
            driverMs = minPeriod, timer = setInt(tick, driverMs);
          },
          stop() {
            running && (running = !1, clearInt(timer), timer = 0);
          },
          has(name) {
            return tasks.has(name);
          },
          count() {
            return tasks.size;
          }
        };
      }
      function raidEntityInvincible(entity, now) {
        if (!entity) return !1;
        let absolute = Number(entity.invincible_until ?? entity.invulnerable_until ?? entity.invulnerable_until_ms);
        if (Number.isFinite(absolute) && absolute > Number(now || Date.now())) return !0;
        let remaining = Number(entity.invuln_remaining_ms ?? entity.invincible_remaining_ms ?? entity.inv);
        return Number.isFinite(remaining) && remaining > 0;
      }
      function classifyRaidCandidate(enemy, motion, me, now, options) {
        let cfg = { ...RAIDER_DEFAULTS, ...options || {} }, hp = Number(enemy && enemy.hpForFire), drop = Number(enemy && (enemy.dropForAvoid ?? enemy.drop ?? enemy.death_reward_preview ?? enemy.death_drop_coins)), dist = Number(enemy && enemy.dist), selfHp = Number(me && me.hp), base = {
          ...enemy || {},
          hpForFire: hp,
          dropForAvoid: Number.isFinite(drop) ? drop : 0,
          dist,
          eligible: !1,
          kind: "blocked",
          stationaryMs: 0,
          reason: "invalid"
        };
        if (!enemy || enemy.life !== "Alive") return { ...base, reason: "not-alive" };
        if (!(hp > 0) || !(drop > 0) || !Number.isFinite(dist) || dist > cfg.maxPursuitCm)
          return { ...base, reason: "no-value-or-out-of-range" };
        if (raidEntityInvincible(enemy, now)) return { ...base, reason: "invincible" };
        let firstSeenAt = Number(motion && motion.firstSeenAt), lastMovedAt = Number(motion && motion.lastMovedAt), stationarySince = Math.max(
          Number.isFinite(firstSeenAt) && firstSeenAt > 0 ? firstSeenAt : Number(now || 0),
          Number.isFinite(lastMovedAt) && lastMovedAt > 0 ? lastMovedAt : 0
        ), stationaryMs = Math.max(0, Number(now || 0) - stationarySince);
        if (stationaryMs >= cfg.stillMs && drop >= cfg.minAfkDrop)
          return { ...base, eligible: !0, kind: "afk", stationaryMs, reason: "stationary-drop" };
        let favorableHp = Number.isFinite(selfHp) && selfHp >= cfg.minSelfHp && (hp <= selfHp * cfg.activeHpRatio || drop >= cfg.activeHighDrop && hp <= selfHp + cfg.activeHighDropHpSlack);
        return drop >= cfg.minActiveDrop && favorableHp ? { ...base, eligible: !0, kind: "finish", stationaryMs, reason: "favorable-finish" } : { ...base, stationaryMs, reason: "active-risk" };
      }
      function scoreRaidCandidate(me, target, options) {
        let cfg = { ...RAIDER_DEFAULTS, ...options || {} };
        if (!target || target.eligible === !1) return null;
        let hp = Number(target.hpForFire), reward = Number(target.dropForAvoid ?? target.drop), dist = Number(target.dist);
        if (!(hp > 0) || !(reward > 0) || !Number.isFinite(dist)) return null;
        let shots = Math.max(1, Math.ceil(hp / cfg.damagePerShot)), approachCm = Math.max(0, dist - cfg.holdRangeCm), pickupCm = Math.min(cfg.holdRangeCm, Math.max(0, dist - approachCm)), fireStaminaMs = shots * cfg.shotStaminaMs, totalStaminaMs = approachCm + pickupCm + fireStaminaMs, stamina5s = Number(me && me.stamina_5s_remaining_milli), minimumBurstBudget = (cfg.minBurstShots + cfg.reserveShots) * cfg.shotStaminaMs;
        if (!Number.isFinite(stamina5s) || stamina5s < minimumBurstBudget) return null;
        let stamina1h = Number(me && me.stamina_1h_remaining_milli);
        if (Number.isFinite(stamina1h) && stamina1h < totalStaminaMs + cfg.reserveShots * cfg.shotStaminaMs) return null;
        let approachSeconds = approachCm / 1e3, fireSeconds = shots * cfg.shotIntervalMs / 1e3, pickupSeconds = pickupCm / 1e3, riskFactor = target.kind === "finish" ? 0.82 : 1, score = reward / (approachSeconds + fireSeconds + pickupSeconds + 1.4) * riskFactor * cfg.killBias;
        return {
          kind: "kill",
          id: String(target.user_id ?? target.id ?? ""),
          score,
          reward,
          shots,
          totalStaminaMs,
          approachCm,
          pickupCm,
          target
        };
      }
      function chooseProfileOpportunity(coin, kill, held, now, options) {
        let cfg = { ...RAIDER_DEFAULTS, ...options || {} }, candidates = [coin, kill].filter((item) => item && Number.isFinite(Number(item.score)));
        if (!candidates.length) return null;
        candidates.sort((a, b) => Number(b.score) - Number(a.score) || (a.kind === "kill" ? -1 : 1));
        let best = candidates[0];
        if (!held) return { ...best, adoptedAt: Number(now || Date.now()) };
        let heldFresh = candidates.find((item) => item.kind === held.kind && String(item.id) === String(held.id));
        return heldFresh ? best.kind === heldFresh.kind && String(best.id) === String(heldFresh.id) ? { ...heldFresh, adoptedAt: held.adoptedAt || Number(now || Date.now()) } : Number(best.score) < Number(heldFresh.score) * cfg.switchFactor ? { ...heldFresh, adoptedAt: held.adoptedAt || Number(now || Date.now()) } : { ...best, adoptedAt: Number(now || Date.now()) } : { ...best, adoptedAt: Number(now || Date.now()) };
      }
      function raidShouldAbort(me, target, engagementHp, options) {
        let cfg = { ...RAIDER_DEFAULTS, ...options || {} }, hp = Number(me && me.hp), targetHp = Number(target && target.hpForFire);
        return !Number.isFinite(hp) || hp <= 0 ? { abort: !0, reason: "self-dead" } : hp <= 25 ? { abort: !0, reason: "critical-hp" } : Number.isFinite(engagementHp) && engagementHp - hp >= 18 ? { abort: !0, reason: "damage-budget" } : target && target.kind === "finish" && Number.isFinite(targetHp) && targetHp > hp * 1.15 ? { abort: !0, reason: "hp-disadvantage" } : Number(me && me.stamina_5s_remaining_milli) < (cfg.reserveShots + 1) * cfg.shotStaminaMs ? { abort: !0, reason: "stamina-reserve" } : { abort: !1, reason: "ok" };
      }
      let RAIDER_DEFAULTS = {
        stillMs: 8e3,
        recentMoveMs: 1e4,
        minAfkDrop: 1,
        minActiveDrop: 3,
        activeHpRatio: 0.78,
        activeHighDrop: 15,
        activeHighDropHpSlack: 5,
        minSelfHp: 45,
        fireRangeCm: 15e3,
        holdRangeCm: 14e3,
        maxPursuitCm: 5e4,
        damagePerShot: 3,
        shotStaminaMs: 500,
        shotIntervalMs: 100,
        reserveShots: 2,
        minBurstShots: 5,
        switchFactor: 1.15,
        killBias: 1.18
      };
      function createRuntimeWatchdog(options) {
        let cfg = {
          stallMs: 4500,
          staleMs: 12e3,
          maxRecoveries: 2,
          progressCm: 80,
          ...options || {}
        }, lastX = null, lastY = null, lastTargetKey = "", lastPulse = "", lastProgressAt = null, lastFreshAt = null, recoveries = 0;
        function reset(now) {
          lastX = null, lastY = null, lastTargetKey = "", lastPulse = "", lastProgressAt = Number.isFinite(Number(now)) ? Number(now) : null, lastFreshAt = lastProgressAt, recoveries = 0;
        }
        return {
          observe(sample) {
            let now = Number(sample && sample.now);
            if (!Number.isFinite(now)) return { action: "none", reason: "invalid-time", recoveries };
            let active = !!(sample && sample.active), expectedMove = !!(sample && sample.expectedMove), x = Number(sample && sample.x), y = Number(sample && sample.y), targetKey = String(sample && sample.targetKey || ""), pulse = String(sample && sample.pulse || "");
            if (!active || !Number.isFinite(x) || !Number.isFinite(y))
              return reset(now), { action: "none", reason: active ? "invalid-position" : "inactive", recoveries: 0 };
            if (lastProgressAt === null)
              return lastX = x, lastY = y, lastTargetKey = targetKey, lastPulse = pulse, lastProgressAt = now, lastFreshAt = now, { action: "none", reason: "baseline", recoveries };
            pulse && pulse !== lastPulse && (lastPulse = pulse, lastFreshAt = now);
            let staleFor = now - Number(lastFreshAt);
            if (pulse && staleFor >= cfg.staleMs)
              return recoveries = cfg.maxRecoveries, lastProgressAt = now, { action: "leave", reason: "state-stale", recoveries, staleFor };
            if (!expectedMove)
              return lastX = x, lastY = y, lastTargetKey = targetKey, lastProgressAt = now, recoveries = 0, { action: "none", reason: "idle", recoveries };
            if (targetKey !== lastTargetKey)
              return lastTargetKey = targetKey, lastX = x, lastY = y, lastProgressAt = now, recoveries = 0, { action: "none", reason: "target-changed", recoveries };
            if (Math.hypot(x - Number(lastX), y - Number(lastY)) >= cfg.progressCm)
              return lastX = x, lastY = y, lastProgressAt = now, recoveries = 0, { action: "none", reason: "progress", recoveries };
            let stalledFor = now - Number(lastProgressAt);
            return stalledFor < cfg.stallMs ? { action: "none", reason: "watching", recoveries, stalledFor, staleFor } : (recoveries += 1, lastProgressAt = now, recoveries >= cfg.maxRecoveries ? { action: "leave", reason: "repeated-stall", recoveries, stalledFor, staleFor } : { action: "replan", reason: "movement-stall", recoveries, stalledFor, staleFor });
          },
          reset,
          snapshot() {
            return { lastProgressAt, lastFreshAt, recoveries, targetKey: lastTargetKey };
          }
        };
      }
      window[RUNNER_KEY] && typeof window[RUNNER_KEY].destroy == "function" ? window[RUNNER_KEY].destroy("replaced") : window[RUNNER_KEY] && typeof window[RUNNER_KEY].stop == "function" && window[RUNNER_KEY].stop("replaced");
      let existingPanel = document.getElementById(PANEL_ID);
      existingPanel && existingPanel.remove();
      let existingDanger = document.getElementById(DANGER_ID);
      existingDanger && existingDanger.remove();
      let ready = () => {
        try {
          return typeof state < "u" && typeof els < "u" && typeof sendVelocity == "function" && state && els;
        } catch {
          return !1;
        }
      }, waitTimer = 0, waitCount = 0;
      function waitForGame() {
        if (ready()) {
          clearInterval(waitTimer), setupRunner();
          return;
        }
        waitCount += 1, waitCount > 240 && (console.warn("[RatGoldRunner] Game variables not found. Reload the game page and try again."), clearInterval(waitTimer));
      }
      waitTimer = window.setInterval(waitForGame, 500), waitForGame();
      function setupRunner() {
        let root = document.createElement("section");
        root.id = PANEL_ID, root.innerHTML = [
          '<div class="crgr-frame">',
          '  <canvas class="crgr-lines" data-crgr="line-canvas" aria-hidden="true"></canvas>',
          '  <div class="crgr-corner c1"></div>',
          '  <div class="crgr-corner c2"></div>',
          '  <div class="crgr-corner c3"></div>',
          '  <div class="crgr-corner c4"></div>',
          '  <div class="crgr-head">',
          '    <span class="crgr-tag">' + PROFILE_TAG + "</span>",
          '    <strong data-crgr="mode">STANDBY</strong>',
          '    <button type="button" data-crgr="collapse" title="折叠/展开">HUD</button>',
          "  </div>",
          '  <div class="crgr-attack-lock" hidden>',
          '    <button type="button" class="crgr-auto-attack" data-crgr="auto-fire" hidden>自动攻击</button>',
          '    <div class="crgr-attack-head"><span>ATTACK BUFFER</span><small data-crgr="attack-lock-summary">AUTO</small></div>',
          '    <div class="crgr-attack-list" data-crgr="attack-list"><button type="button" disabled>扫描中</button></div>',
          "  </div>",
          '  <div class="crgr-core">',
          '    <div class="crgr-reticle"><span></span><span></span><span></span><span></span></div>',
          '    <div class="crgr-action" data-crgr="action">等待启动</div>',
          '    <div class="crgr-grid">',
          '      <div><b data-crgr="hp">--</b><small>HP</small></div>',
          '      <div><b data-crgr="gain">+0</b><small>GAIN</small></div>',
          '      <div><b data-crgr="target">--</b><small>TARGET</small></div>',
          '      <div><b data-crgr="move">idle</b><small>MOVE</small></div>',
          "    </div>",
          '    <div class="crgr-line"><span>THREAT</span><b data-crgr="threat">--</b></div>',
          '    <div class="crgr-line"><span>STAMINA</span><b data-crgr="stamina">--</b></div>',
          '    <div class="crgr-line"><span>SAFETY</span><b data-crgr="safety">LEAVE 0 / EVADE 0</b></div>',
          "  </div>",
          '  <div class="crgr-body">',
          '    <div class="crgr-hunt-row" hidden>',
          '      <label>追杀用户名 <input data-crgr="hunt-query" placeholder="用户名片段" /></label>',
          '      <button type="button" data-crgr="hunt">追杀</button>',
          "    </div>",
          '    <div class="crgr-drop-board">',
          '      <div class="crgr-drop-head"><span>' + (IS_RAIDER_PROFILE ? "RAID TARGETS" : "DROP RADAR") + '</span><small data-crgr="drop-refresh">--</small></div>',
          '      <ol data-crgr="drop-list"><li>扫描中</li></ol>',
          "    </div>",
          '    <div class="crgr-actions">',
          '      <button type="button" data-crgr="start">启动</button>',
          '      <button type="button" data-crgr="stop">停止</button>',
          '      <button type="button" data-crgr="combat" hidden>临时交战</button>',
          '      <button type="button" data-crgr="reconnect">重连 ON</button>',
          '      <button type="button" data-crgr="reconnect-clear" title="清理重连流程/离开记录/ack" hidden>清理重连</button>',
          '      <button type="button" data-crgr="reconnect-retry" title="清掉失败/终态后仅本次重试">仅本次重试</button>',
          '      <button type="button" data-crgr="leave">离开</button>',
          "    </div>",
          '    <pre data-crgr="status">READY</pre>',
          "  </div>",
          "</div>"
        ].join(""), document.body.appendChild(root);
        let style = document.createElement("style");
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
        #${PANEL_ID} [hidden] { display: none !important; }
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
          width: min(460px, calc(100% - 36px));
          display: grid;
          grid-template-columns: 1fr;
          gap: 6px;
          align-items: end;
          padding: 6px;
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
          grid-template-columns: repeat(5, 1fr);
          gap: 4px;
        }
        #${PANEL_ID} button {
          min-height: 30px;
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
      `, document.head.appendChild(style);
        let danger = document.createElement("div");
        danger.id = DANGER_ID, document.body.appendChild(danger);
        let ui = {
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
          let side = document.querySelector(".side"), rect = side ? side.getBoundingClientRect() : null, sideRight = rect && rect.width > 0 ? Math.ceil(rect.right + 28) : 384;
          root.style.setProperty("--crgr-scene-left", sideRight + "px");
        }
        updateHudSceneBounds(), window.addEventListener("resize", updateHudSceneBounds);
        let runner = {
          running: !1,
          profile: BUILD_PROFILE,
          // Phase 4:显式状态机(源码 src/core/state-machine.js,内联)。
          // 与 running/combatMode/huntMode/rejoinRecovery/leaveInProgress 保持同步。
          stateMachine: createStateMachine(RUNNER_STATES.STANDBY),
          // Phase 5:本规划周期的 SpatialGrid(金币/威胁),由 bestDropRoute 构建。
          routeGrids: null,
          timer: 0,
          statusTimer: 0,
          sidebarSafetyTimer: 0,
          dropLeaderboardTimer: 0,
          dropLeaderboardEntryTimer: 0,
          dropLeaderboardEntryRefreshScheduled: !1,
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
          routeAdvanced: !1,
          // §5.7:到达金币后的确认/轻推/临时黑名单状态。
          coinArrivalId: null,
          coinArrivalAt: 0,
          coinArrivalNudges: 0,
          coinBlacklist: /* @__PURE__ */ new Map(),
          navTarget: null,
          planNextAt: 0,
          runtimeWatchdog: createRuntimeWatchdog({
            stallMs: WATCHDOG_STALL_MS,
            staleMs: WATCHDOG_STALE_MS,
            maxRecoveries: 2,
            progressCm: 80
          }),
          watchdogStatus: "OK",
          missingMeSince: 0,
          connectionIssueSince: 0,
          raidChoice: null,
          raidPlanNextAt: 0,
          raidTargetId: null,
          raidTargetLast: null,
          raidEngagementHp: null,
          raidLootAnchor: null,
          raidPhase: "idle",
          manualTarget: null,
          huntMode: !1,
          huntQuery: "",
          huntTargetId: null,
          huntTargetName: "",
          huntLastSeen: null,
          huntLastSeenAt: 0,
          combatMode: !1,
          combatRisk: "clear",
          combatProjectiles: 0,
          combatTargets: 0,
          combatSpacingState: "none",
          combatSpacingMeters: null,
          autoFireMode: !1,
          autoFireLastAt: 0,
          autoFireNextBurstAt: 0,
          autoFireBursting: !1,
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
          combatManualOverride: !1,
          userMoveKeys: /* @__PURE__ */ new Set(),
          scriptMoveKeys: /* @__PURE__ */ new Set(),
          lastMoveMode: "idle",
          lastHp: null,
          stoppedHpBaseline: null,
          leaveInProgress: !1,
          lastBalance: null,
          deltaBalance: 0,
          leaves: 0,
          avoidances: 0,
          // §5.9: 规避计数按"事件"而非 tick。fleeing=当前是否处于持续逃离,
          // fleeKey=当前威胁敌人 key;进入逃离或威胁换敌才 +1。
          fleeing: !1,
          fleeKey: "",
          hourlyLimitLeaveTriggered: !1,
          autoReconnect: !1,
          // 游戏契约分级(审计文档 §4.5):READY / DEGRADED / INCOMPATIBLE + 缺失字段。
          contractStatus: "UNKNOWN",
          contractReason: "",
          // 重连回游戏的"安全恢复态":刚通过自动重连回到游戏时进入,先不自动巡航,
          // 监控近身富敌和血量,确认安全后才恢复运行——避免几滴血出生在敌人旁边被秒。
          rejoinRecovery: !1,
          rejoinLeaveType: "",
          rejoinSafeSince: 0,
          rejoinPeakHp: null,
          rejoinTargetHpSafe: 40,
          lastThreat: null,
          enemyMotion: /* @__PURE__ */ new Map(),
          projectileMotion: /* @__PURE__ */ new Map(),
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
        try {
          let bridge = typeof window < "u" && window.__crgrReconnect || null;
          bridge && typeof bridge.readSwitch == "function" && (runner.autoReconnect = bridge.readSwitch());
        } catch {
        }
        try {
          let s = typeof state < "u" ? state : null, d = typeof els < "u" ? els : null, game = {
            state: s,
            els: d,
            sendVelocity: typeof sendVelocity < "u" ? sendVelocity : void 0,
            canvas: d && d.canvas || (typeof canvas < "u" ? canvas : void 0),
            screenCenter: d && d.screenCenter || (typeof screenCenter < "u" ? screenCenter : void 0),
            setPointerFromClient: d && d.setPointerFromClient || (typeof setPointerFromClient < "u" ? setPointerFromClient : void 0)
          }, contractFields = buildContractReport(game), classifier = window.__crgrContract && window.__crgrContract.classify || null, verdict = classifier ? classifier(contractFields) : null;
          verdict && (runner.contractStatus = verdict.status, runner.contractReport = verdict.report || null, runner.contractReason = verdict.missing.length ? "缺失必需字段: " + verdict.missing.join(", ") : verdict.criticalMissing.length ? "缺失关键可选(画布/指针): " + verdict.criticalMissing.join(", ") : "", runner.stepReady = verdict.status !== "INCOMPATIBLE", runner.fireReady = verdict.status === "READY");
        } catch {
          runner.contractStatus = "UNKNOWN", runner.stepReady = !0, runner.fireReady = !0;
        }
        let nowText = () => (/* @__PURE__ */ new Date()).toLocaleTimeString(), push = (message) => {
          runner.lastAction = message, runner.log.push(nowText() + " " + message), runner.log.length > 80 && runner.log.shift();
        };
        function getMe() {
          return state.entities.find((entity) => idKey(entity.user_id) === idKey(state.currentUserId));
        }
        function clearScriptMoveKeys(send) {
          for (let key of runner.scriptMoveKeys)
            state.keys.delete(key);
          runner.scriptMoveKeys.clear(), send && sendVelocity(!0);
        }
        function addScriptMoveKey(key) {
          runner.scriptMoveKeys.add(key), state.keys.add(key);
        }
        function setVelocity(dx, dy, options) {
          if (options && options.preserveUser)
            clearScriptMoveKeys(!1);
          else {
            for (let key of runner.scriptMoveKeys)
              state.keys.delete(key);
            runner.scriptMoveKeys.clear();
          }
          dx < 0 && addScriptMoveKey("a"), dx > 0 && addScriptMoveKey("d"), dy < 0 && addScriptMoveKey("w"), dy > 0 && addScriptMoveKey("s"), sendVelocity(!0);
        }
        function stopMove() {
          setVelocity(0, 0), runner.lastMoveMode = "idle", runner.navTarget = null;
        }
        function movementKeyFromEvent(event) {
          let key = String(event && event.key || "").toLowerCase();
          return MOVE_KEYS.includes(key) ? key : "";
        }
        function isTypingTarget(target) {
          let tag = String(target && target.tagName || "").toLowerCase();
          return tag === "input" || tag === "textarea" || tag === "select" || !!(target && target.isContentEditable);
        }
        function handleMovementKeyDown(event) {
          if (isTypingTarget(event.target)) return;
          let key = movementKeyFromEvent(event);
          key && (runner.userMoveKeys.add(key), runner.combatMode && (clearScriptMoveKeys(!0), runner.combatManualOverride = !0, runner.lastMoveMode = "manual-combat"));
        }
        function handleMovementKeyUp(event) {
          let key = movementKeyFromEvent(event);
          key && (runner.userMoveKeys.delete(key), runner.combatMode && clearScriptMoveKeys(!0));
        }
        function clearUserMoveKeys() {
          runner.userMoveKeys.clear();
        }
        function manualMoveVector() {
          let keys = new Set(runner.userMoveKeys);
          for (let key of MOVE_KEYS)
            state.keys.has(key) && !runner.scriptMoveKeys.has(key) && keys.add(key);
          let dx = (keys.has("d") || keys.has("arrowright") ? 1 : 0) - (keys.has("a") || keys.has("arrowleft") ? 1 : 0), dy = (keys.has("s") || keys.has("arrowdown") ? 1 : 0) - (keys.has("w") || keys.has("arrowup") ? 1 : 0);
          return { active: dx !== 0 || dy !== 0, dx, dy };
        }
        function setNavigationTarget(x, y, type) {
          let nx = Number(x), ny = Number(y);
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
          runner.manualTarget && (runner.manualTarget = null, clearCoinRoute(), runner.planNextAt = 0, push("手动坐标目标已清除" + (reason ? "：" + reason : "")));
        }
        function setManualTarget(x, y) {
          runner.huntMode && setHuntMode(!1, "右键坐标接管"), IS_RAIDER_PROFILE && runner.raidTargetId && resetRaidPursuit("右键坐标接管", !1), runner.manualTarget = {
            x: Math.round(Number(x)),
            y: Math.round(Number(y)),
            setAt: Date.now()
          }, clearCoinRoute(), runner.planNextAt = 0, push("右键坐标目标 " + runner.manualTarget.x + "," + runner.manualTarget.y), runner.running || start(), renderStatus();
        }
        function huntQueryText() {
          return String(ui.huntQuery && ui.huntQuery.value || runner.huntQuery || "").trim();
        }
        function clearCoinRoute() {
          runner.targetId = null, runner.targetScore = 0, runner.routeIds = [], runner.routeScore = 0, runner.routeValue = 0, runner.routeTravelSeconds = 0, runner.routeKind = "", runner.routeAdvanced = !1, runner.navTarget && runner.navTarget.type === "coin" && (runner.navTarget = null);
        }
        function adoptCoinRoute(route) {
          let ids = route && Array.isArray(route.ids) ? route.ids.filter((id) => Number.isFinite(Number(id))) : [];
          if (!route || !route.target || !ids.length) {
            clearCoinRoute();
            return;
          }
          runner.routeIds = ids.map((id) => idKey(id)), runner.targetId = idKey(route.target.drop_id), runner.targetScore = Number(route.score) || 0, runner.routeScore = runner.targetScore, runner.routeValue = Number(route.value) || 0, runner.routeTravelSeconds = Number(route.travelSeconds) || 0, runner.routeKind = route.kind || "", runner.routeAdvanced = !1, runner.planNextAt = Date.now() + REPLAN_MS;
        }
        function clearHuntTarget() {
          runner.huntTargetId = null, runner.huntTargetName = "", runner.huntLastSeen = null, runner.huntLastSeenAt = 0;
        }
        function setHuntMode(active, reason) {
          let next = !!active;
          if (next) {
            runner.lastAction = "追杀按钮已由双构建策略替代：请使用掠夺版自动选敌", renderStatus();
            return;
          }
          let query = huntQueryText();
          if (next && !query) {
            runner.lastAction = "追杀：请输入用户名片段", renderStatus();
            return;
          }
          runner.huntMode === next && (!next || runner.huntQuery === query) || (runner.huntMode = next, runner.huntQuery = next ? query : "", clearHuntTarget(), clearCoinRoute(), runner.planNextAt = 0, next ? (runner.manualTarget && clearManualTarget("开启自动追杀"), push("自动追杀已开启：用户名包含 " + query), runner.running || start()) : (runner.navTarget && runner.navTarget.type === "hunt" && (runner.navTarget = null), push("自动追杀已关闭" + (reason ? "：" + reason : ""))), syncStateMachine(), renderLines(), renderStatus());
        }
        function toggleHuntMode() {
          setHuntMode(!runner.huntMode, "manual");
        }
        function toggleReconnect() {
          runner.autoReconnect = runner.autoReconnect === !1;
          try {
            let bridge = typeof window < "u" && window.__crgrReconnect || null;
            bridge && typeof bridge.setSwitch == "function" && bridge.setSwitch(runner.autoReconnect);
          } catch {
          }
          push(runner.autoReconnect ? "自动重连已开启" : "自动重连已关闭"), renderStatus();
        }
        function driveManualTarget(me, label, options) {
          if (!runner.manualTarget) return !1;
          let manual = manualMoveVector();
          if (options && options.respectUserInput && manual.active)
            return clearScriptMoveKeys(!0), runner.combatManualOverride = !0, runner.lastMoveMode = "manual-combat", runner.lastAction = (label || "手动") + "：WASD 接管，右键坐标保留 " + runner.manualTarget.x + "," + runner.manualTarget.y, !0;
          let rx = Number(runner.manualTarget.x) - Number(me.x), ry = Number(runner.manualTarget.y) - Number(me.y), dist = Math.hypot(rx, ry);
          return dist <= MANUAL_TARGET_REACHED_CM ? (stopMove(), clearManualTarget("已到达"), !0) : (moveToward(rx, ry, options && options.preserveUser ? { preserveUser: !0 } : void 0), setNavigationTarget(runner.manualTarget.x, runner.manualTarget.y, "manual"), runner.lastAction = (label || "前往") + "右键坐标 " + runner.manualTarget.x + "," + runner.manualTarget.y + "，距离 " + Math.round(dist), clearCoinRoute(), !0);
        }
        function handleContextMenu(event) {
          let target = event.target, worldCanvas = typeof canvas < "u" ? canvas : document.getElementById("world");
          if (!(worldCanvas && target !== worldCanvas)) {
            event.preventDefault();
            try {
              typeof setPointerFromClient == "function" && setPointerFromClient(event.clientX, event.clientY);
              let point = state.pointerWorld;
              if (!point || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y)))
                throw new Error("pointerWorld unavailable");
              setManualTarget(point.x, point.y);
            } catch (err) {
              runner.lastError = "右键坐标读取失败：" + String(err && err.message || err), push(runner.lastError), renderStatus();
            }
          }
        }
        function setDanger(active, level) {
          danger.classList.toggle("active", !!active), danger.classList.toggle("critical", !!active && level === "critical"), root.classList.toggle("danger", !!active);
        }
        function moveToward(rx, ry, options) {
          let move = steerVector(rx, ry);
          return setVelocity(move.dx, move.dy, options), runner.lastMoveMode = move.mode, move;
        }
        function enemyDrop(enemy) {
          let value = Number(enemy.death_reward_preview ?? enemy.death_drop_coins ?? 0);
          return Number.isFinite(value) ? value : 0;
        }
        function enemyKey(enemy) {
          return String(enemy.user_id ?? enemy.id ?? enemy.name ?? "");
        }
        function trackEnemyMotion(now) {
          now = Number.isFinite(Number(now)) ? Number(now) : Date.now();
          let seen = /* @__PURE__ */ new Set();
          for (let entity of state.entities || []) {
            if (idKey(entity.user_id) === idKey(state.currentUserId) || entity.life !== "Alive") continue;
            let key = enemyKey(entity);
            if (!key) continue;
            let x = Number(entity.x), y = Number(entity.y);
            if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
            seen.add(key);
            let last = runner.enemyMotion.get(key), moved = last && Math.hypot(x - last.x, y - last.y) >= ENEMY_MOVE_EPSILON_CM, dt = last ? Math.max(0, (now - last.lastSeenAt) / 1e3) : 0, vxCmps = last && dt >= 0.05 ? (x - last.x) / dt : last && last.vxCmps || 0, vyCmps = last && dt >= 0.05 ? (y - last.y) / dt : last && last.vyCmps || 0;
            runner.enemyMotion.set(key, {
              x,
              y,
              vxCmps,
              vyCmps,
              firstSeenAt: last ? last.firstSeenAt : now,
              lastSeenAt: now,
              lastMovedAt: moved ? now : last ? last.lastMovedAt : 0
            });
          }
          for (let [key, value] of runner.enemyMotion)
            !seen.has(key) && now - value.lastSeenAt > MOVING_ENEMY_MEMORY_MS * 3 && runner.enemyMotion.delete(key);
        }
        function enemyMovedRecently(enemy, now) {
          let motion = runner.enemyMotion.get(enemyKey(enemy));
          return !!motion && motion.lastMovedAt > 0 && now - motion.lastMovedAt <= MOVING_ENEMY_MEMORY_MS;
        }
        function cleanUserName(value, userId) {
          let name = String(value || "").trim(), generatedSuffix = String(userId || "").trim();
          if (!name || !generatedSuffix) return name;
          let lower = name.toLowerCase();
          return name === generatedSuffix || lower === ("user " + generatedSuffix).toLowerCase() || lower === ("#" + generatedSuffix).toLowerCase() ? "" : name;
        }
        function knownNameForUser(userId) {
          let id = idKey(userId);
          if (state.userNames && typeof state.userNames.get == "function") {
            let name = state.userNames.get(id);
            if (name) return cleanUserName(name, userId);
          }
          return "";
        }
        function huntNameFromEntity(entity, userId) {
          return cleanUserName(entity && entity.name, userId) || knownNameForUser(userId);
        }
        function leaderboardNameFromEntity(entity, userId) {
          let name = huntNameFromEntity(entity, userId);
          return {
            name: name || "未知用户 #" + userId,
            copyName: name
          };
        }
        function leaderboardNameForUser(userId) {
          let name = knownNameForUser(userId);
          return {
            name: name || "未知用户 #" + userId,
            copyName: name
          };
        }
        function mergeDropLeaderboardUser(byUser, userId, drop, names, source) {
          let id = idKey(userId), amount = Number(drop);
          if (!id || !(amount > 0)) return;
          let existing = byUser.get(id);
          (!existing || amount > existing.drop || !existing.copyName && names.copyName) && byUser.set(id, {
            userId: id,
            drop: amount,
            name: names.name,
            copyName: names.copyName,
            source
          });
        }
        function topDropUsers() {
          let byUser = /* @__PURE__ */ new Map();
          for (let entity of state.entities || []) {
            let userId = idKey(entity && entity.user_id);
            userId && (entity.life && entity.life !== "Alive" || mergeDropLeaderboardUser(byUser, userId, enemyDrop(entity), leaderboardNameFromEntity(entity, userId), "entity"));
          }
          let minimapPoints = state.minimap && Array.isArray(state.minimap.points) ? state.minimap.points : [];
          for (let point of minimapPoints) {
            let userId = idKey(point && (point.u ?? point.user_id)), drop = Number(point && (point.d ?? point.drop ?? point.death_reward_preview ?? point.death_drop_coins));
            mergeDropLeaderboardUser(byUser, userId, drop, leaderboardNameForUser(userId), "minimap");
          }
          return Array.from(byUser.values()).sort((a, b) => b.drop - a.drop || String(a.name).localeCompare(String(b.name))).slice(0, 5);
        }
        function copyText(text) {
          let value = String(text || "");
          return value ? navigator.clipboard && typeof navigator.clipboard.writeText == "function" ? navigator.clipboard.writeText(value) : new Promise((resolve, reject) => {
            try {
              let textarea = document.createElement("textarea");
              textarea.value = value, textarea.setAttribute("readonly", ""), textarea.style.position = "fixed", textarea.style.left = "-9999px", textarea.style.top = "0", document.body.appendChild(textarea), textarea.select(), textarea.setSelectionRange(0, value.length);
              let ok = document.execCommand("copy");
              textarea.remove(), ok ? resolve() : reject(new Error("copy command failed"));
            } catch (err) {
              reject(err);
            }
          }) : Promise.reject(new Error("empty text"));
        }
        function renderDropLeaderboard() {
          if (!ui.dropList || !ui.dropRefresh) return;
          let rows = topDropUsers(), fragment = document.createDocumentFragment();
          if (rows.length)
            rows.forEach((row, index) => {
              let item = document.createElement("li"), rank = document.createElement("span"), name = document.createElement("button"), value = document.createElement("span");
              rank.className = "crgr-drop-rank", rank.textContent = "#" + (index + 1), name.type = "button", name.className = "crgr-drop-name", name.textContent = row.name, name.title = row.copyName ? "点击复制用户名" : "未识别到真实用户名", row.copyName ? name.dataset.copyName = row.copyName : name.disabled = !0, value.className = "crgr-drop-value", value.textContent = String(Math.round(row.drop)), item.appendChild(rank), item.appendChild(name), item.appendChild(value), fragment.appendChild(item);
            });
          else {
            let item = document.createElement("li");
            item.textContent = "暂无 Drop 数据", fragment.appendChild(item);
          }
          ui.dropList.replaceChildren(fragment), ui.dropRefresh.textContent = "刷新 " + formatClock(Date.now());
        }
        function fillHuntQueryFromLeaderboard(name) {
          let value = String(name || "").trim();
          return !value || !ui.huntQuery ? !1 : (ui.huntQuery.value = value, ui.huntQuery.dispatchEvent(new Event("input", { bubbles: !0 })), ui.huntQuery.dispatchEvent(new Event("change", { bubbles: !0 })), runner.huntQuery !== value && (runner.huntMode && clearHuntTarget(), runner.huntQuery = value), !0);
        }
        function handleDropLeaderboardClick(event) {
          let button = event.target && event.target.closest ? event.target.closest(".crgr-drop-name") : null;
          if (!button || !ui.dropList || !ui.dropList.contains(button) || !button.dataset.copyName) return;
          let name = button.dataset.copyName;
          copyText(name).then(() => {
            runner.lastAction = "已复制用户名：" + name, runner.lastError = "", ui.dropRefresh.textContent = "已复制 " + formatClock(Date.now()), renderStatus();
          }).catch((err) => {
            runner.lastAction = "用户名复制失败：" + name, runner.lastError = "复制用户名失败：" + String(err && err.message || err), renderStatus();
          });
        }
        function scheduleEntryDropLeaderboardRefresh() {
          runner.dropLeaderboardEntryRefreshScheduled || !getMe() || (runner.dropLeaderboardEntryRefreshScheduled = !0, runner.dropLeaderboardEntryTimer = window.setTimeout(() => {
            runner.dropLeaderboardEntryTimer = 0, renderDropLeaderboard(), ui.dropRefresh && (ui.dropRefresh.textContent = "进入刷新 " + formatClock(Date.now()));
          }, DROP_LEADERBOARD_ENTRY_REFRESH_DELAY_MS));
        }
        function renderAttackLockList(me) {
          if (!ui.attackList || !ui.attackLockSummary) return;
          let locked = me ? lockedAttackTarget(me) : null;
          if (locked) {
            let rangeText = locked.dist <= AUTO_FIRE_RANGE_CM ? "射程内" : "视野内";
            ui.attackLockSummary.textContent = "LOCK " + (locked.displayName || runner.attackLockName) + " / HP " + (Number.isFinite(locked.hpForFire) ? Math.round(locked.hpForFire) : "--") + " / " + Math.round(locked.dist / 100) + "m / " + rangeText;
          } else
            ui.attackLockSummary.textContent = "AUTO";
          let enemies = me ? attackBufferEnemies(me) : [], fragment = document.createDocumentFragment();
          if (enemies.length)
            enemies.forEach((enemy) => {
              let button = document.createElement("button"), name = document.createElement("span"), hp = document.createElement("span"), dist = document.createElement("span"), userId = idKey(enemy.user_id);
              button.type = "button", button.dataset.userId = userId, button.classList.toggle("active", runner.attackLockUserId !== null && idKey(runner.attackLockUserId) === userId), button.title = "点击锁定攻击对象", name.className = "crgr-attack-name", hp.className = "crgr-attack-hp", dist.className = "crgr-attack-dist", name.textContent = enemy.displayName || "#" + userId, hp.textContent = "HP " + (Number.isFinite(enemy.hpForFire) ? Math.round(enemy.hpForFire) : "--"), dist.textContent = Math.round(enemy.dist / 100) + "m", button.appendChild(name), button.appendChild(hp), button.appendChild(dist), fragment.appendChild(button);
            });
          else {
            let empty = document.createElement("button");
            empty.type = "button", empty.disabled = !0, empty.textContent = "170m 内无敌人", fragment.appendChild(empty);
          }
          ui.attackList.replaceChildren(fragment);
        }
        function handleAttackListClick(event) {
          let button = event.target && event.target.closest ? event.target.closest("button[data-user-id]") : null;
          if (!button || !ui.attackList || !ui.attackList.contains(button)) return;
          let me = getMe();
          if (!me) return;
          let target = visibleAttackTargetById(me, button.dataset.userId);
          target && setAttackLock(target, "手动选择");
        }
        function huntCandidateFromEntity(entity, me) {
          let userId = idKey(entity && entity.user_id), x = Number(entity && entity.x), y = Number(entity && entity.y);
          if (!userId || !Number.isFinite(x) || !Number.isFinite(y) || userId === idKey(state.currentUserId) || entity.life && entity.life !== "Alive") return null;
          let name = huntNameFromEntity(entity, userId);
          return name ? {
            source: "entity",
            userId,
            name,
            x,
            y,
            raw: entity,
            dist: Math.hypot(x - Number(me.x), y - Number(me.y)),
            sourcePenalty: 0
          } : null;
        }
        function huntCandidateFromMinimap(point, me, liveIds) {
          let userId = idKey(point && (point.u ?? point.user_id)), x = Number(point && point.x), y = Number(point && point.y);
          if (!userId || !Number.isFinite(x) || !Number.isFinite(y) || userId === idKey(state.currentUserId) || liveIds && liveIds.has(userId)) return null;
          let name = knownNameForUser(userId);
          return name ? {
            source: "minimap",
            userId,
            name,
            x,
            y,
            raw: point,
            dist: Math.hypot(x - Number(me.x), y - Number(me.y)),
            sourcePenalty: 24e4
          } : null;
        }
        function huntCandidates(me) {
          let out = [], liveIds = /* @__PURE__ */ new Set();
          for (let entity of state.entities || []) {
            let candidate = huntCandidateFromEntity(entity, me);
            candidate && (liveIds.add(candidate.userId), out.push(candidate));
          }
          let bestMinimapById = /* @__PURE__ */ new Map(), points = state.minimap && Array.isArray(state.minimap.points) ? state.minimap.points : [];
          for (let point of points) {
            let candidate = huntCandidateFromMinimap(point, me, liveIds);
            if (!candidate || !Number.isFinite(candidate.dist)) continue;
            let existing = bestMinimapById.get(candidate.userId);
            (!existing || candidate.dist < existing.dist) && bestMinimapById.set(candidate.userId, candidate);
          }
          for (let candidate of bestMinimapById.values()) out.push(candidate);
          return out.filter((candidate) => Number.isFinite(candidate.dist));
        }
        function huntMatchRank(candidate, query) {
          let name = cleanUserName(candidate && candidate.name).toLowerCase(), needle = String(query || "").trim().toLowerCase();
          return !needle || !name ? 1 / 0 : name === needle ? 0 : name.startsWith(needle) ? 1 : name.includes(needle) ? 2 : 1 / 0;
        }
        function findHuntTarget(me, query) {
          let candidates = huntCandidates(me).map((candidate) => ({
            ...candidate,
            matchRank: huntMatchRank(candidate, query)
          })).filter((candidate) => Number.isFinite(candidate.matchRank));
          if (!candidates.length) return null;
          if (runner.huntTargetId !== null) {
            let current = candidates.find((candidate) => candidate.userId === runner.huntTargetId);
            if (current) return current;
          }
          return candidates.sort(
            (a, b) => a.matchRank - b.matchRank || a.sourcePenalty - b.sourcePenalty || a.dist - b.dist || String(a.userId).localeCompare(String(b.userId))
          )[0];
        }
        function entityVelocityCmps(entity, userId) {
          let rawVx = numberFrom(entity, ["vx", "vel_x", "velocity_x", "velocityX", "speed_x", "speedX"], NaN), rawVy = numberFrom(entity, ["vy", "vel_y", "velocity_y", "velocityY", "speed_y", "speedY"], NaN);
          if (Number.isFinite(rawVx) && Number.isFinite(rawVy) && Math.hypot(rawVx, rawVy) > 0.01) {
            let tickMs = Math.max(1, Number(state.serverTickMs) || 50), scale = Math.hypot(rawVx, rawVy) <= 250 ? 1e3 / tickMs : 1;
            return { vx: rawVx * scale, vy: rawVy * scale };
          }
          let motion = runner.enemyMotion.get(idKey(userId ?? (entity && entity.user_id) ?? enemyKey(entity)));
          return motion && (Math.abs(motion.vxCmps || 0) > 0.01 || Math.abs(motion.vyCmps || 0) > 0.01) ? { vx: motion.vxCmps || 0, vy: motion.vyCmps || 0 } : { vx: 0, vy: 0 };
        }
        function huntVelocityCmps(candidate) {
          return entityVelocityCmps(candidate.raw, candidate.userId);
        }
        function predictedHuntPoint(candidate, me) {
          let dist = Math.hypot(Number(candidate.x) - Number(me.x), Number(candidate.y) - Number(me.y)), leadMs = Math.min(
            HUNT_PREDICT_MAX_MS,
            Math.max(HUNT_PREDICT_MIN_MS, dist / HUNT_PREDICT_DISTANCE_DIVISOR * 1e3)
          ), velocity = huntVelocityCmps(candidate), leadSeconds = leadMs / 1e3;
          return {
            x: Number(candidate.x) + velocity.vx * leadSeconds,
            y: Number(candidate.y) + velocity.vy * leadSeconds,
            leadMs,
            speed: Math.hypot(velocity.vx, velocity.vy)
          };
        }
        function liveEnemies(me, limitCm) {
          let now = Date.now();
          return (state.entities || []).filter((entity) => idKey(entity.user_id) !== idKey(state.currentUserId)).filter((entity) => entity.life === "Alive").map((entity) => ({
            ...entity,
            dropForAvoid: enemyDrop(entity),
            movedRecently: enemyMovedRecently(entity, now),
            dist: Math.hypot(Number(entity.x) - Number(me.x), Number(entity.y) - Number(me.y))
          })).filter((entity) => Number.isFinite(entity.dist) && entity.dist <= limitCm).sort((a, b) => a.dist - b.dist);
        }
        function enemyHpForDisplay(enemy) {
          return numberFrom(enemy, ["hp", "health", "life_value", "current_hp"], NaN);
        }
        function enemyDisplayName(enemy) {
          let userId = idKey(enemy && enemy.user_id);
          return huntNameFromEntity(enemy, userId) || "未知用户 #" + userId;
        }
        function decorateAttackEnemy(enemy) {
          return enemy ? {
            ...enemy,
            displayName: enemyDisplayName(enemy),
            hpForFire: enemyHpForDisplay(enemy)
          } : null;
        }
        function attackBufferEnemies(me) {
          return liveEnemies(me, RICH_ENEMY_ESCAPE_CM).map(decorateAttackEnemy).filter(Boolean).sort((a, b) => a.dist - b.dist);
        }
        function visibleAttackTargetById(me, userId) {
          let id = idKey(userId);
          if (!id) return null;
          let target = liveEnemies(me, ENEMY_LINE_SCAN_CM).find((enemy) => idKey(enemy.user_id) === id);
          return decorateAttackEnemy(target);
        }
        function burstTargetStillValid(me, enemy) {
          if (!enemy || enemy.user_id == null) return !1;
          let fresh = visibleAttackTargetById(me, enemy.user_id);
          return !fresh || fresh === null ? !1 : validateFireTarget(fresh).ok;
        }
        function clearAttackLock(reason) {
          if (runner.attackLockUserId === null) return;
          let name = runner.attackLockName || "#" + runner.attackLockUserId;
          runner.attackLockUserId = null, runner.attackLockName = "", runner.attackLockStatus = "AUTO", reason && push("攻击锁定已解除：" + name + " / " + reason);
        }
        function setAttackLock(enemy, reason) {
          let target = decorateAttackEnemy(enemy), userId = idKey(target && target.user_id);
          userId && (runner.attackLockUserId = userId, runner.attackLockName = target.displayName || "#" + userId, runner.attackLockStatus = "LOCK", runner.autoFireTarget = runner.attackLockName, push("攻击目标已锁定：" + runner.attackLockName + (reason ? " / " + reason : "")), renderStatus());
        }
        function lockedAttackTarget(me) {
          if (runner.attackLockUserId === null) return null;
          let target = visibleAttackTargetById(me, runner.attackLockUserId);
          return target ? (runner.attackLockName = target.displayName || runner.attackLockName, runner.attackLockStatus = target.dist <= AUTO_FIRE_RANGE_CM ? "LOCK" : "LOCK-OUT", {
            ...target,
            locked: !0,
            inFireRange: target.dist <= AUTO_FIRE_RANGE_CM
          }) : (clearAttackLock("目标离开500m视野或已不存活"), null);
        }
        function richEnemies(me, limitCm) {
          return liveEnemies(me, limitCm).filter((entity) => isRichEnemy(entity, RICH_ENEMY_MIN_DROP)).sort((a, b) => a.dist - b.dist);
        }
        function escapeEnemies(me, limitCm) {
          return liveEnemies(me, limitCm).filter((entity) => isEscapeThreat(entity, RICH_ENEMY_MIN_DROP, entity.movedRecently)).sort((a, b) => a.dist - b.dist);
        }
        function combatEnemies(me) {
          return liveEnemies(me, COMBAT_SCAN_CM).map((enemy) => ({
            ...enemy,
            hpForCombat: numberFrom(enemy, ["hp", "health", "life_value", "current_hp"], 0)
          }));
        }
        function combatSpacingEnemies(me) {
          return liveEnemies(me, COMBAT_SPACING_SCAN_CM);
        }
        function projectileSources() {
          let directKeys = ["bullets", "projectiles", "shots", "missiles", "arrows"], sources = [];
          if (typeof getRenderBullets == "function")
            try {
              let rendered = getRenderBullets();
              Array.isArray(rendered) && rendered.length && sources.push({ name: "renderBullets", items: rendered });
            } catch {
            }
          for (let key of directKeys) {
            let value = state[key];
            Array.isArray(value) ? sources.push({ name: key, items: value }) : value instanceof Map ? sources.push({ name: key, items: Array.from(value.values()) }) : value && typeof value == "object" && sources.push({ name: key, items: Object.values(value) });
          }
          let entityProjectiles = (state.entities || []).filter((entity) => {
            let label = String(entity.type || entity.kind || entity.entity_type || entity.role || "").toLowerCase();
            return label.includes("bullet") || label.includes("projectile") || label.includes("shot") || label.includes("missile");
          });
          return entityProjectiles.length && sources.push({ name: "entities", items: entityProjectiles }), sources;
        }
        function projectileKey(raw, source, index) {
          return String(raw.projectile_id ?? raw.bullet_id ?? raw.shot_id ?? raw.id ?? raw.uid ?? source + ":" + index);
        }
        function projectileOwner(raw) {
          return numberFrom(raw, ["owner_user_id", "owner_id", "shooter_user_id", "shooter_id", "from_user_id", "user_id"], NaN);
        }
        function projectileVelocity(raw, previous, now) {
          let vx = numberFrom(raw, ["vx", "vel_x", "velocity_x", "velocityX", "speed_x", "speedX", "dx", "dir_x", "direction_x"], NaN), vy = numberFrom(raw, ["vy", "vel_y", "velocity_y", "velocityY", "speed_y", "speedY", "dy", "dir_y", "direction_y"], NaN);
          if ((!Number.isFinite(vx) || !Number.isFinite(vy)) && previous) {
            let dt = Math.max(0.05, (now - previous.seenAt) / 1e3);
            vx = (numberFrom(raw, ["x", "pos_x", "world_x", "cx"], previous.x) - previous.x) / dt, vy = (numberFrom(raw, ["y", "pos_y", "world_y", "cy"], previous.y) - previous.y) / dt;
          }
          return !Number.isFinite(vx) || !Number.isFinite(vy) ? { vx: 0, vy: 0 } : { vx, vy };
        }
        function renderTickForProjectile(raw) {
          let localNowTick = Number(raw.local_now_tick);
          if (Number.isFinite(localNowTick)) return localNowTick;
          if (typeof getRenderTick == "function")
            try {
              let tick = Number(getRenderTick());
              if (Number.isFinite(tick)) return tick;
            } catch {
            }
          let localStartTick = Number(raw.localStartTick), localStartedAt = Number(raw.localStartedAt), tickMs = Number(state.serverTickMs);
          return Number.isFinite(localStartTick) && Number.isFinite(localStartedAt) && Number.isFinite(tickMs) && tickMs > 0 && typeof performance < "u" ? localStartTick + (performance.now() - localStartedAt) / tickMs : Number(raw.created_tick);
        }
        function projectileFromKinematics(raw) {
          let startX = numberFrom(raw, ["start_x", "origin_x", "from_x"], NaN), startY = numberFrom(raw, ["start_y", "origin_y", "from_y"], NaN), createdTick = Number(raw.created_tick);
          if (!Number.isFinite(startX) || !Number.isFinite(startY) || !Number.isFinite(createdTick)) return null;
          let tick = renderTickForProjectile(raw);
          if (!Number.isFinite(tick)) return null;
          let expireTick = Number(raw.expire_tick);
          if (Number.isFinite(expireTick) && tick > expireTick + 0.5) return null;
          let dx = Number(raw.dir_x_micros) / 1e6, dy = Number(raw.dir_y_micros) / 1e6;
          if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) < 1e-3) {
            dx = numberFrom(raw, ["target_x", "to_x"], startX) - startX, dy = numberFrom(raw, ["target_y", "to_y"], startY) - startY;
            let length = Math.hypot(dx, dy);
            if (length < 1) return null;
            dx /= length, dy /= length;
          } else {
            let length = Math.hypot(dx, dy);
            dx /= length, dy /= length;
          }
          let speedPerTick = numberFrom(raw, ["speed_per_tick", "speedPerTick"], 500), range = numberFrom(raw, ["range_cm", "range", "max_range_cm"], 15e3), ageTicks = Math.max(0, tick - createdTick), travelled = Math.min(Math.max(0, range), Math.max(0, ageTicks * speedPerTick)), tickMs = Math.max(1, Number(state.serverTickMs) || 50), speedPerSecond = speedPerTick * 1e3 / tickMs;
          return {
            x: startX + dx * travelled,
            y: startY + dy * travelled,
            vx: dx * speedPerSecond,
            vy: dy * speedPerSecond
          };
        }
        function normalizeProjectile2(raw, previous, now) {
          let kinematic = projectileFromKinematics(raw);
          if (kinematic) return kinematic;
          let x = numberFrom(raw, ["x", "pos_x", "world_x", "cx"], NaN), y = numberFrom(raw, ["y", "pos_y", "world_y", "cy"], NaN);
          if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
          let velocity = projectileVelocity(raw, previous, now);
          return {
            x,
            y,
            vx: velocity.vx,
            vy: velocity.vy
          };
        }
        function activeProjectiles(me, now) {
          let seen = /* @__PURE__ */ new Set(), projectiles = [];
          for (let source of projectileSources())
            source.items.forEach((raw, index) => {
              if (!raw || typeof raw != "object") return;
              let owner = projectileOwner(raw);
              if (Number.isFinite(owner) && idKey(owner) === idKey(state.currentUserId)) return;
              let key = projectileKey(raw, source.name, index);
              if (seen.has(key)) return;
              let previous = runner.projectileMotion.get(key), normalized = normalizeProjectile2(raw, previous, now);
              if (!normalized) return;
              let dist = Math.hypot(normalized.x - Number(me.x), normalized.y - Number(me.y));
              !Number.isFinite(dist) || dist > COMBAT_DODGE_SCAN_CM || (runner.projectileMotion.set(key, {
                x: normalized.x,
                y: normalized.y,
                vx: normalized.vx,
                vy: normalized.vy,
                seenAt: now
              }), seen.add(key), projectiles.push({
                key,
                x: normalized.x,
                y: normalized.y,
                vx: normalized.vx,
                vy: normalized.vy,
                dist
              }));
            });
          for (let [key, value] of runner.projectileMotion)
            !seen.has(key) && now - value.seenAt > PROJECTILE_MEMORY_MS && runner.projectileMotion.delete(key);
          return projectiles.sort((a, b) => a.dist - b.dist);
        }
        function projectileRisk(projectile, point, seconds) {
          let speed = Math.hypot(projectile.vx, projectile.vy);
          if (speed < 20) {
            let dist = Math.hypot(Number(point.x) - projectile.x, Number(point.y) - projectile.y);
            return Math.max(0, 1 - dist / 6500) * 120;
          }
          let ux = projectile.vx / speed, uy = projectile.vy / speed, bulletX = projectile.x + projectile.vx * seconds, bulletY = projectile.y + projectile.vy * seconds, relX = Number(point.x) - bulletX, relY = Number(point.y) - bulletY, along = relX * ux + relY * uy, perp = Math.abs(relX * uy - relY * ux), proximity = Math.hypot(relX, relY), forward = along > -1200 ? 1 : 0.28, perpRisk = Math.max(0, 1 - perp / 5600) * 190 * forward, nearRisk = Math.max(0, 1 - proximity / 4600) * 260;
          return perpRisk + nearRisk;
        }
        function combatProjectilePressure(projectiles, me) {
          let point = { x: Number(me.x), y: Number(me.y) }, pressure = 0;
          for (let projectile of projectiles.slice(0, 5))
            pressure += projectileRisk(projectile, point, 0.1), pressure += projectileRisk(projectile, point, 0.35) * 0.75;
          return pressure;
        }
        function combatSpacingState(enemies) {
          let nearest = (enemies || []).find((enemy) => Number.isFinite(Number(enemy.dist)));
          if (!nearest) return { state: "none", distance: 1 / 0 };
          let distance = Number(nearest.dist);
          return distance < COMBAT_RANGE_MIN_CM ? { state: "too-close", distance } : distance > COMBAT_RANGE_MAX_CM ? { state: "too-far", distance } : { state: "band", distance };
        }
        function combatRangeError(dist) {
          return Number.isFinite(dist) ? dist < COMBAT_RANGE_HARD_MIN_CM ? (COMBAT_RANGE_MIN_CM - dist) * 1.8 + (COMBAT_RANGE_HARD_MIN_CM - dist) * 3.2 + 4200 : dist < COMBAT_RANGE_MIN_CM ? (COMBAT_RANGE_MIN_CM - dist) * 1.8 + 900 : dist > COMBAT_RANGE_MAX_CM ? (dist - COMBAT_RANGE_MAX_CM) * 0.72 : Math.abs(dist - COMBAT_RANGE_IDEAL_CM) * 0.16 : 0;
        }
        function combatSpacingScore(me, dir, enemies) {
          if (!enemies || !enemies.length) return 0;
          let next = {
            x: Number(me.x) + dir.dx * COMBAT_DODGE_SPEED_CMPS,
            y: Number(me.y) + dir.dy * COMBAT_DODGE_SPEED_CMPS
          }, score = 0;
          return enemies.slice(0, 3).forEach((enemy, index) => {
            let currentDist = Number(enemy.dist), nextDist = Math.hypot(next.x - Number(enemy.x), next.y - Number(enemy.y));
            if (!Number.isFinite(currentDist) || !Number.isFinite(nextDist)) return;
            let weight = index === 0 ? 1 : index === 1 ? 0.48 : 0.26, improvement = combatRangeError(currentDist) - combatRangeError(nextDist);
            score += improvement * weight / 13, nextDist < COMBAT_RANGE_HARD_MIN_CM ? score -= (720 + (COMBAT_RANGE_HARD_MIN_CM - nextDist) / 12) * weight : nextDist < COMBAT_RANGE_MIN_CM ? score -= (310 + (COMBAT_RANGE_MIN_CM - nextDist) / 24) * weight : nextDist <= COMBAT_RANGE_MAX_CM ? score += (190 - Math.abs(nextDist - COMBAT_RANGE_IDEAL_CM) / 44) * weight : score -= Math.min(180, (nextDist - COMBAT_RANGE_MAX_CM) / 42) * weight, currentDist < COMBAT_RANGE_MIN_CM && nextDist < currentDist - 80 && (score -= 420 * weight), currentDist > COMBAT_RANGE_MAX_CM && nextDist > currentDist + 80 && (score -= 210 * weight);
          }), score;
        }
        function scoreCombatDirection(me, dir, projectiles, spacingEnemies, options) {
          let horizons = [0.25, 0.5, 0.85, 1.2], score = 0;
          for (let seconds of horizons) {
            let point = {
              x: Number(me.x) + dir.dx * COMBAT_DODGE_SPEED_CMPS * seconds,
              y: Number(me.y) + dir.dy * COMBAT_DODGE_SPEED_CMPS * seconds
            };
            for (let projectile of projectiles)
              score -= projectileRisk(projectile, point, seconds);
          }
          let spacingWeight = options && Number.isFinite(options.spacingWeight) ? options.spacingWeight : 1;
          score += combatSpacingScore(me, dir, spacingEnemies) * spacingWeight;
          let last = runner.lastCombatDodge || { dx: 0, dy: 0 };
          return dir.dx === last.dx && dir.dy === last.dy ? score += projectiles.length ? 180 : 90 : (score -= Date.now() - runner.lastCombatSwitchAt < COMBAT_DODGE_SWITCH_MS ? 210 : 70, dir.dx === -last.dx && dir.dy === -last.dy && (score -= 180)), score;
        }
        function chooseCombatDodge(me, projectiles, spacingEnemies) {
          let spacing = combatSpacingState(spacingEnemies);
          if (!projectiles.length && spacing.state !== "too-close" && spacing.state !== "too-far")
            return { dx: 0, dy: 0, score: 0, count: 0, spacingState: spacing.state, spacingDistance: spacing.distance };
          let dirs = [
            { dx: 0, dy: 0 },
            { dx: 1, dy: 0 },
            { dx: -1, dy: 0 },
            { dx: 0, dy: 1 },
            { dx: 0, dy: -1 },
            { dx: 1, dy: 1 },
            { dx: 1, dy: -1 },
            { dx: -1, dy: 1 },
            { dx: -1, dy: -1 }
          ], options = {
            spacingWeight: combatProjectilePressure(projectiles, me) >= COMBAT_CLOSE_PROJECTILE_PRESSURE || projectiles.some((projectile) => projectile.dist < COMBAT_RANGE_MIN_CM) ? 0.42 : projectiles.length ? 0.86 : 1.35
          }, best = {
            dx: 0,
            dy: 0,
            score: -1 / 0,
            count: projectiles.length,
            spacingState: spacing.state,
            spacingDistance: spacing.distance
          };
          for (let dir of dirs) {
            let score = scoreCombatDirection(me, dir, projectiles, spacingEnemies, options);
            score > best.score && (best = { ...dir, score, count: projectiles.length, spacingState: spacing.state, spacingDistance: spacing.distance });
          }
          let last = runner.lastCombatDodge || { dx: 0, dy: 0, score: -1 / 0 };
          if ((best.dx !== last.dx || best.dy !== last.dy) && Date.now() - runner.lastCombatSwitchAt < COMBAT_DODGE_SWITCH_MS) {
            let lastScore = scoreCombatDirection(me, last, projectiles, spacingEnemies, options);
            lastScore > best.score - 260 && (best = {
              dx: last.dx,
              dy: last.dy,
              score: lastScore,
              count: projectiles.length,
              spacingState: spacing.state,
              spacingDistance: spacing.distance
            });
          }
          return best;
        }
        function autoFireTarget(me) {
          let locked = lockedAttackTarget(me);
          return locked || liveEnemies(me, AUTO_FIRE_RANGE_CM).map(decorateAttackEnemy).filter((enemy) => Number.isFinite(enemy.hpForFire) && enemy.hpForFire > 0).sort((a, b) => a.hpForFire - b.hpForFire || a.dist - b.dist || String(a.user_id).localeCompare(String(b.user_id)))[0] || null;
        }
        function observedProjectileSpeedCmps() {
          let speeds = [];
          for (let projectile of runner.projectileMotion.values()) {
            let speed = Math.hypot(Number(projectile.vx), Number(projectile.vy));
            Number.isFinite(speed) && speed > 1e3 && speeds.push(speed);
          }
          return speeds.length ? (speeds.sort((a, b) => a - b), speeds[Math.floor(speeds.length / 2)]) : NaN;
        }
        function autoFireProjectileSpeedCmps() {
          let direct = numberFrom(state, [
            "bullet_speed_cmps",
            "bulletSpeedCmps",
            "projectile_speed_cmps",
            "projectileSpeedCmps"
          ], NaN);
          if (Number.isFinite(direct) && direct > 1e3) return direct;
          let perTick = numberFrom(state, [
            "bullet_speed_per_tick",
            "bulletSpeedPerTick",
            "projectile_speed_per_tick",
            "projectileSpeedPerTick",
            "speed_per_tick",
            "speedPerTick"
          ], NaN);
          if (Number.isFinite(perTick) && perTick > 0) {
            let tickMs = Math.max(1, Number(state.serverTickMs) || 50);
            return perTick * 1e3 / tickMs;
          }
          let observed = observedProjectileSpeedCmps();
          return Number.isFinite(observed) ? observed : AUTO_FIRE_DEFAULT_PROJECTILE_SPEED_CMPS;
        }
        function randomBetween(min, max) {
          return min + Math.random() * (max - min);
        }
        function randomInt(min, max) {
          return Math.floor(randomBetween(min, max + 1));
        }
        function predictedAutoFirePoint(me, target, extraLeadSeconds, offset) {
          let velocity = entityVelocityCmps(target, target.user_id), projectileSpeed = autoFireProjectileSpeedCmps(), totalLeadSeconds = interceptLeadSeconds(me, target, velocity, projectileSpeed) + Math.max(0, Number(extraLeadSeconds) || 0), ox = Number(offset && offset.x) || 0, oy = Number(offset && offset.y) || 0;
          return {
            x: Number(target.x) + velocity.vx * totalLeadSeconds + ox,
            y: Number(target.y) + velocity.vy * totalLeadSeconds + oy,
            leadMs: Math.round(totalLeadSeconds * 1e3),
            projectileSpeed,
            targetSpeed: Math.hypot(velocity.vx, velocity.vy)
          };
        }
        function autoFireBurstCooldownMs(me, target, shots) {
          let stamina = Number(me && me.stamina_5s_remaining_milli), ratio = Number.isFinite(stamina) ? Math.max(0, Math.min(1, stamina / AUTO_FIRE_STAMINA_MAX_MILLI)) : 0.5, farBias = target && Number(target.dist) > 11e3 ? -80 : 0, shotBias = Math.max(0, Number(shots) - AUTO_FIRE_BURST_MIN_SHOTS) * 24;
          return ratio >= 0.65 ? Math.max(90, randomBetween(120, 260) + farBias + shotBias) : ratio >= 0.35 ? Math.max(120, randomBetween(240, 520) + farBias + shotBias) : ratio >= 0.16 ? Math.max(180, randomBetween(430, 760) + farBias + shotBias) : randomBetween(620, 980) + shotBias;
        }
        function autoFireClientPoint(me, point) {
          let client = worldToClientFactory2(me, root.getBoundingClientRect())(point), x = Number(client && client.x), y = Number(client && client.y);
          if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
          let rect = canvasRect(), margin = 4;
          return x < rect.left - margin || x > rect.right + margin || y < rect.top - margin || y > rect.bottom + margin ? null : { x, y };
        }
        function worldCanvasElement() {
          return (typeof canvas < "u" ? canvas : document.getElementById("world")) || null;
        }
        function autoFireCoverageOffsets(me, target, count) {
          let velocity = entityVelocityCmps(target, target.user_id), targetSpeed = Math.hypot(velocity.vx, velocity.vy), rx = Number(target.x) - Number(me.x), ry = Number(target.y) - Number(me.y), dist = Math.max(1, Math.hypot(rx, ry)), moveBasis = targetSpeed > 80 ? { x: velocity.vx / targetSpeed, y: velocity.vy / targetSpeed } : { x: rx / dist, y: ry / dist }, perp = { x: -moveBasis.y, y: moveBasis.x }, along = moveBasis, spread = Math.min(980, Math.max(220, dist * 0.038 + targetSpeed * 0.075)), pattern = [0, -0.85, 0.85, -0.42, 0.42, -1.22, 1.22, 0.18], mid = (count - 1) / 2, offsets = [];
          for (let i = 0; i < count; i += 1) {
            let lateral = (pattern[i] ?? randomBetween(-1.15, 1.15)) * spread, forward = (i - mid) * spread * 0.18 + randomBetween(-0.12, 0.12) * spread;
            offsets.push({
              x: perp.x * lateral + along.x * forward,
              y: perp.y * lateral + along.y * forward
            });
          }
          return offsets;
        }
        function autoFireBurstClient(me, target, offset, shotIndex) {
          let freshTarget = visibleAttackTargetById(me, target.user_id) || target, extraLeadSeconds = Math.max(0, Number(shotIndex) || 0) * AUTO_FIRE_BURST_SHOT_MS / 1e3;
          return autoFireClientPoint(me, predictedAutoFirePoint(me, freshTarget, extraLeadSeconds, offset));
        }
        function dispatchAutoFireMouse(client, type, buttons) {
          let target = worldCanvasElement();
          if (!target) return;
          if (typeof setPointerFromClient == "function")
            try {
              setPointerFromClient(client.x, client.y);
            } catch {
            }
          let common = {
            bubbles: !0,
            cancelable: !0,
            view: window,
            clientX: client.x,
            clientY: client.y,
            screenX: Math.round(window.screenX + client.x),
            screenY: Math.round(window.screenY + client.y)
          };
          target.dispatchEvent(new MouseEvent(type, { ...common, button: 0, buttons }));
        }
        function clearAutoFireBurst(release) {
          for (let timer of runner.autoFireBurstTimers || [])
            clearTimeout(timer);
          runner.autoFireBurstTimers = [], release && runner.autoFireBurstClient && (dispatchAutoFireMouse(runner.autoFireBurstClient, "mouseup", 0), dispatchAutoFireMouse(runner.autoFireBurstClient, "click", 0)), runner.autoFireBursting = !1, runner.autoFireBurstClient = null;
        }
        function scheduleAutoFireBurst(fn, delayMs) {
          let timer = window.setTimeout(() => {
            runner.autoFireBurstTimers = runner.autoFireBurstTimers.filter((item) => item !== timer), fn();
          }, Math.max(0, delayMs));
          runner.autoFireBurstTimers.push(timer);
        }
        function startAutoFireBurst(me, target, targetName) {
          let stamina = finiteStaminaMs(me && me.stamina_5s_remaining_milli), plan = planBurstShots(
            stamina,
            AUTO_FIRE_BURST_MIN_SHOTS,
            AUTO_FIRE_BURST_MAX_SHOTS,
            AUTO_FIRE_STAMINA_COST_MILLI,
            AUTO_FIRE_RESERVE_SHOTS
          );
          if (stamina == null || plan.shots <= 0)
            return runner.autoFireStatus = stamina == null ? "体力未知·不发射" : "体力不足(整组预算)", !1;
          let shots = plan.shots, offsets = autoFireCoverageOffsets(me, target, shots), firstClient = autoFireBurstClient(me, target, offsets[0], 0);
          if (!firstClient)
            return runner.autoFireStatus = "目标超出画面", !1;
          if (!burstTargetStillValid(me, target))
            return runner.autoFireStatus = "目标已消失·不启动", !1;
          clearAutoFireBurst(!1), runner.autoFireBursting = !0, runner.autoFireBurstClient = firstClient, runner.autoFireLastAt = Date.now(), runner.plannedShots += shots, runner.autoFireTarget = targetName, runner.autoFireStatus = "连发 " + shots + " 发 " + targetName + " / " + Math.round(target.dist / 100) + "m", dispatchAutoFireMouse(firstClient, "mousemove", 0), dispatchAutoFireMouse(firstClient, "mousedown", 1);
          for (let i = 1; i < shots; i += 1)
            scheduleAutoFireBurst(() => {
              let currentMe = getMe();
              if (!currentMe || !runner.autoFireBursting) return;
              if (!burstTargetStillValid(currentMe, target)) {
                clearAutoFireBurst(!0), runner.autoFireStatus = "目标已消失·中止", renderStatus();
                return;
              }
              let client = autoFireBurstClient(currentMe, target, offsets[i], i);
              client && (runner.autoFireBurstClient = client, dispatchAutoFireMouse(client, "mousemove", 1));
            }, i * AUTO_FIRE_BURST_SHOT_MS);
          let holdMs = shots * AUTO_FIRE_BURST_SHOT_MS + randomBetween(55, 130);
          return scheduleAutoFireBurst(() => {
            let releaseClient = runner.autoFireBurstClient || firstClient;
            dispatchAutoFireMouse(releaseClient, "mouseup", 0), dispatchAutoFireMouse(releaseClient, "click", 0), runner.autoFireBursting = !1, runner.autoFireBurstClient = null, runner.autoFireNextBurstAt = Date.now() + autoFireBurstCooldownMs(getMe() || me, target, shots), runner.autoFireStatus = "连发完成 " + shots + " 发，等待下一组", renderStatus();
          }, holdMs), !0;
        }
        function handleAutoFire(me) {
          if (!runner.autoFireMode) return !1;
          if (runner.autoFireBursting)
            return !0;
          if (!me || me.life !== "Alive" || Number(me.hp || 0) <= COMBAT_LOW_HP)
            return runner.autoFireStatus = "SAFE", !1;
          let target = autoFireTarget(me);
          if (!target)
            return runner.autoFireTarget = "", runner.autoFireStatus = "无目标", !1;
          let targetName = target.displayName || target.name || "#" + target.user_id;
          if (target.locked && !target.inFireRange)
            return runner.autoFireTarget = targetName, runner.autoFireStatus = "锁定超出射程 " + Math.round(target.dist / 100) + "m", !1;
          if (!Number.isFinite(target.hpForFire) || !(target.hpForFire > 0))
            return runner.autoFireTarget = targetName, runner.autoFireStatus = "锁定目标HP未知", !1;
          let now = Date.now();
          return now < runner.autoFireNextBurstAt ? (runner.autoFireTarget = targetName, runner.autoFireStatus = "组间等待 " + Math.max(0, Math.ceil(runner.autoFireNextBurstAt - now)) + "ms", !1) : startAutoFireBurst(me, target, targetName);
        }
        function minRichEnemyDistanceAt(x, y, enemies) {
          return runner.routeGrids ? nearestThreatDistGrid(runner.routeGrids, x, y, RICH_ENEMY_SCAN_CM) : minDistanceToEntities(x, y, enemies);
        }
        function dropClusterValue(drop, candidates, radius, weight) {
          let scanRadius = radius || DROP_CLUSTER_CM, valueWeight = weight ?? 0.65;
          if (runner.routeGrids && !radius)
            return dropClusterValueGrid(runner.routeGrids, drop, null, DROP_CLUSTER_CM, valueWeight);
          let sum = 0;
          for (let other of candidates || []) {
            if (idKey(other.drop_id) === idKey(drop.drop_id)) continue;
            let dist = Math.hypot(Number(other.x) - Number(drop.x), Number(other.y) - Number(drop.y));
            dist > scanRadius || (sum += dropAmount(other) * (1 - dist / scanRadius) * valueWeight);
          }
          return sum;
        }
        function scoreDrop(drop, me, threats, candidates) {
          let amount = dropAmount(drop), seconds = travelSeconds(Number(me.x), Number(me.y), Number(drop.x), Number(drop.y)), firstLeg = Math.hypot(Number(drop.x) - Number(me.x), Number(drop.y) - Number(me.y)), cluster = dropClusterValue(drop, candidates), safety = minSegmentThreatDistance(Number(me.x), Number(me.y), Number(drop.x), Number(drop.y), threats);
          if (safety < RICH_ENEMY_KEEP_CM) return -1 / 0;
          let safetyFactor = safety < RICH_ENEMY_SCAN_CM ? 0.55 + 0.45 * ((safety - RICH_ENEMY_KEEP_CM) / (RICH_ENEMY_SCAN_CM - RICH_ENEMY_KEEP_CM)) : 1, sameTargetBias = idKey(drop.drop_id) === runner.targetId ? 1.12 : 1;
          return (amount + cluster) / (seconds + 1.6) * safetyFactor * sameTargetBias * routeFirstLegPreferFactor(firstLeg);
        }
        function routeClusterStats(drop, candidates) {
          if (runner.routeGrids)
            return routeClusterStatsGrid(runner.routeGrids, drop, ROUTE_CLUSTER_CM);
          let count = 0, amount = 0, weighted = 0;
          for (let other of candidates) {
            if (idKey(other.drop_id) === idKey(drop.drop_id)) continue;
            let dist = Math.hypot(Number(other.x) - Number(drop.x), Number(other.y) - Number(drop.y));
            if (dist > ROUTE_CLUSTER_CM) continue;
            let value = dropAmount(other);
            count += 1, amount += value, weighted += value * (1 - dist / ROUTE_CLUSTER_CM);
          }
          return { count, amount, weighted };
        }
        function isCoinBlacklisted(id) {
          let until = runner.coinBlacklist.get(idKey(id));
          return until == null ? !1 : until <= Date.now() ? (runner.coinBlacklist.delete(idKey(id)), !1) : !0;
        }
        function coinCandidates(me, enemies) {
          let threats = enemies || richEnemies(me, RICH_ENEMY_SCAN_CM), candidates = (Array.isArray(state.coinDrops) ? state.coinDrops : []).map((drop) => {
            let amountValue = readDropAmount(drop);
            return {
              ...drop,
              amountValue,
              dist: Math.hypot(Number(drop.x) - Number(me.x), Number(drop.y) - Number(me.y)),
              richEnemyDist: minRichEnemyDistanceAt(Number(drop.x), Number(drop.y), threats)
            };
          }).filter((drop) => drop.amountValue !== null && !isCoinBlacklisted(drop.drop_id) && Number.isFinite(drop.dist) && Number.isFinite(Number(drop.x)) && Number.isFinite(Number(drop.y))), safeBase = threats.length ? candidates.filter((drop) => drop.richEnemyDist >= RICH_ENEMY_KEEP_CM) : candidates;
          return safeBase.map((drop) => ({
            ...drop,
            score: scoreDrop(drop, me, threats, safeBase),
            routeCluster: routeClusterStats(drop, safeBase)
          })).filter((drop) => Number.isFinite(drop.score));
        }
        function routeLimitForAnchor(anchor) {
          let count = anchor && anchor.routeCluster ? anchor.routeCluster.count : 0;
          return count >= 7 ? ROUTE_MAX_POINTS_DENSE : count >= 3 ? ROUTE_MAX_POINTS_MID : count >= 1 ? ROUTE_MAX_POINTS_SPARSE : 1;
        }
        function routeStepScore(drop, currentX, currentY, prevDx, prevDy, remaining, threats, linkLimit) {
          let dx = Number(drop.x) - currentX, dy = Number(drop.y) - currentY, legDist = Math.hypot(dx, dy), allowLongValue = drop.amountValue >= 10 && legDist <= ROUTE_MAX_LINK_CM;
          if (legDist > linkLimit && !allowLongValue) return null;
          let safetyFactor = routeLegSafetyFactor(currentX, currentY, Number(drop.x), Number(drop.y), threats);
          if (safetyFactor <= 0) return null;
          let seconds = travelSeconds(currentX, currentY, Number(drop.x), Number(drop.y)), localCluster = Math.min(drop.amountValue * 2.4, dropClusterValue(drop, remaining, ROUTE_CLUSTER_CM, 0.38)), turnFactor = routeTurnFactor(prevDx, prevDy, dx, dy), score = (drop.amountValue + localCluster) / (seconds + 0.75) * safetyFactor * turnFactor;
          return { drop, dx, dy, legDist, seconds, safetyFactor, score };
        }
        function chooseNextRouteDrop(currentX, currentY, prevDx, prevDy, remaining, threats, linkLimit) {
          let best = null;
          for (let drop of remaining.values()) {
            let scored = routeStepScore(drop, currentX, currentY, prevDx, prevDy, remaining.values(), threats, linkLimit);
            scored && (!best || scored.score > best.score || scored.score === best.score && scored.legDist < best.legDist) && (best = scored);
          }
          return best;
        }
        function buildRouteFromAnchor(anchor, candidates, me, threats) {
          let maxPoints = routeLimitForAnchor(anchor), linkLimit = anchor.routeCluster.count >= 5 ? ROUTE_MAX_LINK_CM : ROUTE_LINK_CM, remaining = new Map(candidates.map((drop) => [idKey(drop.drop_id), drop])), route = [], currentX = Number(me.x), currentY = Number(me.y), prevDx = 0, prevDy = 0, totalValue = 0, totalSeconds = 0, totalLegCm = 0, minSafetyFactor = 1;
          for (let step2 = 0; step2 < maxPoints; step2 += 1) {
            let next = step2 === 0 ? routeStepScore(anchor, currentX, currentY, prevDx, prevDy, remaining.values(), threats, 1 / 0) : chooseNextRouteDrop(currentX, currentY, prevDx, prevDy, remaining, threats, linkLimit);
            if (!next) break;
            if (step2 > 0) {
              let currentEfficiency = totalValue / Math.max(0.8, totalSeconds), densityAllowance = anchor.routeCluster.count >= 5 ? 0.3 : 0.43;
              if (next.score < currentEfficiency * densityAllowance) break;
            }
            route.push(next.drop), remaining.delete(idKey(next.drop.drop_id)), totalValue += next.drop.amountValue, totalSeconds += next.seconds, totalLegCm += Number(next.legDist) || 0, minSafetyFactor = Math.min(minSafetyFactor, next.safetyFactor), currentX = Number(next.drop.x), currentY = Number(next.drop.y), prevDx = next.dx, prevDy = next.dy;
          }
          if (!route.length) return null;
          let ids = route.map((drop) => idKey(drop.drop_id)), densityBonus = Math.min(
            totalValue * 0.75,
            route.reduce((sum, drop) => sum + Math.min(drop.amountValue * 2, drop.routeCluster.weighted) * 0.18, 0)
          ), countBonus = 1 + Math.min(0.18, (route.length - 1) * 0.045), sameRouteBias = ids[0] === runner.targetId ? 1.08 : 1, kind = route.length >= 3 ? "cluster" : route.length === 2 ? "pair" : "single", lengthExcessCm = Math.max(0, totalLegCm - ROUTE_LENGTH_PENALTY_START_CM), lengthFactorBase = 1 - ROUTE_LENGTH_PENALTY_PER_CM * lengthExcessCm, lengthFactor = Math.max(ROUTE_LENGTH_PENALTY_FLOOR, lengthFactorBase), firstLegCm = route.length ? Math.hypot(Number(route[0].x) - Number(me.x), Number(route[0].y) - Number(me.y)) : 0, firstLegFactor = routeFirstLegPreferFactor(firstLegCm), score = (totalValue + densityBonus) / (totalSeconds + 1.4) * minSafetyFactor * countBonus * sameRouteBias * lengthFactor * firstLegFactor;
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
          let anchors = /* @__PURE__ */ new Map();
          for (let group of groups)
            for (let drop of group) {
              let id = idKey(drop.drop_id);
              if (anchors.has(id) || anchors.set(id, drop), anchors.size >= limit) return Array.from(anchors.values());
            }
          return Array.from(anchors.values());
        }
        function uniqueAnchors(groups) {
          return uniqueDrops(groups, ROUTE_ANCHOR_LIMIT);
        }
        function bestDropRoute(me, enemies) {
          let threats = enemies || richEnemies(me, RICH_ENEMY_SCAN_CM), candidates = coinCandidates(me, threats);
          if (!candidates.length)
            return runner.routeGrids = null, null;
          runner.routeGrids = buildRouteGrids(candidates, threats, ROUTE_CLUSTER_CM);
          let bySingleAll = [...candidates].sort((a, b) => b.score - a.score || a.dist - b.dist), bySingle = bySingleAll.slice(0, 12), byCluster = [...candidates].sort(
            (a, b) => (b.amountValue + b.routeCluster.weighted) / (travelSeconds(Number(me.x), Number(me.y), Number(b.x), Number(b.y)) + 1.4) - (a.amountValue + a.routeCluster.weighted) / (travelSeconds(Number(me.x), Number(me.y), Number(a.x), Number(a.y)) + 1.4) || a.dist - b.dist
          ), byNearAll = [...candidates].sort((a, b) => a.dist - b.dist), byAmountAll = [...candidates].sort((a, b) => b.amountValue - a.amountValue || a.dist - b.dist), byNear = byNearAll.slice(0, 6), byAmount = byAmountAll.slice(0, 6), current = runner.targetId ? candidates.filter((drop) => idKey(drop.drop_id) === runner.targetId) : [], routePool = uniqueDrops([
            current,
            bySingleAll.slice(0, 36),
            byCluster.slice(0, 36),
            byNearAll.slice(0, 18),
            byAmountAll.slice(0, 18)
          ], ROUTE_POOL_LIMIT), anchors = uniqueAnchors([current, bySingle, byCluster, byNear, byAmount]), best = null;
          for (let anchor of anchors) {
            let route = buildRouteFromAnchor(anchor, routePool, me, threats);
            route && (!best || route.score > best.score || route.score === best.score && route.travelSeconds < best.travelSeconds) && (best = route);
          }
          return best;
        }
        function currentCoinRouteTarget(me, threats) {
          let drops = Array.isArray(state.coinDrops) ? state.coinDrops : [];
          for (; runner.routeIds && runner.routeIds.length; ) {
            let id = runner.routeIds[0], target = drops.find((drop) => idKey(drop.drop_id) === id);
            if (!target) {
              runner.routeIds.shift(), runner.routeAdvanced = !0, runner.planNextAt = 0, runner.targetScore *= 0.68;
              continue;
            }
            return minRichEnemyDistanceAt(Number(target.x), Number(target.y), threats) < RICH_ENEMY_KEEP_CM ? (clearCoinRoute(), null) : (runner.targetId = id, {
              ...target,
              amountValue: dropAmount(target),
              dist: Math.hypot(Number(target.x) - Number(me.x), Number(target.y) - Number(me.y)),
              score: runner.targetScore
            });
          }
          if (runner.targetId) {
            let target = drops.find((drop) => idKey(drop.drop_id) === runner.targetId);
            return !target || isCoinBlacklisted(target.drop_id) || minRichEnemyDistanceAt(Number(target.x), Number(target.y), threats) < RICH_ENEMY_KEEP_CM ? (clearCoinRoute(), null) : {
              ...target,
              amountValue: dropAmount(target),
              dist: Math.hypot(Number(target.x) - Number(me.x), Number(target.y) - Number(me.y)),
              score: runner.targetScore
            };
          }
          return clearCoinRoute(), null;
        }
        function nearestDrop(me, enemies) {
          let route = bestDropRoute(me, enemies);
          return route ? route.target : null;
        }
        function safeFleeAnchor(me, enemy, escapeThreats, excludeId) {
          let drops = Array.isArray(state.coinDrops) ? state.coinDrops : [];
          if (!drops.length) return null;
          let threats = Array.isArray(escapeThreats) && escapeThreats.length ? escapeThreats : [], awayX = Number(me.x) - Number(enemy.x), awayY = Number(me.y) - Number(enemy.y), awayLen = Math.hypot(awayX, awayY) || 1, best = null;
          for (let drop of drops) {
            if (excludeId != null && idKey(drop.drop_id) === idKey(excludeId)) continue;
            let dx = Number(drop.x), dy = Number(drop.y);
            if (!Number.isFinite(dx) || !Number.isFinite(dy)) continue;
            if (threats.length) {
              let minThreatDist = minDistanceToEntities(dx, dy, threats);
              if (!Number.isFinite(minThreatDist) || minThreatDist < FLEE_ANCHOR_SAFE_RADIUS_CM) continue;
            } else if (Math.hypot(dx - Number(enemy.x), dy - Number(enemy.y)) < FLEE_ANCHOR_SAFE_RADIUS_CM) continue;
            let distToMe = Math.hypot(dx - Number(me.x), dy - Number(me.y)), distToEnemy = Math.hypot(dx - Number(enemy.x), dy - Number(enemy.y));
            if (!Number.isFinite(distToMe) || !Number.isFinite(distToEnemy) || distToMe > 5e5) continue;
            let toDropX = dx - Number(me.x), toDropY = dy - Number(me.y), align = (awayX * toDropX + awayY * toDropY) / awayLen, score = (distToEnemy + 1) / (distToMe + 1) + Math.max(0, align) / 2e4;
            (!best || score > best.score) && (best = { x: dx, y: dy, drop_id: drop.drop_id, score, distToMe, distToEnemy });
          }
          return best;
        }
        function fleeFrom(enemy, me, reason, urgent) {
          let now = Date.now(), key = enemyKey(enemy) || String(enemy.user_id || ""), evade = runner.fleeAnchor;
          evade && evade.key && evade.key === key ? evade = { ...evade } : evade = { key, startedAt: now, x: null, y: null, drop_id: null, anchorAt: 0 };
          let trySetAnchor = (excludeId) => {
            let escapeThreats = escapeEnemies(me, RICH_ENEMY_ESCAPE_CM), safeAnchor = safeFleeAnchor(me, enemy, escapeThreats, excludeId);
            return safeAnchor ? {
              key,
              startedAt: evade.startedAt || now,
              x: Number(safeAnchor.x),
              y: Number(safeAnchor.y),
              drop_id: safeAnchor.drop_id,
              anchorAt: now
            } : null;
          };
          if (evade.x != null) {
            let distToAnchor = Math.hypot(Number(evade.x) - Number(me.x), Number(evade.y) - Number(me.y)), stale = evade.anchorAt && now - evade.anchorAt >= FLEE_ANCHOR_MAX_MS;
            (distToAnchor <= COIN_REACHED_CM || stale) && (evade = trySetAnchor(evade.drop_id) || { key, startedAt: now, x: null, y: null, drop_id: null, anchorAt: 0 });
          } else if (now - evade.startedAt >= FLEE_ANCHOR_HOLD_MS) {
            let anchored = trySetAnchor(null);
            anchored && (evade = anchored);
          }
          runner.fleeAnchor = evade;
          let label;
          if (evade.x != null)
            moveToward(Number(evade.x) - Number(me.x), Number(evade.y) - Number(me.y)), setNavigationTarget(Number(evade.x), Number(evade.y), "evade"), label = reason + "：逃向安全金币 #" + evade.drop_id;
          else {
            let rx = Number(me.x) - Number(enemy.x), ry = Number(me.y) - Number(enemy.y);
            moveToward(rx || 1, ry);
            let length = Math.max(1, Math.hypot(rx, ry));
            setNavigationTarget(
              Number(me.x) + (rx || 1) / length * 12e3,
              Number(me.y) + ry / length * 12e3,
              "evade"
            ), label = reason + "：纯反向撤离";
          }
          setDanger(urgent), clearCoinRoute();
          let ep = fleeEpisode(runner.fleeing, runner.fleeKey, key);
          runner.avoidances += ep.countIncrement, runner.fleeing = ep.fleeing, runner.fleeKey = ep.fleeKey, runner.lastThreat = {
            name: enemy.name || "User " + enemy.user_id,
            drop: enemy.dropForAvoid,
            dist: Math.round(enemy.dist)
          }, runner.lastAction = label + " " + runner.lastThreat.name + " 距离 " + runner.lastThreat.dist + "cm Drop " + runner.lastThreat.drop;
        }
        function driveHuntTarget(me) {
          if (!runner.huntMode) return !1;
          let query = huntQueryText();
          if (!query)
            return clearHuntTarget(), stopMove(), runner.lastAction = "追杀：请输入用户名片段", !0;
          query !== runner.huntQuery && (runner.huntQuery = query, clearHuntTarget());
          let now = Date.now(), target = findHuntTarget(me, query), point = null, label = "", source = "", distToEntity = 0;
          if (target)
            point = predictedHuntPoint(target, me), label = target.name + " #" + target.userId, source = target.source === "entity" ? "实时" : "快照", distToEntity = target.dist, runner.huntTargetId = target.userId, runner.huntTargetName = target.name, runner.huntLastSeen = {
              userId: target.userId,
              name: target.name,
              x: Number(target.x),
              y: Number(target.y),
              predictedX: Number(point.x),
              predictedY: Number(point.y),
              source: target.source
            }, runner.huntLastSeenAt = now;
          else if (runner.huntLastSeen && now - runner.huntLastSeenAt <= HUNT_LOST_MEMORY_MS)
            point = {
              x: Number(runner.huntLastSeen.predictedX || runner.huntLastSeen.x),
              y: Number(runner.huntLastSeen.predictedY || runner.huntLastSeen.y),
              leadMs: 0,
              speed: 0
            }, label = runner.huntLastSeen.name + " #" + runner.huntLastSeen.userId, source = "记忆", distToEntity = Math.hypot(point.x - Number(me.x), point.y - Number(me.y));
          else
            return clearHuntTarget(), stopMove(), clearCoinRoute(), runner.lastAction = "追杀：未找到匹配用户名 " + query, !0;
          let rx = Number(point.x) - Number(me.x), ry = Number(point.y) - Number(me.y), dist = Math.hypot(rx, ry);
          return clearCoinRoute(), setDanger(!1), setNavigationTarget(point.x, point.y, "hunt"), Number.isFinite(dist) ? dist <= HUNT_REACHED_CM ? (stopMove(), runner.lastAction = "追杀：" + label + " 已贴近，保持观察", !0) : (moveToward(rx, ry), runner.lastAction = "追杀：" + label + " / " + source + " / 距离 " + Math.round(distToEntity || dist) + " / 预判 " + Math.round(point.leadMs || 0) + "ms", !0) : (stopMove(), runner.lastAction = "追杀：" + label + " 坐标异常", !0);
        }
        function raidCandidateId(enemy) {
          return idKey(enemy && (enemy.user_id ?? enemy.id));
        }
        function bestRaidKillOpportunity(me, now) {
          return !IS_RAIDER_PROFILE || runner.fireReady === !1 ? null : liveEnemies(me, RAIDER_DEFAULTS.maxPursuitCm).map(decorateAttackEnemy).filter(Boolean).map((enemy) => classifyRaidCandidate(
            enemy,
            runner.enemyMotion.get(raidCandidateId(enemy)),
            me,
            now
          )).filter((enemy) => enemy.eligible).map((enemy) => scoreRaidCandidate(me, enemy)).filter(Boolean).sort((a, b) => Number(b.score) - Number(a.score) || Number(b.reward) - Number(a.reward) || Number(a.target.dist) - Number(b.target.dist))[0] || null;
        }
        function resetRaidPursuit(reason, keepLoot) {
          let previous = runner.raidTargetLast, hadTarget = !!runner.raidTargetId;
          runner.autoFireMode = !1, runner.autoFireStatus = "OFF", runner.autoFireTarget = "", clearAutoFireBurst(!0), clearAttackLock(reason || "掠夺目标结束"), runner.raidTargetId = null, runner.raidTargetLast = null, runner.raidEngagementHp = null, runner.raidPhase = keepLoot ? "loot-wait" : "idle", keepLoot && previous && Number.isFinite(previous.x) && Number.isFinite(previous.y) ? runner.raidLootAnchor = { ...previous, createdAt: Date.now() } : keepLoot || (runner.raidLootAnchor = null), setStepInterval(STEP_TICK_MS), syncStateMachine(), hadTarget && reason && push("掠夺目标结束：" + reason);
        }
        function planRaiderOpportunity(me, threats, now) {
          if (!IS_RAIDER_PROFILE || runner.manualTarget || (now = Number.isFinite(Number(now)) ? Number(now) : Date.now(), now < runner.raidPlanNextAt && runner.raidChoice)) return runner.raidChoice;
          let planned = bestDropRoute(me, threats), coin = planned && planned.target ? {
            kind: "coin",
            id: idKey(planned.target.drop_id),
            score: Number(planned.score) || 0,
            route: planned
          } : null, kill = bestRaidKillOpportunity(me, now), choice = chooseProfileOpportunity(coin, kill, runner.raidChoice, now);
          if (runner.raidPlanNextAt = now + RAID_REPLAN_MS, !choice)
            return runner.raidTargetId && resetRaidPursuit("没有合格目标", !1), runner.raidChoice = null, null;
          if (choice.kind === "kill") {
            let changed = idKey(choice.id) !== idKey(runner.raidTargetId);
            return changed && runner.raidTargetId && resetRaidPursuit("切换到更高收益目标", !1), runner.raidChoice = choice, runner.raidTargetId = idKey(choice.id), runner.raidPhase = "pursuit", clearCoinRoute(), changed && (runner.raidEngagementHp = Number(me.hp), setAttackLock(choice.target, choice.target.kind === "afk" ? "静止目标" : "优势收割"), push("掠夺机会：" + (choice.target.displayName || "#" + choice.id) + " / " + choice.target.kind + " / Drop " + Math.round(choice.reward) + " / 评分 " + choice.score.toFixed(3))), syncStateMachine(), runner.raidChoice;
          }
          return runner.raidTargetId && resetRaidPursuit("金币路线收益更高", !1), runner.raidChoice = choice, choice.route && adoptCoinRoute(choice.route), runner.raidPhase = "scavenge", runner.raidChoice;
        }
        function handleRaidLoot(me) {
          let anchor = runner.raidLootAnchor;
          if (!IS_RAIDER_PROFILE || !anchor) return !1;
          let now = Date.now(), loot = (state.coinDrops || []).map((drop) => ({
            ...drop,
            distToAnchor: Math.hypot(Number(drop.x) - anchor.x, Number(drop.y) - anchor.y),
            distToMe: Math.hypot(Number(drop.x) - Number(me.x), Number(drop.y) - Number(me.y)),
            amountValue: readDropAmount(drop)
          })).filter((drop) => Number.isFinite(drop.distToAnchor) && drop.distToAnchor <= RAID_LOOT_RADIUS_CM && drop.amountValue !== null).sort((a, b) => Number(b.amountValue) - Number(a.amountValue) || a.distToMe - b.distToMe)[0];
          if (loot)
            return runner.raidLootAnchor = null, runner.raidChoice = {
              kind: "coin",
              id: idKey(loot.drop_id),
              score: Number(loot.amountValue) / (loot.distToMe / 1e3 + 0.75),
              adoptedAt: now
            }, adoptCoinRoute({
              target: loot,
              ids: [loot.drop_id],
              score: runner.raidChoice.score,
              value: Number(loot.amountValue),
              travelSeconds: loot.distToMe / 1e3,
              kind: "raid-loot"
            }), runner.raidPhase = "loot", push("发现击杀掉落 #" + loot.drop_id + "，优先回收 " + Math.round(loot.amountValue)), !1;
          let elapsed = now - Number(anchor.createdAt || now);
          return elapsed < RAID_LOOT_WAIT_MS ? (stopMove(), runner.raidPhase = "loot-wait", runner.lastAction = "等待击杀掉落 " + Math.ceil((RAID_LOOT_WAIT_MS - elapsed) / 100) / 10 + "s", !0) : (elapsed >= RAID_LOOT_HOLD_MS && (runner.raidLootAnchor = null), !1);
        }
        function driveRaiderOpportunity(me) {
          if (!IS_RAIDER_PROFILE || !runner.raidChoice || runner.raidChoice.kind !== "kill" || !runner.raidTargetId)
            return !1;
          let now = Date.now(), fresh = visibleAttackTargetById(me, runner.raidTargetId);
          if (!fresh)
            return resetRaidPursuit("目标消失，检查掉落", !0), runner.raidChoice = null, runner.raidPlanNextAt = now + RAID_LOOT_WAIT_MS, handleRaidLoot(me);
          let target = classifyRaidCandidate(
            fresh,
            runner.enemyMotion.get(raidCandidateId(fresh)),
            me,
            now
          );
          if (runner.raidTargetLast = {
            id: raidCandidateId(target),
            name: target.displayName || "#" + raidCandidateId(target),
            x: Number(target.x),
            y: Number(target.y),
            hp: Number(target.hpForFire),
            dist: Number(target.dist),
            seenAt: now
          }, !target.eligible)
            return resetRaidPursuit("目标转为高风险：" + target.reason, !1), runner.raidChoice = null, runner.raidPlanNextAt = 0, !1;
          let abort = raidShouldAbort(me, target, runner.raidEngagementHp);
          if (abort.abort)
            return setDanger(!0, abort.reason === "critical-hp" ? "critical" : void 0), clickLeave("掠夺止损：" + abort.reason, { recovery: !0, fallbackReloadMs: WATCHDOG_FALLBACK_RELOAD_MS }), !0;
          if (idKey(runner.attackLockUserId) !== idKey(runner.raidTargetId) && setAttackLock(target, "恢复掠夺锁定"), Number(target.dist) > RAIDER_DEFAULTS.holdRangeCm) {
            runner.autoFireMode = !1, runner.autoFireStatus = "追近", clearAutoFireBurst(!0), setStepInterval(STEP_TICK_MS);
            let velocity = entityVelocityCmps(target, target.user_id), leadSeconds = Math.min(0.65, Math.max(0.18, Number(target.dist) / 5e4)), tx = Number(target.x) + velocity.vx * leadSeconds, ty = Number(target.y) + velocity.vy * leadSeconds;
            return moveToward(tx - Number(me.x), ty - Number(me.y)), setNavigationTarget(tx, ty, "raid"), runner.raidPhase = "pursuit", runner.lastAction = "掠夺追近 " + runner.raidTargetLast.name + " / " + Math.round(Number(target.dist) / 100) + "m / Drop " + Math.round(target.dropForAvoid), !0;
          }
          return runner.autoFireMode = runner.fireReady !== !1, runner.raidPhase = "fire", setStepInterval(runner.autoFireMode ? AUTO_FIRE_LOOP_MS : STEP_TICK_MS), target.kind === "afk" && Number(target.dist) <= RAIDER_DEFAULTS.holdRangeCm ? (stopMove(), runner.lastMoveMode = "raid-hold") : applyCombatDodge(me, [target]), runner.autoFireMode && handleAutoFire(me), runner.lastAction = "掠夺开火 " + runner.raidTargetLast.name + " / HP " + Math.round(target.hpForFire) + " / Drop " + Math.round(target.dropForAvoid) + " / " + runner.autoFireStatus, !0;
        }
        function canvasRect() {
          let worldCanvas = typeof canvas < "u" ? canvas : document.getElementById("world");
          if (worldCanvas && typeof worldCanvas.getBoundingClientRect == "function") {
            let rect = worldCanvas.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) return rect;
          }
          return document.body.getBoundingClientRect();
        }
        function overlaySceneRect(rootRect) {
          return rootRect && rootRect.width > 0 && rootRect.height > 0 ? rootRect : canvasRect();
        }
        function renderWorldPoint(point) {
          let userId = idKey(point && point.user_id), currentUserId = idKey(state.currentUserId);
          if (userId && currentUserId && userId === currentUserId) {
            let visual = state.localVisual;
            if (visual && Number.isFinite(Number(visual.x)) && Number.isFinite(Number(visual.y)))
              return { ...point, x: Number(visual.x), y: Number(visual.y) };
          }
          let visuals = state.visualEntities;
          if (userId && visuals && typeof visuals.get == "function") {
            let visual = visuals.get(userId) || visuals.get(Number(userId));
            if (visual && Number.isFinite(Number(visual.x)) && Number.isFinite(Number(visual.y)))
              return { ...point, x: Number(visual.x), y: Number(visual.y) };
          }
          return point;
        }
        function gameScreenCenter2(rect) {
          if (typeof screenCenter == "function")
            try {
              let point = screenCenter(), x = Number(point && point.x), y = Number(point && point.y);
              if (Number.isFinite(x) && Number.isFinite(y))
                return { x: rect.left + x, y: rect.top + y };
            } catch {
            }
          let reservedLeft = window.matchMedia("(max-aspect-ratio: 1/1)").matches ? 0 : Math.min(368, Math.max(0, rect.width - 320));
          return {
            x: rect.left + reservedLeft + (rect.width - reservedLeft) / 2,
            y: rect.top + rect.height / 2
          };
        }
        function gameCameraCenter2(me) {
          let visual = state.localVisual;
          return visual && Number.isFinite(Number(visual.x)) && Number.isFinite(Number(visual.y)) ? { x: Number(visual.x), y: Number(visual.y) } : {
            x: Number(me.x),
            y: Number(me.y)
          };
        }
        function fallbackWorldToClient2(me, rect) {
          let shortSide = Math.max(1, Math.min(rect.width, rect.height)), viewRadius = Number(state.viewRadiusCm), units = Number.isFinite(viewRadius) && viewRadius > 0 ? viewRadius * 2 / shortSide : ENEMY_LINE_SCAN_CM * 2 / shortSide, origin = gameScreenCenter2(rect), camera = gameCameraCenter2(me);
          return (point) => ({
            x: origin.x + (Number(point.x) - camera.x) / units,
            y: origin.y + (Number(point.y) - camera.y) / units
          });
        }
        function worldToClientFactory2(me, rootRect) {
          let rect = canvasRect();
          if (typeof viewParams == "function" && typeof worldToScreen == "function")
            try {
              let view = viewParams();
              return (point) => {
                let screenPoint = worldToScreen(Number(point.x), Number(point.y), view);
                return {
                  x: rect.left + Number(screenPoint.x),
                  y: rect.top + Number(screenPoint.y)
                };
              };
            } catch {
            }
          return !rect || rect.width <= 0 || rect.height <= 0 ? fallbackWorldToClient2(me, overlaySceneRect(rootRect)) : fallbackWorldToClient2(me, rect);
        }
        function clientPoint(worldPoint, toClient, rootRect) {
          let clientPoint2 = toClient(renderWorldPoint(worldPoint)), x = Number(clientPoint2.x) - rootRect.left, y = Number(clientPoint2.y) - rootRect.top;
          return !Number.isFinite(x) || !Number.isFinite(y) ? null : { x, y };
        }
        function lineMayBeVisible(a, b, width, height) {
          return !(a.x < -120 && b.x < -120 || a.y < -120 && b.y < -120 || a.x > width + 120 && b.x > width + 120 || a.y > height + 120 && b.y > height + 120);
        }
        function prepareLineCanvas(rootRect) {
          let canvasEl = ui.lineCanvas, ctx = runner.lineCtx;
          if (!canvasEl || !ctx) return null;
          let width = Math.max(1, Math.round(rootRect.width)), height = Math.max(1, Math.round(rootRect.height)), dpr = Math.min(LINE_CANVAS_MAX_DPR, Math.max(1, Number(window.devicePixelRatio || 1))), pixelWidth = Math.max(1, Math.round(width * dpr)), pixelHeight = Math.max(1, Math.round(height * dpr));
          return (canvasEl.width !== pixelWidth || canvasEl.height !== pixelHeight) && (canvasEl.width = pixelWidth, canvasEl.height = pixelHeight, canvasEl.style.width = width + "px", canvasEl.style.height = height + "px"), runner.lineDpr = dpr, ctx.setTransform(dpr, 0, 0, dpr, 0, 0), ctx.clearRect(0, 0, width, height), { ctx, width, height };
        }
        function clearLineCanvas() {
          let canvasEl = ui.lineCanvas, ctx = runner.lineCtx;
          !canvasEl || !ctx || (ctx.setTransform(1, 0, 0, 1, 0, 0), ctx.clearRect(0, 0, canvasEl.width, canvasEl.height));
        }
        function drawLine(ctx, a, b, type) {
          let styles = {
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
          }, style2 = styles[type] || styles.enemy;
          ctx.save(), ctx.lineCap = "round", ctx.lineJoin = "round", ctx.beginPath(), ctx.moveTo(a.x, a.y), ctx.lineTo(b.x, b.y), ctx.strokeStyle = "rgba(2, 6, 23, .42)", ctx.lineWidth = Math.max(4, style2.width + 3), ctx.setLineDash([]), ctx.shadowBlur = 0, ctx.stroke(), ctx.beginPath(), ctx.moveTo(a.x, a.y), ctx.lineTo(b.x, b.y), ctx.strokeStyle = style2.color, ctx.lineWidth = style2.width, ctx.setLineDash(style2.dash), ctx.shadowBlur = style2.blur, ctx.shadowColor = style2.glow, ctx.stroke(), ctx.restore();
        }
        function drawCombatTriangle(ctx, point) {
          ctx.save(), ctx.translate(point.x, point.y - 30), ctx.beginPath(), ctx.moveTo(0, 12), ctx.lineTo(-12, -9), ctx.lineTo(12, -9), ctx.closePath(), ctx.fillStyle = "rgba(248, 38, 38, .92)", ctx.shadowBlur = 14, ctx.shadowColor = "rgba(248, 38, 38, .8)", ctx.fill(), ctx.lineWidth = 1.5, ctx.strokeStyle = "rgba(254, 226, 226, .85)", ctx.stroke(), ctx.restore();
        }
        function drawCombatOverlay(surface, me, toClient, rootRect) {
          let meHp = numberFrom(me, ["hp", "health", "life_value", "current_hp"], 0);
          if (meHp <= 0) return;
          let enemies = combatEnemies(me);
          runner.combatTargets = 0;
          for (let enemy of enemies) {
            if (!(enemy.hpForCombat > 0) || enemy.hpForCombat >= meHp) continue;
            let point = clientPoint(enemy, toClient, rootRect);
            !point || point.x < -40 || point.y < -40 || point.x > rootRect.width + 40 || point.y > rootRect.height + 40 || (drawCombatTriangle(surface.ctx, point), runner.combatTargets += 1);
          }
        }
        function currentNavigationTarget() {
          if (!runner.running) return null;
          if (runner.manualTarget) return runner.manualTarget;
          if (runner.navTarget) return runner.navTarget;
          if (runner.targetId) {
            let target = state.coinDrops.find((drop) => idKey(drop.drop_id) === runner.targetId);
            if (target) return target;
          }
          return null;
        }
        function renderLines() {
          try {
            let me = getMe();
            if (!me) {
              clearLineCanvas();
              return;
            }
            let now = Date.now();
            trackEnemyMotion(now);
            let rootRect = root.getBoundingClientRect();
            if (rootRect.width <= 0 || rootRect.height <= 0 || document.hidden) {
              clearLineCanvas();
              return;
            }
            let surface = prepareLineCanvas(rootRect);
            if (!surface) return;
            let toClient = worldToClientFactory2(me, rootRect), mePoint = clientPoint(me, toClient, rootRect);
            if (!mePoint) return;
            if (runner.combatMode) {
              drawCombatOverlay(surface, me, toClient, rootRect);
              return;
            }
            let enemies = liveEnemies(me, ENEMY_LINE_SCAN_CM).filter((enemy) => enemy.dropForAvoid >= ENEMY_LINE_MIN_DROP), dangerEnemies = [];
            for (let enemy of enemies) {
              let enemyPoint = clientPoint(enemy, toClient, rootRect);
              !enemyPoint || !lineMayBeVisible(mePoint, enemyPoint, rootRect.width, rootRect.height) || (drawLine(surface.ctx, mePoint, enemyPoint, "enemy"), enemy.dist <= RICH_ENEMY_ESCAPE_CM && dangerEnemies.push(enemyPoint));
            }
            for (let enemyPoint of dangerEnemies)
              drawLine(surface.ctx, mePoint, enemyPoint, "danger");
            let target = currentNavigationTarget(), targetPoint = target ? clientPoint(target, toClient, rootRect) : null;
            targetPoint && lineMayBeVisible(mePoint, targetPoint, rootRect.width, rootRect.height) && drawLine(surface.ctx, mePoint, targetPoint, "target");
          } catch {
            clearLineCanvas();
          }
        }
        function renderLineFrame() {
          runner.lineRaf = 0, renderLines(), root.isConnected && (runner.lineRaf = window.requestAnimationFrame(renderLineFrame));
        }
        function startLineLoop() {
          runner.lineRaf || (runner.lineRaf = window.requestAnimationFrame(renderLineFrame));
        }
        function leftSidebarText() {
          let side = document.querySelector(".side");
          return side && (side.innerText || side.textContent) || "";
        }
        function hasHourlyStaminaLimit() {
          return leftSidebarText().includes("1h体力限制");
        }
        function checkHourlyStaminaLimitLeave() {
          return hasHourlyStaminaLimit() ? (runner.hourlyLimitLeaveTriggered || (runner.hourlyLimitLeaveTriggered = !0, clickLeave("左侧边栏检测到1h体力限制")), !0) : (runner.hourlyLimitLeaveTriggered = !1, !1);
        }
        function recordLeave(reason, me, options) {
          try {
            let bridge = typeof window < "u" && window.__crgrReconnect || null;
            if (!bridge || typeof bridge.writeLeave != "function") return;
            let noReconnect = !!(options && options.noReconnect), recovery = !!(options && options.recovery), previous = typeof bridge.readLeave == "function" ? bridge.readLeave() : null, type = recovery ? "damage" : classifyLeave(reason, me ? Number(me.hp || 0) : NaN, noReconnect, COMBAT_CRITICAL_HP), enabled = !noReconnect && runner.autoReconnect !== !1, previousRecovery = previous && previous.recovery === !0 && Date.now() - Number(previous.ts || 0) <= 600 * 1e3, rec = {
              ts: Date.now(),
              type,
              hp: me ? Number(me.hp || 0) : null,
              reason: String(reason || ""),
              enabled,
              recovery,
              recoveryAttempt: recovery ? previousRecovery ? Number(previous.recoveryAttempt || 0) + 1 : 1 : 0,
              v: 2
            };
            return bridge.writeLeave(rec), shouldAutoReconnect(type, enabled, noReconnect) && typeof bridge.markLeaveFlow == "function" ? (typeof bridge.clearAck == "function" && bridge.clearAck(), bridge.markLeaveFlow(rec.ts)) : (typeof bridge.clearFlow == "function" && bridge.clearFlow(), typeof bridge.clearAck == "function" && bridge.clearAck()), rec;
          } catch {
          }
          return null;
        }
        function clearReconnectState() {
          try {
            let bridge = typeof window < "u" && window.__crgrReconnect || null;
            if (!bridge) return;
            typeof bridge.clearLeave == "function" && bridge.clearLeave(), typeof bridge.clearAck == "function" && bridge.clearAck(), typeof bridge.clearFlow == "function" && bridge.clearFlow();
          } catch {
          }
        }
        function retryReconnectOnce() {
          try {
            let bridge = typeof window < "u" && window.__crgrReconnect || null, rec = bridge && bridge.readLeave ? bridge.readLeave() : null;
            if (!bridge || !rec || !rec.ts) return;
            typeof bridge.clearAck == "function" && bridge.clearAck(), typeof bridge.markLeaveFlow == "function" && bridge.markLeaveFlow(rec.ts), push("重连状态已重置,仅本次重试"), renderStatus();
          } catch {
          }
        }
        function scheduleFallbackReload(leaveRecord, delayMs, requirePlayerEntity) {
          let delay = Number(delayMs);
          return !Number.isFinite(delay) || delay <= 0 || !leaveRecord || leaveRecord.recovery !== !0 || leaveRecord.enabled === !1 ? !1 : Number(leaveRecord.recoveryAttempt || 0) > 2 ? (runner.lastError = "运行恢复已达 2 次上限，停止自动刷新", push(runner.lastError), !1) : (window.setTimeout(() => {
            if (!(!runner.leaveInProgress || location.hostname !== "grasp-rat-game.h-e.top") && !(requirePlayerEntity && !getMe())) {
              runner.lastAction = "离开未完成跳转，执行限次刷新恢复";
              try {
                location.reload();
              } catch {
              }
            }
          }, delay), !0);
        }
        function clickLeave(reason, options) {
          if (runner.leaveInProgress) return !1;
          let noReconnect = !!(options && options.noReconnect) || runner.rejoinRecovery;
          runner.leaveInProgress = !0;
          let button = null;
          try {
            button = els.leaveBtn || Array.from(document.querySelectorAll("button")).find((btn) => (btn.textContent || "").trim() === "离开");
          } catch {
          }
          stopMove(), setDanger(!1), runner.leaves += 1, runner.running = !1, runner.combatMode = !1, runner.huntMode = !1, runner.autoFireMode = !1, runner.autoFireStatus = "OFF", noReconnect && (runner.rejoinRecovery = !1, runner.rejoinSafeSince = 0, runner.rejoinPeakHp = null), syncStateMachine();
          let me = getMe();
          runner.stoppedHpBaseline = me ? Number(me.hp || 0) : null;
          let leaveRecord = recordLeave(reason, me, {
            noReconnect,
            recovery: !!(options && options.recovery)
          });
          if (!button) {
            runner.lastError = "leave button not found";
            let scheduled = scheduleFallbackReload(
              leaveRecord,
              options && options.fallbackReloadMs,
              !1
            );
            return scheduled || clearReconnectState(), push("离开失败：" + runner.lastError + (scheduled ? "（等待限次刷新）" : "（已停止自动重连）")), renderStatus(), scheduled;
          }
          clearAutoFireBurst(!0), clearAttackLock("离开脱战"), clearHuntTarget(), clearCoinRoute(), runner.raidChoice = null, runner.raidTargetId = null, runner.raidTargetLast = null, runner.raidEngagementHp = null, runner.raidLootAnchor = null, runner.raidPhase = "idle", runner.runtimeWatchdog.reset(Date.now()), runner.fleeAnchor = null, runner.cruiseDodgeUntil = 0, runner.combatRisk = "clear", runner.timer && (clearInterval(runner.timer), runner.timer = 0), runner.tickMs = STEP_TICK_MS;
          try {
            button.click(), push("已点击离开脱战：" + reason), scheduleFallbackReload(leaveRecord, options && options.fallbackReloadMs, !0);
          } catch (err) {
            clearReconnectState(), runner.lastError = String(err && err.message || err), push("离开失败：" + runner.lastError + "（已停止自动重连）");
          }
          return renderStatus(), !0;
        }
        function monitorStoppedDamage() {
          if (runner.leaveInProgress) return !0;
          let me = getMe();
          if (runner.running)
            return runner.stoppedHpBaseline = me ? Number(me.hp || 0) : null, !1;
          if (!me)
            return runner.stoppedHpBaseline = null, !1;
          let hp = Number(me.hp || 0);
          if (!Number.isFinite(hp)) return !1;
          if (runner.stoppedHpBaseline === null || me.life !== "Alive" || hp <= 0)
            return runner.stoppedHpBaseline = hp, !1;
          if (hp < runner.stoppedHpBaseline) {
            let previousHp = runner.stoppedHpBaseline;
            return runner.stoppedHpBaseline = hp, clickLeave("停止模式血量下降 " + previousHp + " -> " + hp), !0;
          }
          return hp > runner.stoppedHpBaseline && (runner.stoppedHpBaseline = hp), !1;
        }
        function detectRejoinOnLoad() {
          try {
            let bridge = typeof window < "u" && window.__crgrReconnect || null;
            if (!bridge) return;
            let ack = typeof bridge.readAck == "function" ? bridge.readAck() : null, leave = typeof bridge.readLeave == "function" ? bridge.readLeave() : null, flow = typeof bridge.readFlow == "function" ? bridge.readFlow() : null, active = typeof bridge.isRecordActive == "function" ? bridge.isRecordActive(leave) : !0, fallbackRecovery = !!(leave && leave.recovery === !0 && Number(leave.recoveryAttempt || 0) <= 2 && active && leave.enabled !== !1), oauthRecovery = !!(ack && leave && leave.ts && String(ack) === String(leave.ts) && active && leave.enabled !== !1 && flow && String(flow.ts) === String(leave.ts));
            if (!fallbackRecovery && !oauthRecovery) return;
            runner.rejoinRecovery = !0, runner.rejoinLeaveType = leave.type || "damage", runner.rejoinSafeSince = 0, runner.rejoinPeakHp = null, syncStateMachine(), push((fallbackRecovery ? "检测到看门狗刷新恢复" : "检测到自动重连回游戏") + ",进入安全恢复态(type=" + runner.rejoinLeaveType + ")…");
          } catch {
          }
        }
        function monitorRejoinRecovery() {
          if (!runner.rejoinRecovery || runner.leaveInProgress) return;
          let me = getMe();
          if (!me) return;
          let hp = Number(me.hp || 0);
          if (!Number.isFinite(hp)) return;
          if (runner.rejoinPeakHp === null && (runner.rejoinPeakHp = hp), hp > runner.rejoinPeakHp && (runner.rejoinPeakHp = hp), hp < runner.rejoinPeakHp) {
            push("重连恢复态血量下降，停止本轮自动重连"), clickLeave("重连恢复态血量下降 " + runner.rejoinPeakHp + " -> " + hp, { noReconnect: !0 });
            return;
          }
          let scanCm = runner.rejoinLeaveType === "lowhp" ? 25e3 : RICH_ENEMY_ESCAPE_CM;
          try {
            let threats = escapeEnemies(me, scanCm);
            if (threats.length > 0) {
              let t = threats[0];
              runner.running || (push("重连恢复态:近身威胁(" + Math.round(t.dist / 100) + "m)再离开——排除出生即被秒"), clickLeave("重连恢复态近身威胁 " + Math.round(t.dist / 100) + "m", { noReconnect: !0 })), runner.rejoinSafeSince = 0;
              return;
            }
          } catch {
          }
          if (runner.running) {
            runner.rejoinRecovery = !1, runner.rejoinPeakHp = null;
            return;
          }
          if (hp < runner.rejoinTargetHpSafe) {
            runner.rejoinSafeSince = 0;
            return;
          }
          runner.rejoinSafeSince || (runner.rejoinSafeSince = Date.now()), Date.now() - runner.rejoinSafeSince >= 8e3 && (runner.rejoinRecovery = !1, runner.rejoinSafeSince = 0, runner.rejoinPeakHp = null, clearReconnectState(), push("重连恢复态已解除(HP=" + hp + ",近身无威胁),自动恢复挂机"), start());
        }
        function setStepInterval(ms) {
          let next = Number(ms) || STEP_TICK_MS;
          runner.tickMs === next && runner.timer || (runner.tickMs = next, !(!runner.running || !runner.timer) && (clearInterval(runner.timer), runner.timer = window.setInterval(step, runner.tickMs)));
        }
        function setAutoFireMode(active, reason) {
          let next = !!active;
          if (next) {
            runner.lastAction = IS_RAIDER_PROFILE ? "开火由掠夺闭环自动控制" : "拾荒版不主动攻击", renderStatus();
            return;
          }
          runner.autoFireMode !== next && (runner.autoFireMode = next, runner.autoFireLastAt = 0, runner.autoFireNextBurstAt = 0, runner.autoFireStatus = next ? "待机" : "OFF", runner.autoFireTarget = "", next ? (push("自动攻击已开启：使用长按连发覆盖目标"), runner.running ? setStepInterval(AUTO_FIRE_LOOP_MS) : start()) : (clearAutoFireBurst(!0), push("自动攻击已关闭" + (reason ? "：" + reason : "")), runner.running && !runner.combatMode && setStepInterval(STEP_TICK_MS)), renderStatus());
        }
        function toggleAutoFireMode() {
          setAutoFireMode(!runner.autoFireMode, "manual");
        }
        function setCombatMode(active, reason) {
          let next = !!active;
          if (next) {
            runner.lastAction = "临时交战按钮已由掠夺版策略替代", renderStatus();
            return;
          }
          if (runner.combatMode === next) return;
          let clearedManualTarget = next && reason === "manual" && !!runner.manualTarget;
          clearedManualTarget && clearManualTarget("手动开启临时交战"), runner.combatMode = next, clearCoinRoute(), runner.planNextAt = 0, runner.navTarget = null, runner.lastCombatDodge = { dx: 0, dy: 0, score: 0 }, runner.lastCombatSwitchAt = 0, runner.combatManualOverride = !1, runner.combatProjectiles = 0, runner.combatTargets = 0, runner.combatRisk = next ? "watch" : "clear", runner.combatSpacingState = "none", runner.combatSpacingMeters = null, next ? (clearScriptMoveKeys(!0), push("临时交战已开启，暂停金币巡航" + (clearedManualTarget ? "，已取消右键目标" : "")), runner.running || start()) : (runner.projectileMotion.clear(), setStepInterval(STEP_TICK_MS), stopMove(), setDanger(!1), push("临时交战已关闭，恢复金币巡航" + (reason ? "：" + reason : ""))), syncStateMachine(), renderLines(), renderStatus();
        }
        function toggleCombatMode() {
          setCombatMode(!runner.combatMode, "manual");
        }
        function combatDangerLevel(me, enemies) {
          let hp = numberFrom(me, ["hp", "health", "life_value", "current_hp"], 0);
          return hp <= COMBAT_CRITICAL_HP ? "critical" : enemies.some((enemy) => enemy.hpForCombat > 0 && enemy.hpForCombat >= hp * 1.15) ? "outmatched" : "clear";
        }
        function applyCombatDodge(me, spacingEnemies) {
          let now = Date.now(), projectiles = activeProjectiles(me, now);
          if (runner.combatProjectiles = projectiles.length, manualMoveVector().active)
            return clearScriptMoveKeys(!0), runner.combatManualOverride = !0, runner.lastMoveMode = "manual-combat", runner.combatSpacingState = combatSpacingState(spacingEnemies).state, runner.combatSpacingMeters = null, projectiles.length;
          runner.combatManualOverride = !1;
          let dodge = chooseCombatDodge(me, projectiles, spacingEnemies);
          return (dodge.dx !== runner.lastCombatDodge.dx || dodge.dy !== runner.lastCombatDodge.dy) && (runner.lastCombatSwitchAt = now), runner.lastCombatDodge = dodge, runner.combatSpacingState = dodge.spacingState || "none", runner.combatSpacingMeters = Number.isFinite(dodge.spacingDistance) ? Math.round(dodge.spacingDistance / 100) : null, dodge.dx === 0 && dodge.dy === 0 ? (setVelocity(0, 0, { preserveUser: !0 }), runner.lastMoveMode = projectiles.length ? "combat-hold" : "combat-spacing-hold") : (setVelocity(dodge.dx, dodge.dy, { preserveUser: !0 }), runner.lastMoveMode = projectiles.length ? "combat-dodge" : "combat-spacing"), projectiles.length;
        }
        function handleCruiseProjectileDodge(me) {
          if (runner.combatMode || runner.huntMode) return !1;
          let now = Date.now(), projectiles = activeProjectiles(me, now), pressure = combatProjectilePressure(projectiles, me), near = projectiles.some((projectile) => projectile.dist < CRUISE_DODGE_NEAR_CM), hot = pressure >= CRUISE_DODGE_PRESSURE || near;
          if (hot && (runner.cruiseDodgeUntil = now + CRUISE_DODGE_HOLD_MS), !projectiles.length || !hot && now >= (runner.cruiseDodgeUntil || 0))
            return hot || (runner.cruiseDodgeUntil = 0), !1;
          let dodge = chooseCombatDodge(me, projectiles, []);
          return (dodge.dx !== (runner.lastCombatDodge && runner.lastCombatDodge.dx) || dodge.dy !== (runner.lastCombatDodge && runner.lastCombatDodge.dy)) && (runner.lastCombatSwitchAt = now), runner.lastCombatDodge = dodge, dodge.dx === 0 && dodge.dy === 0 ? (setVelocity(0, 0), runner.lastMoveMode = "cruise-dodge-hold") : (setVelocity(dodge.dx, dodge.dy), runner.lastMoveMode = "cruise-dodge", setNavigationTarget(
            Number(me.x) + dodge.dx * 8e3,
            Number(me.y) + dodge.dy * 8e3,
            "evade"
          )), setDanger(!!near), runner.lastAction = "巡航躲弹：弹体 " + projectiles.length + " 压迫 " + Math.round(pressure) + (near ? " 近弹" : ""), !0;
        }
        function handleCombatMode(me, hp) {
          if (!runner.combatMode) return !1;
          setStepInterval(hp < COMBAT_FAST_CHECK_HP ? COMBAT_FAST_TICK_MS : runner.autoFireMode ? AUTO_FIRE_LOOP_MS : STEP_TICK_MS), clearCoinRoute(), runner.planNextAt = 0, runner.navTarget = null;
          let enemies = combatEnemies(me), spacingEnemies = combatSpacingEnemies(me);
          if (runner.combatTargets = enemies.filter((enemy) => enemy.hpForCombat > 0 && enemy.hpForCombat < hp).length, hp <= COMBAT_LOW_HP)
            return runner.combatRisk = "critical", setDanger(!0, "critical"), clickLeave("临时交战血量≤" + COMBAT_LOW_HP + "：" + hp), !0;
          if (runner.combatRisk = combatDangerLevel(me, enemies), runner.combatRisk === "critical" ? setDanger(!0, "critical") : runner.combatRisk === "outmatched" ? setDanger(!0) : setDanger(!1), handleAutoFire(me), runner.manualTarget && (runner.combatProjectiles = activeProjectiles(me, Date.now()).length, runner.combatSpacingState = combatSpacingState(spacingEnemies).state, runner.combatSpacingMeters = null, runner.combatManualOverride = !1, driveManualTarget(me, "临时交战：前往", { preserveUser: !0, respectUserInput: !0 })))
            return !0;
          let projectileCount = applyCombatDodge(me, spacingEnemies), spacingText = runner.combatSpacingMeters === null ? "" : "，距离 " + runner.combatSpacingMeters + "m";
          return runner.lastAction = runner.combatManualOverride ? "临时交战：手动 WASD 接管，自动躲避暂停，标记 " + runner.combatTargets + " 个低血目标" : projectileCount ? "临时交战：躲避 " + projectileCount + " 个弹体" + spacingText + "，标记 " + runner.combatTargets + " 个低血目标" : runner.lastMoveMode === "combat-spacing" ? "临时交战：调整距离到100-150m" + spacingText + "，标记 " + runner.combatTargets + " 个低血目标" : "临时交战：未识别到弹体，保持观察" + spacingText + "，标记 " + runner.combatTargets + " 个低血目标", !0;
        }
        function runtimeWatchdogTargetKey() {
          if (runner.raidTargetId) return "raid:" + idKey(runner.raidTargetId);
          if (runner.manualTarget) return "manual:" + runner.manualTarget.x + "," + runner.manualTarget.y;
          if (runner.targetId) return "coin:" + idKey(runner.targetId);
          if (runner.fleeing && runner.fleeKey) return "evade:" + runner.fleeKey;
          let nav = runner.navTarget;
          return nav ? String(nav.type || "nav") + ":" + Math.round(Number(nav.x || 0) / 500) + "," + Math.round(Number(nav.y || 0) / 500) : "idle";
        }
        function runtimeStatePulse(me) {
          let tick = numberFrom(state, ["server_tick", "serverTick", "tick", "current_tick", "currentTick"], NaN);
          return Number.isFinite(tick) ? "tick:" + tick : "";
        }
        function visibleConnectionIssue() {
          try {
            if (typeof navigator < "u" && navigator.onLine === !1) return "browser-offline";
            let nodes = document.querySelectorAll(
              '[role="alert"], [role="status"], .toast, .notification, .modal, .ant-message, .ant-notification'
            ), pattern = /(disconnected|connection\s+(lost|failed)|network\s+error|连接(已)?断开|网络(异常|错误|已断开)|重新连接)/i;
            for (let node of nodes) {
              let value = String(node && node.textContent || "").trim();
              if (value && pattern.test(value)) return value.slice(0, 80);
            }
          } catch {
          }
          return "";
        }
        function handleConnectionIssueWatchdog() {
          let issue = visibleConnectionIssue();
          return issue ? (runner.connectionIssueSince || (runner.connectionIssueSince = Date.now()), runner.watchdogStatus = "NETWORK " + issue, Date.now() - runner.connectionIssueSince < 3e3 ? !1 : (clickLeave("运行看门狗：网络异常 " + issue, {
            recovery: !0,
            fallbackReloadMs: WATCHDOG_FALLBACK_RELOAD_MS
          }), !0)) : (runner.connectionIssueSince = 0, !1);
        }
        function handleRuntimeWatchdog(me) {
          let result = runner.runtimeWatchdog.observe({
            now: Date.now(),
            active: runner.running && !runner.leaveInProgress,
            expectedMove: runner.scriptMoveKeys.size > 0,
            x: Number(me.x),
            y: Number(me.y),
            targetKey: runtimeWatchdogTargetKey(),
            pulse: runtimeStatePulse(me)
          });
          return result.action === "replan" ? (runner.watchdogStatus = "REPLAN " + result.recoveries, runner.planNextAt = 0, runner.raidPlanNextAt = 0, runner.coinArrivalAt = 0, runner.coinArrivalNudges = 0, push("运行看门狗：移动无进展，触发重规划"), !1) : result.action === "leave" ? (runner.watchdogStatus = "RECOVER " + result.reason, clickLeave("运行看门狗：" + result.reason, {
            recovery: !0,
            fallbackReloadMs: WATCHDOG_FALLBACK_RELOAD_MS
          }), !0) : (runner.watchdogStatus = result.recoveries > 0 ? "WATCH " + result.recoveries : "OK", !1);
        }
        function step() {
          try {
            if (checkHourlyStaminaLimitLeave() || handleConnectionIssueWatchdog()) return;
            let me = getMe();
            if (!me) {
              stopMove(), runner.lastAction = "等待玩家实体", runner.missingMeSince || (runner.missingMeSince = Date.now()), Date.now() - runner.missingMeSince >= WATCHDOG_STALE_MS && (runner.watchdogStatus = "RECOVER missing-player", clickLeave("运行看门狗：玩家实体持续缺失", {
                recovery: !0,
                fallbackReloadMs: WATCHDOG_FALLBACK_RELOAD_MS
              }));
              return;
            }
            runner.missingMeSince = 0;
            let hp = Number(me.hp || 0), balance = Number(me.external_balance_snapshot || 0);
            runner.lastHp === null && (runner.lastHp = hp), runner.lastBalance === null && (runner.lastBalance = balance), balance > runner.lastBalance && (runner.deltaBalance += balance - runner.lastBalance, push("收益 +" + (balance - runner.lastBalance) + "，本次累计 +" + runner.deltaBalance)), runner.lastBalance = balance;
            let raidEngaged = IS_RAIDER_PROFILE && !!runner.raidTargetId;
            if (hp < runner.lastHp && !runner.combatMode && !raidEngaged) {
              setDanger(!1), clickLeave("常态血量下降 " + runner.lastHp + " -> " + hp), runner.lastHp = hp;
              return;
            }
            if (runner.lastHp = hp, me.life !== "Alive" || hp <= 0) {
              stopMove(), setDanger(!1), runner.lastAction = "非存活状态，停止移动";
              return;
            }
            if (Number(me.stamina_5s_remaining_milli || 0) <= 0) {
              stopMove(), setDanger(!1), runner.lastAction = "短时体力耗尽，等待恢复";
              return;
            }
            if (runner.stepReady === !1) {
              stopMove(), setDanger(!1), runner.lastAction = runner.contractReason || "页面契约未知·停用自动移动";
              return;
            }
            if (trackEnemyMotion(Date.now()), handleRuntimeWatchdog(me)) return;
            let threats = richEnemies(me, RICH_ENEMY_SCAN_CM);
            if (!IS_RAIDER_PROFILE && (handleCombatMode(me, hp) || (runner.autoFireMode ? runner.fireReady !== !1 ? (setStepInterval(AUTO_FIRE_LOOP_MS), handleAutoFire(me)) : (runner.autoFireStatus = "页面契约不满足·自动攻击不可用", setStepInterval(STEP_TICK_MS)) : setStepInterval(STEP_TICK_MS), driveHuntTarget(me))))
              return;
            IS_RAIDER_PROFILE && !runner.manualTarget && planRaiderOpportunity(me, threats, Date.now());
            let protectedRaidId = IS_RAIDER_PROFILE ? idKey(runner.raidTargetId) : "", urgentThreat = escapeEnemies(me, RICH_ENEMY_ESCAPE_CM).find((enemy) => !protectedRaidId || idKey(enemy.user_id) !== protectedRaidId);
            if (urgentThreat) {
              runner.raidTargetId && (resetRaidPursuit("第三方近身威胁优先", !1), runner.raidChoice = null, runner.raidPlanNextAt = 0);
              let reason = urgentThreat.dropForAvoid > RICH_ENEMY_MIN_DROP ? "高Drop敌人进入170m射程缓冲，立即逃离" : "低Drop移动敌人进入170m射程缓冲，立即逃离";
              fleeFrom(urgentThreat, me, reason, !0);
              return;
            }
            setDanger(!1);
            let keepawayThreat = threats.find((enemy) => enemy.dist < RICH_ENEMY_KEEP_CM && (!protectedRaidId || idKey(enemy.user_id) !== protectedRaidId));
            if (keepawayThreat) {
              runner.raidTargetId && (resetRaidPursuit("第三方威胁进入警戒范围", !1), runner.raidChoice = null, runner.raidPlanNextAt = 0), fleeFrom(keepawayThreat, me, "富敌过近，拉开到200-250m外", !1);
              return;
            }
            if (runner.fleeAnchor && (runner.fleeAnchor = null), runner.fleeing = !1, runner.fleeKey = "", driveManualTarget(me, "前往") || IS_RAIDER_PROFILE && (handleRaidLoot(me) || driveRaiderOpportunity(me)) || handleCruiseProjectileDodge(me)) return;
            let target = currentCoinRouteTarget(me, threats);
            if (!target || Date.now() >= runner.planNextAt) {
              let planned = bestDropRoute(me, threats), switchFactor = runner.routeAdvanced ? 0.98 : ROUTE_SWITCH_FACTOR;
              planned && (!target || planned.score > runner.targetScore * switchFactor) ? (adoptCoinRoute(planned), target = currentCoinRouteTarget(me, threats), push("规划金币路线 " + runner.routeIds.join(">") + " / " + (runner.routeKind || "single") + " / " + planned.drops.length + "点 / 总额 " + Math.round(planned.value) + " / 路程 " + planned.travelSeconds.toFixed(1) + "s / 评分 " + planned.score.toFixed(3))) : runner.planNextAt = Date.now() + REPLAN_MS, runner.routeAdvanced = !1;
            }
            if (!target) {
              stopMove(), runner.lastAction = threats.length ? "富敌250m内，无安全金币，保持距离" : "视野内没有金币";
              return;
            }
            let rx = Number(target.x) - Number(me.x), ry = Number(target.y) - Number(me.y), dist = Math.hypot(rx, ry);
            if (dist <= COIN_REACHED_CM) {
              let id = runner.targetId, nowArr = Date.now();
              if (runner.coinArrivalId !== id && (runner.coinArrivalId = id, runner.coinArrivalAt = nowArr, runner.coinArrivalNudges = 0), nowArr - runner.coinArrivalAt < 600) {
                stopMove(), runner.lastAction = "贴近金币 " + id + "，等待入账";
                return;
              }
              if (runner.coinArrivalNudges < 2) {
                runner.coinArrivalNudges += 1, runner.coinArrivalAt = nowArr;
                let len = Math.max(1, Math.hypot(rx, ry));
                moveToward(-ry / len, rx / len), runner.lastAction = "金币未入账·正交轻推 " + runner.coinArrivalNudges;
                return;
              }
              runner.coinBlacklist.set(id, nowArr + 8e3), runner.coinArrivalId = null, runner.coinArrivalAt = 0, runner.coinArrivalNudges = 0, clearCoinRoute(), runner.lastAction = "金币 " + id + " 未入账·临时跳过";
              return;
            }
            let move = moveToward(rx, ry);
            setNavigationTarget(target.x, target.y, "coin"), runner.lastAction = "前往金币 " + runner.targetId + "，距离 " + Math.round(dist) + "，路线 " + Math.max(1, runner.routeIds.length) + "点";
          } catch (err) {
            runner.lastError = String(err && err.message || err), stopMove(), setDanger(!1), push("循环错误：" + runner.lastError);
          }
        }
        function syncStateMachine() {
          let sm = runner.stateMachine;
          if (runner.leaveInProgress) {
            sm.transition(RUNNER_STATES.LEAVING, "leave");
            return;
          }
          if (runner.rejoinRecovery) {
            sm.transition(RUNNER_STATES.REJOIN, "rejoin");
            return;
          }
          if (!runner.running) {
            sm.transition(RUNNER_STATES.STOPPED, runner.startedAt ? "stop" : "standby");
            return;
          }
          if (runner.combatMode) {
            sm.transition(RUNNER_STATES.COMBAT, "combat");
            return;
          }
          if (runner.huntMode) {
            sm.transition(RUNNER_STATES.HUNT, "hunt");
            return;
          }
          if (IS_RAIDER_PROFILE && (runner.raidTargetId || runner.raidLootAnchor)) {
            sm.transition(RUNNER_STATES.RAID, runner.raidPhase || "raid");
            return;
          }
          sm.transition(RUNNER_STATES.CRUISE, "cruise");
        }
        function start() {
          if (runner.running) return;
          let me = getMe();
          runner.rejoinRecovery = !1, runner.rejoinSafeSince = 0, runner.rejoinPeakHp = null, runner.leaveInProgress = !1, clearReconnectState(), runner.running = !0, runner.startedAt = Date.now(), runner.lastHp = me ? Number(me.hp || 0) : null, runner.stoppedHpBaseline = runner.lastHp, runner.lastBalance = me ? Number(me.external_balance_snapshot || 0) : null, runner.hourlyLimitLeaveTriggered = !1, runner.combatMode = !1, runner.huntMode = !1, runner.autoFireMode = !1, runner.autoFireStatus = "OFF", runner.autoFireTarget = "", runner.raidChoice = null, runner.raidTargetId = null, runner.raidTargetLast = null, runner.raidEngagementHp = null, runner.raidLootAnchor = null, runner.raidPhase = "idle", runner.raidPlanNextAt = 0, runner.missingMeSince = 0, runner.connectionIssueSince = 0, runner.watchdogStatus = "OK", runner.runtimeWatchdog.reset(Date.now()), clearCoinRoute(), runner.planNextAt = 0, runner.tickMs = STEP_TICK_MS, runner.timer = window.setInterval(step, runner.tickMs), syncStateMachine(), push("已启动：" + (IS_RAIDER_PROFILE ? "杀敌掠夺" : "游走拾荒")), step(), renderStatus();
        }
        function stop(reason) {
          runner.running = !1, runner.combatMode = !1, runner.huntMode = !1, clearHuntTarget(), runner.combatRisk = "clear", runner.combatProjectiles = 0, runner.combatTargets = 0, runner.combatManualOverride = !1, runner.autoFireMode = !1, runner.autoFireStatus = "OFF", runner.autoFireTarget = "", clearAutoFireBurst(!0), clearAttackLock("停止脚本"), runner.raidChoice = null, runner.raidTargetId = null, runner.raidTargetLast = null, runner.raidEngagementHp = null, runner.raidLootAnchor = null, runner.raidPhase = "idle", runner.raidPlanNextAt = 0, runner.missingMeSince = 0, runner.connectionIssueSince = 0, runner.watchdogStatus = "OK", runner.runtimeWatchdog.reset(Date.now()), runner.projectileMotion.clear(), runner.fleeAnchor = null, runner.cruiseDodgeUntil = 0, runner.timer && (clearInterval(runner.timer), runner.timer = 0), runner.tickMs = STEP_TICK_MS;
          let me = getMe();
          runner.stoppedHpBaseline = me ? Number(me.hp || 0) : null, stopMove(), setDanger(!1), syncStateMachine(), push("已停止" + (reason ? "：" + reason : "")), renderLines(), renderStatus();
        }
        function destroy(reason) {
          stop(reason || "destroy"), runner.statusTimer && clearInterval(runner.statusTimer), runner.sidebarSafetyTimer && clearInterval(runner.sidebarSafetyTimer), runner.dropLeaderboardTimer && clearInterval(runner.dropLeaderboardTimer), runner.dropLeaderboardEntryTimer && clearTimeout(runner.dropLeaderboardEntryTimer), runner.lineRaf && (window.cancelAnimationFrame(runner.lineRaf), runner.lineRaf = 0), window.removeEventListener("resize", updateHudSceneBounds), window.removeEventListener("contextmenu", handleContextMenu, !0), window.removeEventListener("keydown", handleMovementKeyDown, !0), window.removeEventListener("keyup", handleMovementKeyUp, !0), window.removeEventListener("blur", clearUserMoveKeys), root.remove(), danger.remove(), style.remove();
        }
        function snapshot() {
          let me = getMe(), enemies = me ? richEnemies(me, RICH_ENEMY_SCAN_CM) : [], drop = me && !runner.combatMode && !runner.huntMode ? nearestDrop(me, enemies) : null, threat = enemies[0] || runner.lastThreat, manual = runner.manualTarget, huntLabel = runner.huntMode ? "HUNT " + (runner.huntTargetName || runner.huntLastSeen && runner.huntLastSeen.name || runner.huntQuery || "-") : "", raidLabel = runner.raidTargetId ? runner.raidTargetLast && runner.raidTargetLast.name || runner.attackLockName || "#" + runner.raidTargetId : "";
          return {
            profile: runner.profile,
            running: runner.running,
            combatMode: runner.combatMode,
            huntMode: runner.huntMode,
            huntQuery: runner.huntQuery,
            huntTargetId: runner.huntTargetId,
            huntTargetName: runner.huntTargetName || runner.huntLastSeen && runner.huntLastSeen.name || "",
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
            target: raidLabel || huntLabel || (manual ? manual.x + "," + manual.y : runner.targetId),
            raidTarget: raidLabel,
            raidPhase: runner.raidPhase,
            raidChoiceKind: runner.raidChoice && runner.raidChoice.kind || "",
            raidScore: runner.raidChoice && Number.isFinite(Number(runner.raidChoice.score)) ? Number(runner.raidChoice.score).toFixed(3) : "-",
            watchdogStatus: runner.watchdogStatus,
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
            stamina5s: me && Math.round((me.stamina_5s_remaining_milli || 0) / 1e3),
            stamina1h: me && Math.round((me.stamina_1h_remaining_milli || 0) / 1e3),
            action: runner.lastAction,
            error: runner.lastError
          };
        }
        function renderStatus() {
          monitorStoppedDamage(), monitorRejoinRecovery(), syncStateMachine();
          let s = snapshot();
          scheduleEntryDropLeaderboardRefresh(), root.classList.toggle("running", !!s.running), ui.mode.textContent = runner.rejoinRecovery ? "REJOIN " + (runner.rejoinLeaveType || "").toUpperCase() : s.running ? IS_RAIDER_PROFILE ? s.raidTarget ? "RAID" : s.raidPhase === "loot" || s.raidPhase === "loot-wait" ? "LOOT" : "SCAVENGE" : "SCAVENGE" : "STANDBY", ui.action.textContent = s.error ? "ERROR: " + s.error : s.action || "等待指令", ui.hp.textContent = s.hp ? String(s.hp) : "--", ui.gain.textContent = "+" + (s.delta || 0), ui.target.textContent = s.target ? String(s.target) : "--", ui.move.textContent = s.moveMode || "idle", ui.threat.textContent = s.raidTarget ? "掠夺 " + s.raidTarget + " / " + s.autoFireStatus : s.threat ? s.threat.name + " / " + s.threat.dist + "cm / Drop " + s.threat.drop : "clear", ui.stamina.textContent = "5s " + (s.stamina5s ?? "--") + " / 1h " + (s.stamina1h ?? "--"), ui.safety.textContent = "LEAVE " + s.leaves + " / EVADE " + s.avoidances + " / WD " + s.watchdogStatus, ui.status.textContent = (IS_RAIDER_PROFILE ? "RAIDER" : "SCAVENGER") + " / " + (IS_RAIDER_PROFILE ? s.raidPhase || "idle" : "evade-loot") + " / BAL " + (s.balance ?? "--") + " / VALUE " + (s.value ?? "--") + " / NEAREST " + s.nearest + " / ROUTE " + (s.routeKind || "single") + ":" + (s.routeCount || 0) + " / SCORE " + (IS_RAIDER_PROFILE ? s.raidScore : s.targetScore) + (s.autoFireMode ? " / FIRE " + s.autoFireStatus : "") + " / WD " + s.watchdogStatus, runner.contractStatus && runner.contractStatus !== "READY" && (ui.status.textContent += " / 契约 " + runner.contractStatus + (runner.contractReason ? ":" + runner.contractReason : "")), ui.combat.classList.toggle("active", !!s.combatMode), ui.combat.textContent = s.combatMode ? "交战 ON" : "临时交战", ui.autoFire.classList.toggle("active", !!s.autoFireMode), ui.autoFire.textContent = s.autoFireMode ? "攻击 ON" : "自动攻击", ui.hunt.classList.toggle("active", !!s.huntMode), ui.hunt.textContent = s.huntMode ? "追杀 ON" : "追杀", ui.reconnect.classList.toggle("active", runner.autoReconnect !== !1), ui.reconnect.textContent = runner.autoReconnect !== !1 ? "重连 ON" : "重连 OFF";
        }
        function exportContractDiagnostics() {
          let rec = null, flow = null, mode = "NAVIGATE_ONLY";
          try {
            let bridge = typeof window < "u" && window.__crgrReconnect || null;
            if (bridge) {
              let leave = bridge.readLeave ? bridge.readLeave() : null, f = bridge.readFlow ? bridge.readFlow() : null, m = bridge.readConsentMode ? bridge.readConsentMode() : null;
              rec = leave ? { type: leave.type, enabled: !!leave.enabled, at: Number(leave.ts || 0) } : null, flow = f ? { phase: f.phase, type: f.type, attempt: Number(f.attempt || 0), lastError: f.lastError || null } : null, mode = m || "NAVIGATE_ONLY";
            }
          } catch {
          }
          return {
            contract: {
              status: runner.contractStatus || "UNKNOWN",
              fieldTypes: runner.contractReport || null,
              reason: runner.contractReason || ""
            },
            reconnect: {
              enabled: runner.autoReconnect !== !1,
              consentMode: mode,
              leave: rec,
              flow
            },
            page: { url: location.href.replace(/[?#].*$/, ""), title: document.title || "" }
          };
        }
        runner.start = start, runner.stop = stop, runner.destroy = destroy, runner.leave = (reason) => clickLeave(reason || "manual"), runner.setCombatMode = setCombatMode, runner.setHuntMode = setHuntMode, runner.setAutoFireMode = setAutoFireMode, runner.setManualTarget = setManualTarget, runner.clearManualTarget = clearManualTarget, runner.status = snapshot, runner.exportDiagnostics = exportContractDiagnostics, runner.clearReconnectState = () => {
          clearReconnectState(), push("已清理重连状态"), renderStatus();
        }, window.addEventListener("contextmenu", handleContextMenu, !0), window.addEventListener("keydown", handleMovementKeyDown, !0), window.addEventListener("keyup", handleMovementKeyUp, !0), window.addEventListener("blur", clearUserMoveKeys), ui.start.addEventListener("click", start), ui.stop.addEventListener("click", () => stop("manual")), ui.combat.addEventListener("click", toggleCombatMode), ui.autoFire.addEventListener("click", toggleAutoFireMode), ui.hunt.addEventListener("click", toggleHuntMode), ui.huntQuery.addEventListener("keydown", (event) => {
          event.key === "Enter" && (event.preventDefault(), setHuntMode(!0, "enter"));
        }), ui.leave.addEventListener("click", () => clickLeave("manual")), ui.reconnect.addEventListener("click", toggleReconnect), root.querySelector('[data-crgr="reconnect-clear"]').addEventListener("click", () => {
          clearReconnectState(), push("已清理重连状态"), renderStatus();
        }), root.querySelector('[data-crgr="reconnect-retry"]').addEventListener("click", retryReconnectOnce), ui.dropList.addEventListener("click", handleDropLeaderboardClick), ui.attackList.addEventListener("click", handleAttackListClick), ui.collapse.addEventListener("click", () => {
          root.classList.toggle("collapsed"), ui.collapse.textContent = root.classList.contains("collapsed") ? "SHOW" : "HUD";
        }), runner.statusTimer = window.setInterval(renderStatus, 500), runner.sidebarSafetyTimer = window.setInterval(checkHourlyStaminaLimitLeave, 1e3), runner.dropLeaderboardTimer = window.setInterval(renderDropLeaderboard, DROP_LEADERBOARD_REFRESH_MS), startLineLoop(), checkHourlyStaminaLimitLeave(), renderDropLeaderboard(), detectRejoinOnLoad(), renderStatus();
      }
    }
  })();
})();
