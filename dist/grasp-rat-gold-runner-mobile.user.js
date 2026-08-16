// ==UserScript==
// @name Grasp Rat Gold Runner Mobile
// @namespace https://grasp-rat-game.h-e.top/
// @version 0.1.7
// @description Mobile-focused Grasp Rat helper with long-press target, compact controls, hunt drawer, and fire lock drawer.
// @match https://grasp-rat-game.h-e.top/*
// @noframes
// @run-at document-end
// @grant unsafeWindow
// ==/UserScript==

(() => {
  // artifacts/prepared-mobile.user.js
  (function() {
    "use strict";
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
      let RUNNER_KEY = "__codexRatGoldRunnerMobile", PANEL_ID = "codex-rat-gold-runner-mobile-panel", DANGER_ID = "codex-rat-mobile-danger-vignette", MOVE_KEYS = ["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"];
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
        return diagonal / 35 + axis / 42;
      }
      function travelSeconds(fromX, fromY, toX, toY) {
        return Math.max(0.2, travelTicks(fromX, fromY, toX, toY) * 0.05);
      }
      function steerVector(rx, ry) {
        let ax = Math.abs(rx), ay = Math.abs(ry);
        return ax < 35 && ay < 35 ? { dx: 0, dy: 0, mode: "stop" } : ay < 35 || ax / Math.max(1, ay) >= 1.65 ? { dx: Math.sign(rx), dy: 0, mode: "x-axis" } : ax < 35 || ay / Math.max(1, ax) >= 1.65 ? { dx: 0, dy: Math.sign(ry), mode: "y-axis" } : { dx: Math.sign(rx), dy: Math.sign(ry), mode: "diagonal" };
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
        if (dist <= 12e3) return 1;
        if (dist >= 35e3) return 0.28;
        let t = (dist - 12e3) / 23e3;
        return 1 - (1 - 0.28) * t;
      }
      function routeLegSafetyFactor(fromX, fromY, toX, toY, threats) {
        let safety = minSegmentThreatDistance(fromX, fromY, toX, toY, threats);
        return safety < 22e3 ? 0 : safety >= 25e3 ? 1 : 0.55 + 0.45 * ((safety - 22e3) / 3e3);
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
      function contractPresent(value, expectation) {
        return typeof value > "u" || value === null || value === !1 ? !1 : expectation === "function" ? typeof value == "function" : expectation === "array" ? Array.isArray(value) : expectation === "Set-like" ? value && (value instanceof Set || typeof value.add == "function" || typeof value.has == "function" || typeof value.delete == "function") : expectation === "HTMLElement" ? typeof value == "object" && typeof value.getContext == "function" : expectation === "present" ? !0 : expectation === "object" ? typeof value == "object" && !Array.isArray(value) : !0;
      }
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
          '  <button type="button" class="crgr-edge-toggle crgr-edge-attack" data-crgr="attack-drawer-toggle">火控</button>',
          '  <button type="button" class="crgr-edge-toggle crgr-edge-hunt" data-crgr="hunt-drawer-toggle">追杀</button>',
          '  <button type="button" class="crgr-cancel-manual" data-crgr="cancel-manual">取消目标</button>',
          '  <aside class="crgr-drawer crgr-attack-lock" data-crgr="attack-drawer">',
          '    <div class="crgr-drawer-head"><strong>火控锁定</strong><button type="button" data-crgr="attack-drawer-close">收起</button></div>',
          '    <button type="button" class="crgr-auto-attack" data-crgr="auto-fire">自动攻击</button>',
          '    <div class="crgr-attack-head"><span>170m 目标</span><small data-crgr="attack-lock-summary">AUTO</small></div>',
          '    <div class="crgr-attack-list" data-crgr="attack-list"><button type="button" disabled>扫描中</button></div>',
          "  </aside>",
          '  <aside class="crgr-drawer crgr-hunt-drawer" data-crgr="hunt-drawer">',
          '    <div class="crgr-drawer-head"><strong>追杀列表</strong><button type="button" data-crgr="hunt-drawer-close">收起</button></div>',
          '    <div class="crgr-hunt-row">',
          '      <input data-crgr="hunt-query" placeholder="点用户名或输入片段" />',
          '      <button type="button" data-crgr="hunt">追杀</button>',
          "    </div>",
          '    <div class="crgr-hunt-list-head"><span>可追踪用户名</span><small data-crgr="drop-refresh">--</small></div>',
          '    <ol class="crgr-hunt-list" data-crgr="drop-list"><li>扫描中</li></ol>',
          "  </aside>",
          '  <div class="crgr-actions">',
          '    <button type="button" data-crgr="start">启动</button>',
          '    <button type="button" data-crgr="stop">停止</button>',
          '    <button type="button" data-crgr="combat">交战</button>',
          '    <button type="button" data-crgr="leave">离开</button>',
          "  </div>",
          "</div>"
        ].join(""), document.body.appendChild(root);
        let style = document.createElement("style");
        style.textContent = `
        #${PANEL_ID} {
          position: fixed;
          inset: 0;
          z-index: 2147483647;
          color: #e5edf8;
          font: 12px/1.25 "Microsoft YaHei", "Microsoft YaHei UI", "SimHei", Arial, sans-serif;
          pointer-events: none;
          text-shadow: none;
          -webkit-tap-highlight-color: transparent;
        }
        #${PANEL_ID} .crgr-frame {
          position: absolute;
          inset: 0;
          background: transparent;
          box-shadow: none;
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
        #${PANEL_ID} button,
        #${PANEL_ID} input {
          font: inherit;
          pointer-events: auto;
        }
        #${PANEL_ID} button {
          min-height: 34px;
          color: #eef6ff;
          background: rgba(8, 13, 24, .68);
          border: 1px solid rgba(226, 232, 240, .22);
          border-radius: 6px;
          cursor: pointer;
        }
        #${PANEL_ID} input {
          min-width: 0;
          height: 34px;
          padding: 0 9px;
          color: #f8fafc;
          background: rgba(8, 13, 24, .72);
          border: 1px solid rgba(226, 232, 240, .2);
          border-radius: 6px;
          outline: none;
        }
        #${PANEL_ID} .crgr-edge-toggle {
          position: fixed;
          top: calc(54px + env(safe-area-inset-top));
          z-index: 7;
          width: 48px;
          min-height: 30px;
          padding: 0 6px;
          color: #f8fafc;
          background: rgba(8, 13, 24, .76);
          border-color: rgba(250, 204, 21, .32);
          font-size: 11px;
          letter-spacing: 0;
        }
        #${PANEL_ID} .crgr-edge-attack { left: max(6px, env(safe-area-inset-left)); }
        #${PANEL_ID} .crgr-edge-hunt { right: max(6px, env(safe-area-inset-right)); }
        #${PANEL_ID}.attack-open .crgr-edge-attack,
        #${PANEL_ID}.hunt-open .crgr-edge-hunt {
          background: rgba(113, 63, 18, .86);
          border-color: rgba(250, 204, 21, .62);
        }
        #${PANEL_ID} .crgr-cancel-manual {
          display: none;
          position: fixed;
          top: calc(54px + env(safe-area-inset-top));
          right: calc(64px + env(safe-area-inset-right));
          z-index: 8;
          min-height: 30px;
          padding: 0 8px;
          color: #fef3c7;
          background: rgba(113, 63, 18, .86);
          border-color: rgba(250, 204, 21, .54);
          font-size: 11px;
        }
        #${PANEL_ID}.manual-target .crgr-cancel-manual { display: block; }
        #${PANEL_ID} .crgr-drawer {
          position: fixed;
          top: calc(90px + env(safe-area-inset-top));
          left: max(8px, env(safe-area-inset-left));
          right: max(8px, env(safe-area-inset-right));
          z-index: 5;
          width: auto;
          max-height: min(38vh, 260px);
          display: grid;
          align-content: start;
          gap: 6px;
          padding: 8px;
          color: rgba(241, 245, 249, .92);
          background: rgba(8, 13, 24, .82);
          border: 1px solid rgba(226, 232, 240, .16);
          border-radius: 7px;
          box-shadow: 0 10px 22px rgba(0, 0, 0, .28);
          pointer-events: auto;
          overflow: auto;
          opacity: 0;
          visibility: hidden;
          transform: translateY(-8px);
          transition: transform .16s ease, opacity .16s ease, visibility .16s ease;
        }
        #${PANEL_ID} .crgr-attack-lock {
          max-width: 360px;
        }
        #${PANEL_ID} .crgr-hunt-drawer {
          max-width: 390px;
        }
        #${PANEL_ID}.attack-open .crgr-attack-lock,
        #${PANEL_ID}.hunt-open .crgr-hunt-drawer {
          opacity: 1;
          visibility: visible;
          transform: translateY(0);
        }
        #${PANEL_ID} .crgr-drawer-head,
        #${PANEL_ID} .crgr-attack-head,
        #${PANEL_ID} .crgr-hunt-list-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
        }
        #${PANEL_ID} .crgr-drawer-head strong {
          color: #f8fafc;
          font-size: 13px;
        }
        #${PANEL_ID} .crgr-drawer-head button {
          min-height: 26px;
          padding: 0 7px;
          color: #cbd5e1;
        }
        #${PANEL_ID} .crgr-auto-attack {
          min-height: 30px;
          color: #bae6fd;
          border-color: rgba(56, 189, 248, .42);
        }
        #${PANEL_ID} .crgr-auto-attack.active {
          color: #ecfeff;
          background: rgba(8, 47, 73, .84);
        }
        #${PANEL_ID} .crgr-attack-head span,
        #${PANEL_ID} .crgr-hunt-list-head span {
          color: #fef3c7;
          font-size: 12px;
          font-weight: 700;
        }
        #${PANEL_ID} .crgr-attack-head small,
        #${PANEL_ID} .crgr-hunt-list-head small {
          min-width: 0;
          color: rgba(203, 213, 225, .78);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        #${PANEL_ID} .crgr-attack-list,
        #${PANEL_ID} .crgr-hunt-list {
          display: grid;
          gap: 4px;
          margin: 0;
          padding: 0;
          list-style: none;
        }
        #${PANEL_ID} .crgr-attack-list button,
        #${PANEL_ID} .crgr-hunt-list li {
          min-height: 30px;
          background: rgba(15, 23, 42, .52);
          border: 1px solid rgba(226, 232, 240, .12);
          border-radius: 5px;
        }
        #${PANEL_ID} .crgr-attack-list button {
          display: grid;
          grid-template-columns: minmax(0, 1fr) minmax(48px, auto) minmax(46px, auto);
          gap: 6px;
          align-items: center;
          padding: 0 8px;
          text-align: left;
        }
        #${PANEL_ID} .crgr-attack-list button.active {
          color: #fff7ed;
          background: rgba(127, 29, 29, .72);
          border-color: rgba(248, 113, 113, .56);
        }
        #${PANEL_ID} .crgr-attack-name,
        #${PANEL_ID} .crgr-hunt-name {
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
        #${PANEL_ID} .crgr-attack-dist,
        #${PANEL_ID} .crgr-hunt-meta {
          color: rgba(186, 230, 253, .78);
          text-align: right;
          font-variant-numeric: tabular-nums;
        }
        #${PANEL_ID} .crgr-hunt-row {
          display: grid;
          grid-template-columns: minmax(0, 1fr) 68px;
          gap: 5px;
        }
        #${PANEL_ID} .crgr-hunt-row input,
        #${PANEL_ID} .crgr-hunt-row button {
          height: 30px;
          min-height: 30px;
        }
        #${PANEL_ID} .crgr-hunt-list li {
          display: grid;
          grid-template-columns: minmax(0, 1fr) minmax(50px, auto) minmax(48px, auto);
          gap: 5px;
          align-items: center;
          padding: 0 7px;
        }
        #${PANEL_ID} .crgr-drop-name {
          min-width: 0;
          min-height: 28px;
          padding: 0 6px;
          color: #e0f2fe;
          text-align: left;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          background: transparent;
          border-color: transparent;
        }
        #${PANEL_ID} .crgr-drop-value {
          color: #fde68a;
          text-align: right;
          font-weight: 700;
          font-variant-numeric: tabular-nums;
        }
        #${PANEL_ID} .crgr-drop-dist {
          color: rgba(186, 230, 253, .78);
          text-align: right;
          font-variant-numeric: tabular-nums;
        }
        #${PANEL_ID} .crgr-actions {
          position: fixed;
          left: max(8px, env(safe-area-inset-left));
          right: max(8px, env(safe-area-inset-right));
          top: max(8px, env(safe-area-inset-top));
          z-index: 6;
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 6px;
          pointer-events: auto;
        }
        #${PANEL_ID} .crgr-actions button {
          min-height: 38px;
          padding: 0 4px;
          font-size: 12px;
          font-weight: 700;
        }
        #${PANEL_ID} button[data-crgr="start"] { color: #bbf7d0; border-color: rgba(74, 222, 128, .45); }
        #${PANEL_ID} button[data-crgr="stop"] { color: #fde68a; border-color: rgba(251, 191, 36, .45); }
        #${PANEL_ID} button[data-crgr="combat"] { color: #fecaca; border-color: rgba(248, 113, 113, .42); }
        #${PANEL_ID} button[data-crgr="combat"].active {
          color: #fff7ed;
          background: rgba(127, 29, 29, .78);
        }
        #${PANEL_ID} button[data-crgr="hunt"].active {
          color: #fffbeb;
          background: rgba(113, 63, 18, .78);
        }
        #${PANEL_ID} button[data-crgr="leave"] { color: #fecaca; border-color: rgba(248, 113, 113, .55); }
        #${DANGER_ID} {
          position: fixed;
          inset: 0;
          z-index: 2147483646;
          pointer-events: none;
          opacity: 0;
          transition: opacity .18s ease;
          box-shadow:
            inset 0 0 0 2px rgba(248, 113, 113, .32),
            inset 0 0 42px 14px rgba(127, 29, 29, .34),
            inset 0 0 94px 34px rgba(69, 10, 10, .3);
        }
        #${DANGER_ID}.active {
          opacity: 1;
          animation: crgr-mobile-danger-pulse 1.1s ease-in-out infinite;
        }
        #${DANGER_ID}.critical {
          opacity: 1;
          animation: crgr-mobile-danger-critical .58s ease-in-out infinite;
        }
        @keyframes crgr-mobile-danger-pulse {
          0%, 100% { box-shadow: inset 0 0 0 2px rgba(248, 113, 113, .24), inset 0 0 36px 12px rgba(127, 29, 29, .24), inset 0 0 82px 28px rgba(69, 10, 10, .2); }
          50% { box-shadow: inset 0 0 0 3px rgba(248, 113, 113, .58), inset 0 0 64px 24px rgba(127, 29, 29, .52), inset 0 0 128px 48px rgba(69, 10, 10, .46); }
        }
        @keyframes crgr-mobile-danger-critical {
          0%, 100% { box-shadow: inset 0 0 0 3px rgba(248, 113, 113, .36), inset 0 0 78px 28px rgba(127, 29, 29, .46), inset 0 0 150px 60px rgba(69, 10, 10, .42); }
          50% { box-shadow: inset 0 0 0 5px rgba(248, 113, 113, .76), inset 0 0 116px 46px rgba(127, 29, 29, .68), inset 0 0 220px 92px rgba(69, 10, 10, .58); }
        }
      `, document.head.appendChild(style);
        let danger = document.createElement("div");
        danger.id = DANGER_ID, document.body.appendChild(danger);
        let ui = {
          huntQuery: root.querySelector('[data-crgr="hunt-query"]'),
          hunt: root.querySelector('[data-crgr="hunt"]'),
          attackLockSummary: root.querySelector('[data-crgr="attack-lock-summary"]'),
          attackList: root.querySelector('[data-crgr="attack-list"]'),
          attackDrawer: root.querySelector('[data-crgr="attack-drawer"]'),
          attackDrawerToggle: root.querySelector('[data-crgr="attack-drawer-toggle"]'),
          attackDrawerClose: root.querySelector('[data-crgr="attack-drawer-close"]'),
          huntDrawer: root.querySelector('[data-crgr="hunt-drawer"]'),
          huntDrawerToggle: root.querySelector('[data-crgr="hunt-drawer-toggle"]'),
          huntDrawerClose: root.querySelector('[data-crgr="hunt-drawer-close"]'),
          cancelManual: root.querySelector('[data-crgr="cancel-manual"]'),
          lineCanvas: root.querySelector('[data-crgr="line-canvas"]'),
          dropRefresh: root.querySelector('[data-crgr="drop-refresh"]'),
          dropList: root.querySelector('[data-crgr="drop-list"]'),
          start: root.querySelector('[data-crgr="start"]'),
          stop: root.querySelector('[data-crgr="stop"]'),
          combat: root.querySelector('[data-crgr="combat"]'),
          autoFire: root.querySelector('[data-crgr="auto-fire"]'),
          leave: root.querySelector('[data-crgr="leave"]')
        };
        function updateHudSceneBounds() {
          root.style.setProperty("--crgr-scene-left", "0px");
        }
        function setMobileDrawer(name) {
          let next = name === "attack" || name === "hunt" ? name : "";
          root.classList.toggle("attack-open", next === "attack"), root.classList.toggle("hunt-open", next === "hunt");
        }
        function toggleMobileDrawer(name) {
          let alreadyOpen = root.classList.contains(name + "-open");
          setMobileDrawer(alreadyOpen ? "" : name);
        }
        updateHudSceneBounds(), window.addEventListener("resize", updateHudSceneBounds);
        let runner = {
          running: !1,
          timer: 0,
          statusTimer: 0,
          sidebarSafetyTimer: 0,
          dropLeaderboardTimer: 0,
          lineRaf: 0,
          lineCtx: ui.lineCanvas ? ui.lineCanvas.getContext("2d") : null,
          lineDpr: 1,
          tickMs: 150,
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
          // §6.4:统计的是"计划发数"。
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
          lastBalance: null,
          deltaBalance: 0,
          leaves: 0,
          avoidances: 0,
          // §5.9: 规避计数按"事件"而非 tick。
          fleeing: !1,
          fleeKey: "",
          hourlyLimitLeaveTriggered: !1,
          lastThreat: null,
          enemyMotion: /* @__PURE__ */ new Map(),
          projectileMotion: /* @__PURE__ */ new Map(),
          lastAction: "ready",
          lastError: "",
          log: [],
          root,
          danger,
          style
        };
        window[RUNNER_KEY] = runner;
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
          runner.huntMode && setHuntMode(!1, "长按坐标接管"), runner.manualTarget = {
            x: Math.round(Number(x)),
            y: Math.round(Number(y)),
            setAt: Date.now()
          }, clearCoinRoute(), runner.planNextAt = 0, push("长按坐标目标 " + runner.manualTarget.x + "," + runner.manualTarget.y), runner.running || start(), renderStatus();
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
          runner.routeIds = ids.map((id) => idKey(id)), runner.targetId = idKey(route.target.drop_id), runner.targetScore = Number(route.score) || 0, runner.routeScore = runner.targetScore, runner.routeValue = Number(route.value) || 0, runner.routeTravelSeconds = Number(route.travelSeconds) || 0, runner.routeKind = route.kind || "", runner.routeAdvanced = !1, runner.planNextAt = Date.now() + 1800;
        }
        function clearHuntTarget() {
          runner.huntTargetId = null, runner.huntTargetName = "", runner.huntLastSeen = null, runner.huntLastSeenAt = 0;
        }
        function setHuntMode(active, reason) {
          let next = !!active, query = huntQueryText();
          if (next && !query) {
            runner.lastAction = "追杀：请输入用户名片段", renderStatus();
            return;
          }
          runner.huntMode === next && (!next || runner.huntQuery === query) || (runner.huntMode = next, runner.huntQuery = next ? query : "", clearHuntTarget(), clearCoinRoute(), runner.planNextAt = 0, next ? (runner.manualTarget && clearManualTarget("开启自动追杀"), push("自动追杀已开启：用户名包含 " + query), runner.running || start()) : (runner.navTarget && runner.navTarget.type === "hunt" && (runner.navTarget = null), push("自动追杀已关闭" + (reason ? "：" + reason : ""))), renderLines(), renderStatus());
        }
        function toggleHuntMode() {
          setHuntMode(!runner.huntMode, "manual");
        }
        function driveManualTarget(me, label, options) {
          if (!runner.manualTarget) return !1;
          let manual = manualMoveVector();
          if (options && options.respectUserInput && manual.active)
            return clearScriptMoveKeys(!0), runner.combatManualOverride = !0, runner.lastMoveMode = "manual-combat", runner.lastAction = (label || "手动") + "：WASD 接管，长按坐标保留 " + runner.manualTarget.x + "," + runner.manualTarget.y, !0;
          let rx = Number(runner.manualTarget.x) - Number(me.x), ry = Number(runner.manualTarget.y) - Number(me.y), dist = Math.hypot(rx, ry);
          return dist <= 160 ? (stopMove(), clearManualTarget("已到达"), !0) : (moveToward(rx, ry, options && options.preserveUser ? { preserveUser: !0 } : void 0), setNavigationTarget(runner.manualTarget.x, runner.manualTarget.y, "manual"), runner.lastAction = (label || "前往") + "长按坐标 " + runner.manualTarget.x + "," + runner.manualTarget.y + "，距离 " + Math.round(dist), clearCoinRoute(), !0);
        }
        let LONG_PRESS_MS = 620, LONG_PRESS_MOVE_PX = 14, longPressTimer = 0, longPressStart = null;
        function isRunnerUiTarget(target) {
          return !!(target && root.contains(target));
        }
        function isWorldPointerTarget(target) {
          if (!target || isRunnerUiTarget(target)) return !1;
          let worldCanvas = worldCanvasElement();
          return worldCanvas ? target === worldCanvas || worldCanvas.contains && worldCanvas.contains(target) : !0;
        }
        function clearLongPressTimer() {
          longPressTimer && (window.clearTimeout(longPressTimer), longPressTimer = 0), longPressStart = null;
        }
        function setManualTargetFromClient(clientX, clientY, source) {
          try {
            typeof setPointerFromClient == "function" && setPointerFromClient(clientX, clientY);
            let point = state.pointerWorld;
            if (!point || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y)))
              throw new Error("pointerWorld unavailable");
            setManualTarget(point.x, point.y), runner.lastLongPressAt = Date.now(), push((source || "长按") + "选点 " + Math.round(Number(point.x)) + "," + Math.round(Number(point.y))), renderStatus();
          } catch (err) {
            runner.lastError = "长按坐标读取失败：" + String(err && err.message || err), push(runner.lastError), renderStatus();
          }
        }
        function handlePointerDown(event) {
          !event || event.isPrimary === !1 || event.button !== void 0 && event.button !== 0 || isWorldPointerTarget(event.target) && (clearLongPressTimer(), longPressStart = {
            pointerId: event.pointerId,
            x: Number(event.clientX),
            y: Number(event.clientY)
          }, longPressTimer = window.setTimeout(() => {
            if (!longPressStart) return;
            let point = longPressStart;
            clearLongPressTimer(), setManualTargetFromClient(point.x, point.y, "长按");
          }, LONG_PRESS_MS));
        }
        function handlePointerMove(event) {
          if (!longPressStart || event.pointerId !== longPressStart.pointerId) return;
          Math.hypot(Number(event.clientX) - longPressStart.x, Number(event.clientY) - longPressStart.y) > LONG_PRESS_MOVE_PX && clearLongPressTimer();
        }
        function handlePointerUp(event) {
          (!longPressStart || event.pointerId === longPressStart.pointerId) && clearLongPressTimer();
        }
        function handleContextMenu(event) {
          isWorldPointerTarget(event.target) && event.preventDefault();
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
            let last = runner.enemyMotion.get(key), moved = last && Math.hypot(x - last.x, y - last.y) >= 30, dt = last ? Math.max(0, (now - last.lastSeenAt) / 1e3) : 0, vxCmps = last && dt >= 0.05 ? (x - last.x) / dt : last && last.vxCmps || 0, vyCmps = last && dt >= 0.05 ? (y - last.y) / dt : last && last.vyCmps || 0;
            runner.enemyMotion.set(key, {
              x,
              y,
              vxCmps,
              vyCmps,
              lastSeenAt: now,
              lastMovedAt: moved ? now : last ? last.lastMovedAt : 0
            });
          }
          for (let [key, value] of runner.enemyMotion)
            !seen.has(key) && now - value.lastSeenAt > 1e4 * 3 && runner.enemyMotion.delete(key);
        }
        function enemyMovedRecently(enemy, now) {
          let motion = runner.enemyMotion.get(enemyKey(enemy));
          return !!motion && motion.lastMovedAt > 0 && now - motion.lastMovedAt <= 1e4;
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
            let name = state.userNames.get(id) || state.userNames.get(String(userId));
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
        function leaderboardPointForUser(userId) {
          let id = Number(userId);
          if (!Number.isFinite(id)) return null;
          let entity = (state.entities || []).find((item) => Number(item && item.user_id) === id);
          if (entity && Number.isFinite(Number(entity.x)) && Number.isFinite(Number(entity.y)))
            return {
              x: Number(entity.x),
              y: Number(entity.y)
            };
          let point = (state.minimap && Array.isArray(state.minimap.points) ? state.minimap.points : []).find((item) => Number(item && (item.u ?? item.user_id)) === id);
          return point && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y)) ? {
            x: Number(point.x),
            y: Number(point.y)
          } : null;
        }
        function formatLeaderboardDistance(me, row) {
          let point = leaderboardPointForUser(row && row.userId), mx = Number(me && me.x), my = Number(me && me.y);
          return !point || !Number.isFinite(mx) || !Number.isFinite(my) ? "--" : Math.round(Math.hypot(point.x - mx, point.y - my) / 100) + "m";
        }
        function renderDropLeaderboard() {
          if (!ui.dropList || !ui.dropRefresh) return;
          let me = getMe(), rows = topDropUsers(), fragment = document.createDocumentFragment();
          if (rows.length)
            rows.forEach((row) => {
              let item = document.createElement("li"), name = document.createElement("button"), drop = document.createElement("span"), dist = document.createElement("span");
              name.type = "button", name.className = "crgr-drop-name crgr-hunt-name", name.textContent = row.name, name.title = row.copyName ? "点击填入追杀用户名" : "未识别到真实用户名", row.copyName ? name.dataset.copyName = row.copyName : name.disabled = !0, drop.className = "crgr-drop-value", drop.textContent = String(Math.round(row.drop)), dist.className = "crgr-drop-dist crgr-hunt-meta", dist.textContent = formatLeaderboardDistance(me, row), item.appendChild(name), item.appendChild(drop), item.appendChild(dist), fragment.appendChild(item);
            });
          else {
            let item = document.createElement("li");
            item.textContent = "暂无 Drop 数据", fragment.appendChild(item);
          }
          ui.dropList.replaceChildren(fragment), ui.dropRefresh.textContent = "更新 " + formatClock(Date.now());
        }
        function handleDropLeaderboardClick(event) {
          let button = event.target && event.target.closest ? event.target.closest(".crgr-drop-name") : null;
          if (!button || !ui.dropList || !ui.dropList.contains(button) || !button.dataset.copyName) return;
          let name = button.dataset.copyName;
          ui.huntQuery && (ui.huntQuery.value = name), runner.huntQuery = name, setMobileDrawer("hunt"), runner.lastAction = "已填入追杀用户名：" + name, renderStatus();
        }
        function renderAttackLockList(me) {
          if (!ui.attackList || !ui.attackLockSummary) return;
          let locked = me ? lockedAttackTarget(me) : null;
          if (locked) {
            let rangeText = locked.dist <= 15e3 ? "射程内" : "视野内";
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
            1300,
            Math.max(350, dist / 9e3 * 1e3)
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
          return liveEnemies(me, 17e3).map(decorateAttackEnemy).filter(Boolean).sort((a, b) => a.dist - b.dist);
        }
        function visibleAttackTargetById(me, userId) {
          let id = idKey(userId);
          if (!id) return null;
          let target = liveEnemies(me, 5e4).find((enemy) => idKey(enemy.user_id) === id);
          return decorateAttackEnemy(target);
        }
        function burstTargetStillValid(me, enemy) {
          if (!enemy || enemy.user_id == null) return !1;
          let fresh = visibleAttackTargetById(me, enemy.user_id);
          if (!fresh || fresh === null || fresh.life !== "Alive") return !1;
          let hp = Number(fresh.hp || 0);
          return !(!Number.isFinite(hp) || hp <= 0);
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
          return target ? (runner.attackLockName = target.displayName || runner.attackLockName, runner.attackLockStatus = target.dist <= 15e3 ? "LOCK" : "LOCK-OUT", {
            ...target,
            locked: !0,
            inFireRange: target.dist <= 15e3
          }) : (clearAttackLock("目标离开500m视野或已不存活"), null);
        }
        function richEnemies(me, limitCm) {
          return liveEnemies(me, limitCm).filter((entity) => entity.dropForAvoid > 10).sort((a, b) => a.dist - b.dist);
        }
        function escapeEnemies(me, limitCm) {
          return liveEnemies(me, limitCm).filter((entity) => entity.dropForAvoid > 10 || entity.dropForAvoid <= 10 && entity.movedRecently).sort((a, b) => a.dist - b.dist);
        }
        function combatEnemies(me) {
          return liveEnemies(me, 17e3).map((enemy) => ({
            ...enemy,
            hpForCombat: numberFrom(enemy, ["hp", "health", "life_value", "current_hp"], 0)
          }));
        }
        function combatSpacingEnemies(me) {
          return liveEnemies(me, 19e3);
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
              !Number.isFinite(dist) || dist > 36e3 || (runner.projectileMotion.set(key, {
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
            !seen.has(key) && now - value.seenAt > 1800 && runner.projectileMotion.delete(key);
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
          return distance < 1e4 ? { state: "too-close", distance } : distance > 15e3 ? { state: "too-far", distance } : { state: "band", distance };
        }
        function combatRangeError(dist) {
          return Number.isFinite(dist) ? dist < 8500 ? (1e4 - dist) * 1.8 + (8500 - dist) * 3.2 + 4200 : dist < 1e4 ? (1e4 - dist) * 1.8 + 900 : dist > 15e3 ? (dist - 15e3) * 0.72 : Math.abs(dist - 12500) * 0.16 : 0;
        }
        function combatSpacingScore(me, dir, enemies) {
          if (!enemies || !enemies.length) return 0;
          let next = {
            x: Number(me.x) + dir.dx * 1300,
            y: Number(me.y) + dir.dy * 1300
          }, score = 0;
          return enemies.slice(0, 3).forEach((enemy, index) => {
            let currentDist = Number(enemy.dist), nextDist = Math.hypot(next.x - Number(enemy.x), next.y - Number(enemy.y));
            if (!Number.isFinite(currentDist) || !Number.isFinite(nextDist)) return;
            let weight = index === 0 ? 1 : index === 1 ? 0.48 : 0.26, improvement = combatRangeError(currentDist) - combatRangeError(nextDist);
            score += improvement * weight / 13, nextDist < 8500 ? score -= (720 + (8500 - nextDist) / 12) * weight : nextDist < 1e4 ? score -= (310 + (1e4 - nextDist) / 24) * weight : nextDist <= 15e3 ? score += (190 - Math.abs(nextDist - 12500) / 44) * weight : score -= Math.min(180, (nextDist - 15e3) / 42) * weight, currentDist < 1e4 && nextDist < currentDist - 80 && (score -= 420 * weight), currentDist > 15e3 && nextDist > currentDist + 80 && (score -= 210 * weight);
          }), score;
        }
        function scoreCombatDirection(me, dir, projectiles, spacingEnemies, options) {
          let horizons = [0.25, 0.5, 0.85, 1.2], score = 0;
          for (let seconds of horizons) {
            let point = {
              x: Number(me.x) + dir.dx * 1300 * seconds,
              y: Number(me.y) + dir.dy * 1300 * seconds
            };
            for (let projectile of projectiles)
              score -= projectileRisk(projectile, point, seconds);
          }
          let spacingWeight = options && Number.isFinite(options.spacingWeight) ? options.spacingWeight : 1;
          score += combatSpacingScore(me, dir, spacingEnemies) * spacingWeight;
          let last = runner.lastCombatDodge || { dx: 0, dy: 0 };
          return dir.dx === last.dx && dir.dy === last.dy ? score += projectiles.length ? 180 : 90 : (score -= Date.now() - runner.lastCombatSwitchAt < 650 ? 210 : 70, dir.dx === -last.dx && dir.dy === -last.dy && (score -= 180)), score;
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
            spacingWeight: combatProjectilePressure(projectiles, me) >= 520 || projectiles.some((projectile) => projectile.dist < 1e4) ? 0.42 : projectiles.length ? 0.86 : 1.35
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
          if ((best.dx !== last.dx || best.dy !== last.dy) && Date.now() - runner.lastCombatSwitchAt < 650) {
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
          return locked || liveEnemies(me, 15e3).map(decorateAttackEnemy).filter((enemy) => Number.isFinite(enemy.hpForFire) && enemy.hpForFire > 0).sort((a, b) => a.hpForFire - b.hpForFire || a.dist - b.dist || String(a.user_id).localeCompare(String(b.user_id)))[0] || null;
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
          return Number.isFinite(observed) ? observed : 1e4;
        }
        function interceptLeadSeconds2(me, target, velocity, projectileSpeed) {
          let rx = Number(target.x) - Number(me.x), ry = Number(target.y) - Number(me.y), vx = Number(velocity.vx) || 0, vy = Number(velocity.vy) || 0, speed = Math.max(1, Number(projectileSpeed) || 1e4), a = vx * vx + vy * vy - speed * speed, b = 2 * (rx * vx + ry * vy), c = rx * rx + ry * ry, lead = Math.sqrt(c) / speed;
          if (Math.abs(a) > 1e-3) {
            let disc = b * b - 4 * a * c;
            if (disc >= 0) {
              let root2 = Math.sqrt(disc), t1 = (-b - root2) / (2 * a), t2 = (-b + root2) / (2 * a), positive = [t1, t2].filter((value) => Number.isFinite(value) && value > 0).sort((x, y) => x - y)[0];
              Number.isFinite(positive) && (lead = positive);
            }
          } else if (Math.abs(b) > 1e-3) {
            let linear = -c / b;
            Number.isFinite(linear) && linear > 0 && (lead = linear);
          }
          return Math.min(1150 / 1e3, Math.max(60 / 1e3, lead));
        }
        function randomBetween(min, max) {
          return min + Math.random() * (max - min);
        }
        function randomInt(min, max) {
          return Math.floor(randomBetween(min, max + 1));
        }
        function predictedAutoFirePoint(me, target, extraLeadSeconds, offset) {
          let velocity = entityVelocityCmps(target, target.user_id), projectileSpeed = autoFireProjectileSpeedCmps(), totalLeadSeconds = interceptLeadSeconds2(me, target, velocity, projectileSpeed) + Math.max(0, Number(extraLeadSeconds) || 0), ox = Number(offset && offset.x) || 0, oy = Number(offset && offset.y) || 0;
          return {
            x: Number(target.x) + velocity.vx * totalLeadSeconds + ox,
            y: Number(target.y) + velocity.vy * totalLeadSeconds + oy,
            leadMs: Math.round(totalLeadSeconds * 1e3),
            projectileSpeed,
            targetSpeed: Math.hypot(velocity.vx, velocity.vy)
          };
        }
        function autoFireBurstCooldownMs(me, target, shots) {
          let stamina = Number(me && me.stamina_5s_remaining_milli), ratio = Number.isFinite(stamina) ? Math.max(0, Math.min(1, stamina / 1e4)) : 0.5, farBias = target && Number(target.dist) > 11e3 ? -80 : 0, shotBias = Math.max(0, Number(shots) - 5) * 24;
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
          let freshTarget = visibleAttackTargetById(me, target.user_id) || target, extraLeadSeconds = Math.max(0, Number(shotIndex) || 0) * 100 / 1e3;
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
          let stamina = finiteStaminaMs(me && me.stamina_5s_remaining_milli);
          if (stamina == null)
            return runner.autoFireStatus = "体力未知·不发射", !1;
          let shots = randomInt(5, 8), affordable = Math.max(0, Math.floor(stamina / 500) - 2);
          if (affordable < 5)
            return runner.autoFireStatus = "体力不足(整组预算)", !1;
          shots = Math.min(shots, affordable);
          let offsets = autoFireCoverageOffsets(me, target, shots), firstClient = autoFireBurstClient(me, target, offsets[0], 0);
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
            }, i * 100);
          let holdMs = shots * 100 + randomBetween(55, 130);
          return scheduleAutoFireBurst(() => {
            let releaseClient = runner.autoFireBurstClient || firstClient;
            dispatchAutoFireMouse(releaseClient, "mouseup", 0), dispatchAutoFireMouse(releaseClient, "click", 0), runner.autoFireBursting = !1, runner.autoFireBurstClient = null, runner.autoFireNextBurstAt = Date.now() + autoFireBurstCooldownMs(getMe() || me, target, shots), runner.autoFireStatus = "连发完成 " + shots + " 发，等待下一组", renderStatus();
          }, holdMs), !0;
        }
        function handleAutoFire(me) {
          if (!runner.autoFireMode) return !1;
          if (runner.autoFireBursting)
            return !0;
          if (!me || me.life !== "Alive" || Number(me.hp || 0) <= 9)
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
          return minDistanceToEntities(x, y, enemies);
        }
        function dropClusterValue(drop, candidates, radius, weight) {
          let scanRadius = radius || 9e3, valueWeight = weight ?? 0.65, sum = 0;
          for (let other of candidates || []) {
            if (idKey(other.drop_id) === idKey(drop.drop_id)) continue;
            let dist = Math.hypot(Number(other.x) - Number(drop.x), Number(other.y) - Number(drop.y));
            dist > scanRadius || (sum += dropAmount(other) * (1 - dist / scanRadius) * valueWeight);
          }
          return sum;
        }
        function scoreDrop(drop, me, threats, candidates) {
          let amount = dropAmount(drop), seconds = travelSeconds(Number(me.x), Number(me.y), Number(drop.x), Number(drop.y)), firstLeg = Math.hypot(Number(drop.x) - Number(me.x), Number(drop.y) - Number(me.y)), cluster = dropClusterValue(drop, candidates), safety = minSegmentThreatDistance(Number(me.x), Number(me.y), Number(drop.x), Number(drop.y), threats);
          if (safety < 22e3) return -1 / 0;
          let safetyFactor = safety < 25e3 ? 0.55 + 0.45 * ((safety - 22e3) / 3e3) : 1, sameTargetBias = idKey(drop.drop_id) === runner.targetId ? 1.12 : 1;
          return (amount + cluster) / (seconds + 1.6) * safetyFactor * sameTargetBias * routeFirstLegPreferFactor(firstLeg);
        }
        function routeClusterStats(drop, candidates) {
          let count = 0, amount = 0, weighted = 0;
          for (let other of candidates) {
            if (idKey(other.drop_id) === idKey(drop.drop_id)) continue;
            let dist = Math.hypot(Number(other.x) - Number(drop.x), Number(other.y) - Number(drop.y));
            if (dist > 13e3) continue;
            let value = dropAmount(other);
            count += 1, amount += value, weighted += value * (1 - dist / 13e3);
          }
          return { count, amount, weighted };
        }
        function isCoinBlacklisted(id) {
          let until = runner.coinBlacklist.get(idKey(id));
          return until == null ? !1 : until <= Date.now() ? (runner.coinBlacklist.delete(idKey(id)), !1) : !0;
        }
        function coinCandidates(me, enemies) {
          let threats = enemies || richEnemies(me, 25e3), candidates = (Array.isArray(state.coinDrops) ? state.coinDrops : []).map((drop) => {
            let amountValue = readDropAmount(drop);
            return {
              ...drop,
              amountValue,
              dist: Math.hypot(Number(drop.x) - Number(me.x), Number(drop.y) - Number(me.y)),
              richEnemyDist: minRichEnemyDistanceAt(Number(drop.x), Number(drop.y), threats)
            };
          }).filter((drop) => drop.amountValue !== null && !isCoinBlacklisted(drop.drop_id) && Number.isFinite(drop.dist) && Number.isFinite(Number(drop.x)) && Number.isFinite(Number(drop.y))), safeBase = threats.length ? candidates.filter((drop) => drop.richEnemyDist >= 22e3) : candidates;
          return safeBase.map((drop) => ({
            ...drop,
            score: scoreDrop(drop, me, threats, safeBase),
            routeCluster: routeClusterStats(drop, safeBase)
          })).filter((drop) => Number.isFinite(drop.score));
        }
        function routeLimitForAnchor(anchor) {
          let count = anchor && anchor.routeCluster ? anchor.routeCluster.count : 0;
          return count >= 7 ? 6 : count >= 3 ? 4 : count >= 1 ? 2 : 1;
        }
        function routeStepScore(drop, currentX, currentY, prevDx, prevDy, remaining, threats, linkLimit) {
          let dx = Number(drop.x) - currentX, dy = Number(drop.y) - currentY, legDist = Math.hypot(dx, dy), allowLongValue = drop.amountValue >= 10 && legDist <= 22e3;
          if (legDist > linkLimit && !allowLongValue) return null;
          let safetyFactor = routeLegSafetyFactor(currentX, currentY, Number(drop.x), Number(drop.y), threats);
          if (safetyFactor <= 0) return null;
          let seconds = travelSeconds(currentX, currentY, Number(drop.x), Number(drop.y)), localCluster = Math.min(drop.amountValue * 2.4, dropClusterValue(drop, remaining, 13e3, 0.38)), turnFactor = routeTurnFactor(prevDx, prevDy, dx, dy), score = (drop.amountValue + localCluster) / (seconds + 0.75) * safetyFactor * turnFactor;
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
          let maxPoints = routeLimitForAnchor(anchor), linkLimit = anchor.routeCluster.count >= 5 ? 22e3 : 15e3, remaining = new Map(candidates.map((drop) => [idKey(drop.drop_id), drop])), route = [], currentX = Number(me.x), currentY = Number(me.y), prevDx = 0, prevDy = 0, totalValue = 0, totalSeconds = 0, totalLegCm = 0, minSafetyFactor = 1;
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
          ), countBonus = 1 + Math.min(0.18, (route.length - 1) * 0.045), sameRouteBias = ids[0] === runner.targetId ? 1.08 : 1, kind = route.length >= 3 ? "cluster" : route.length === 2 ? "pair" : "single", lengthFactorBase = 1 - 18e-6 * Math.max(0, totalLegCm - 3e4), lengthFactor = Math.max(0.5, lengthFactorBase), firstLegCm = route.length ? Math.hypot(Number(route[0].x) - Number(me.x), Number(route[0].y) - Number(me.y)) : 0, firstLegFactor = routeFirstLegPreferFactor(firstLegCm), score = (totalValue + densityBonus) / (totalSeconds + 1.4) * minSafetyFactor * countBonus * sameRouteBias * lengthFactor * firstLegFactor;
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
          return uniqueDrops(groups, 22);
        }
        function bestDropRoute(me, enemies) {
          let threats = enemies || richEnemies(me, 25e3), candidates = coinCandidates(me, threats);
          if (!candidates.length) return null;
          let bySingleAll = [...candidates].sort((a, b) => b.score - a.score || a.dist - b.dist), bySingle = bySingleAll.slice(0, 12), byCluster = [...candidates].sort(
            (a, b) => (b.amountValue + b.routeCluster.weighted) / (travelSeconds(Number(me.x), Number(me.y), Number(b.x), Number(b.y)) + 1.4) - (a.amountValue + a.routeCluster.weighted) / (travelSeconds(Number(me.x), Number(me.y), Number(a.x), Number(a.y)) + 1.4) || a.dist - b.dist
          ), byNearAll = [...candidates].sort((a, b) => a.dist - b.dist), byAmountAll = [...candidates].sort((a, b) => b.amountValue - a.amountValue || a.dist - b.dist), byNear = byNearAll.slice(0, 6), byAmount = byAmountAll.slice(0, 6), current = runner.targetId ? candidates.filter((drop) => idKey(drop.drop_id) === runner.targetId) : [], routePool = uniqueDrops([
            current,
            bySingleAll.slice(0, 36),
            byCluster.slice(0, 36),
            byNearAll.slice(0, 18),
            byAmountAll.slice(0, 18)
          ], 72), anchors = uniqueAnchors([current, bySingle, byCluster, byNear, byAmount]), best = null;
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
            return minRichEnemyDistanceAt(Number(target.x), Number(target.y), threats) < 22e3 ? (clearCoinRoute(), null) : (runner.targetId = id, {
              ...target,
              amountValue: dropAmount(target),
              dist: Math.hypot(Number(target.x) - Number(me.x), Number(target.y) - Number(me.y)),
              score: runner.targetScore
            });
          }
          if (runner.targetId) {
            let target = drops.find((drop) => idKey(drop.drop_id) === runner.targetId);
            return !target || isCoinBlacklisted(target.drop_id) || minRichEnemyDistanceAt(Number(target.x), Number(target.y), threats) < 22e3 ? (clearCoinRoute(), null) : {
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
        function fleeFrom(enemy, me, reason, urgent) {
          let rx = Number(me.x) - Number(enemy.x), ry = Number(me.y) - Number(enemy.y);
          moveToward(rx || 1, ry);
          let length = Math.max(1, Math.hypot(rx, ry));
          setNavigationTarget(
            Number(me.x) + (rx || 1) / length * 12e3,
            Number(me.y) + ry / length * 12e3,
            "evade"
          ), setDanger(urgent), clearCoinRoute();
          let fleeKey = String(enemy.user_id || "");
          (!runner.fleeing || runner.fleeKey && runner.fleeKey !== fleeKey) && (runner.avoidances += 1), runner.fleeing = !0, runner.fleeKey = fleeKey, runner.lastThreat = {
            name: enemy.name || "User " + enemy.user_id,
            drop: enemy.dropForAvoid,
            dist: Math.round(enemy.dist)
          }, runner.lastAction = reason + "：" + runner.lastThreat.name + " 距离 " + runner.lastThreat.dist + "cm Drop " + runner.lastThreat.drop;
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
          else if (runner.huntLastSeen && now - runner.huntLastSeenAt <= 12e3)
            point = {
              x: Number(runner.huntLastSeen.predictedX || runner.huntLastSeen.x),
              y: Number(runner.huntLastSeen.predictedY || runner.huntLastSeen.y),
              leadMs: 0,
              speed: 0
            }, label = runner.huntLastSeen.name + " #" + runner.huntLastSeen.userId, source = "记忆", distToEntity = Math.hypot(point.x - Number(me.x), point.y - Number(me.y));
          else
            return clearHuntTarget(), stopMove(), clearCoinRoute(), runner.lastAction = "追杀：未找到匹配用户名 " + query, !0;
          let rx = Number(point.x) - Number(me.x), ry = Number(point.y) - Number(me.y), dist = Math.hypot(rx, ry);
          return clearCoinRoute(), setDanger(!1), setNavigationTarget(point.x, point.y, "hunt"), Number.isFinite(dist) ? dist <= 260 ? (stopMove(), runner.lastAction = "追杀：" + label + " 已贴近，保持观察", !0) : (moveToward(rx, ry), runner.lastAction = "追杀：" + label + " / " + source + " / 距离 " + Math.round(distToEntity || dist) + " / 预判 " + Math.round(point.leadMs || 0) + "ms", !0) : (stopMove(), runner.lastAction = "追杀：" + label + " 坐标异常", !0);
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
          let shortSide = Math.max(1, Math.min(rect.width, rect.height)), viewRadius = Number(state.viewRadiusCm), units = Number.isFinite(viewRadius) && viewRadius > 0 ? viewRadius * 2 / shortSide : 5e4 * 2 / shortSide, origin = gameScreenCenter2(rect), camera = gameCameraCenter2(me);
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
          let width = Math.max(1, Math.round(rootRect.width)), height = Math.max(1, Math.round(rootRect.height)), dpr = Math.min(1.75, Math.max(1, Number(window.devicePixelRatio || 1))), pixelWidth = Math.max(1, Math.round(width * dpr)), pixelHeight = Math.max(1, Math.round(height * dpr));
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
            let enemies = liveEnemies(me, 5e4).filter((enemy) => enemy.dropForAvoid >= 1), dangerEnemies = [];
            for (let enemy of enemies) {
              let enemyPoint = clientPoint(enemy, toClient, rootRect);
              !enemyPoint || !lineMayBeVisible(mePoint, enemyPoint, rootRect.width, rootRect.height) || (drawLine(surface.ctx, mePoint, enemyPoint, "enemy"), enemy.dist <= 17e3 && dangerEnemies.push(enemyPoint));
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
        function clickLeave(reason) {
          stopMove(), setDanger(!1), runner.leaves += 1, runner.running = !1, runner.combatMode = !1, runner.huntMode = !1, runner.autoFireMode = !1, runner.autoFireStatus = "OFF", clearAutoFireBurst(!0), clearAttackLock("离开脱战"), clearHuntTarget(), clearCoinRoute(), runner.combatRisk = "clear", runner.timer && (clearInterval(runner.timer), runner.timer = 0), runner.tickMs = 150;
          try {
            let button = els.leaveBtn || Array.from(document.querySelectorAll("button")).find((btn) => (btn.textContent || "").trim() === "离开");
            if (!button) throw new Error("leave button not found");
            button.click(), push("已点击离开脱战：" + reason);
          } catch (err) {
            runner.lastError = String(err && err.message || err), push("离开失败：" + runner.lastError);
          }
          renderStatus();
        }
        function setStepInterval(ms) {
          let next = Number(ms) || 150;
          runner.tickMs === next && runner.timer || (runner.tickMs = next, !(!runner.running || !runner.timer) && (clearInterval(runner.timer), runner.timer = window.setInterval(step, runner.tickMs)));
        }
        function setAutoFireMode(active, reason) {
          let next = !!active;
          runner.autoFireMode !== next && (runner.autoFireMode = next, runner.autoFireLastAt = 0, runner.autoFireNextBurstAt = 0, runner.autoFireStatus = next ? "待机" : "OFF", runner.autoFireTarget = "", next ? (push("自动攻击已开启：使用长按连发覆盖目标"), runner.running ? setStepInterval(100) : start()) : (clearAutoFireBurst(!0), push("自动攻击已关闭" + (reason ? "：" + reason : "")), runner.running && !runner.combatMode && setStepInterval(150)), renderStatus());
        }
        function toggleAutoFireMode() {
          setAutoFireMode(!runner.autoFireMode, "manual");
        }
        function setCombatMode(active, reason) {
          let next = !!active;
          if (runner.combatMode === next) return;
          let clearedManualTarget = next && reason === "manual" && !!runner.manualTarget;
          clearedManualTarget && clearManualTarget("手动开启临时交战"), runner.combatMode = next, clearCoinRoute(), runner.planNextAt = 0, runner.navTarget = null, runner.lastCombatDodge = { dx: 0, dy: 0, score: 0 }, runner.lastCombatSwitchAt = 0, runner.combatManualOverride = !1, runner.combatProjectiles = 0, runner.combatTargets = 0, runner.combatRisk = next ? "watch" : "clear", runner.combatSpacingState = "none", runner.combatSpacingMeters = null, next ? (clearScriptMoveKeys(!0), push("临时交战已开启，暂停金币巡航" + (clearedManualTarget ? "，已取消长按目标" : "")), runner.running || start()) : (runner.projectileMotion.clear(), setStepInterval(150), stopMove(), setDanger(!1), push("临时交战已关闭，恢复金币巡航" + (reason ? "：" + reason : ""))), renderLines(), renderStatus();
        }
        function toggleCombatMode() {
          setCombatMode(!runner.combatMode, "manual");
        }
        function combatDangerLevel(me, enemies) {
          let hp = numberFrom(me, ["hp", "health", "life_value", "current_hp"], 0);
          return hp <= 25 ? "critical" : enemies.some((enemy) => enemy.hpForCombat > 0 && enemy.hpForCombat >= hp * 1.15) ? "outmatched" : "clear";
        }
        function applyCombatDodge(me, spacingEnemies) {
          let now = Date.now(), projectiles = activeProjectiles(me, now);
          if (runner.combatProjectiles = projectiles.length, manualMoveVector().active)
            return clearScriptMoveKeys(!0), runner.combatManualOverride = !0, runner.lastMoveMode = "manual-combat", runner.combatSpacingState = combatSpacingState(spacingEnemies).state, runner.combatSpacingMeters = null, projectiles.length;
          runner.combatManualOverride = !1;
          let dodge = chooseCombatDodge(me, projectiles, spacingEnemies);
          return (dodge.dx !== runner.lastCombatDodge.dx || dodge.dy !== runner.lastCombatDodge.dy) && (runner.lastCombatSwitchAt = now), runner.lastCombatDodge = dodge, runner.combatSpacingState = dodge.spacingState || "none", runner.combatSpacingMeters = Number.isFinite(dodge.spacingDistance) ? Math.round(dodge.spacingDistance / 100) : null, dodge.dx === 0 && dodge.dy === 0 ? (setVelocity(0, 0, { preserveUser: !0 }), runner.lastMoveMode = projectiles.length ? "combat-hold" : "combat-spacing-hold") : (setVelocity(dodge.dx, dodge.dy, { preserveUser: !0 }), runner.lastMoveMode = projectiles.length ? "combat-dodge" : "combat-spacing"), projectiles.length;
        }
        function handleCombatMode(me, hp) {
          if (!runner.combatMode) return !1;
          setStepInterval(hp < 22 ? 50 : runner.autoFireMode ? 100 : 150), clearCoinRoute(), runner.planNextAt = 0, runner.navTarget = null;
          let enemies = combatEnemies(me), spacingEnemies = combatSpacingEnemies(me);
          if (runner.combatTargets = enemies.filter((enemy) => enemy.hpForCombat > 0 && enemy.hpForCombat < hp).length, hp <= 9)
            return runner.combatRisk = "critical", setDanger(!0, "critical"), clickLeave("临时交战血量≤9：" + hp), !0;
          if (runner.combatRisk = combatDangerLevel(me, enemies), runner.combatRisk === "critical" ? setDanger(!0, "critical") : runner.combatRisk === "outmatched" ? setDanger(!0) : setDanger(!1), handleAutoFire(me), runner.manualTarget && (runner.combatProjectiles = activeProjectiles(me, Date.now()).length, runner.combatSpacingState = combatSpacingState(spacingEnemies).state, runner.combatSpacingMeters = null, runner.combatManualOverride = !1, driveManualTarget(me, "临时交战：前往", { preserveUser: !0, respectUserInput: !0 })))
            return !0;
          let projectileCount = applyCombatDodge(me, spacingEnemies), spacingText = runner.combatSpacingMeters === null ? "" : "，距离 " + runner.combatSpacingMeters + "m";
          return runner.lastAction = runner.combatManualOverride ? "临时交战：手动 WASD 接管，自动躲避暂停，标记 " + runner.combatTargets + " 个低血目标" : projectileCount ? "临时交战：躲避 " + projectileCount + " 个弹体" + spacingText + "，标记 " + runner.combatTargets + " 个低血目标" : runner.lastMoveMode === "combat-spacing" ? "临时交战：调整距离到100-150m" + spacingText + "，标记 " + runner.combatTargets + " 个低血目标" : "临时交战：未识别到弹体，保持观察" + spacingText + "，标记 " + runner.combatTargets + " 个低血目标", !0;
        }
        function step() {
          try {
            if (checkHourlyStaminaLimitLeave()) return;
            let me = getMe();
            if (!me) {
              stopMove(), runner.lastAction = "等待玩家实体";
              return;
            }
            let hp = Number(me.hp || 0), balance = Number(me.external_balance_snapshot || 0);
            if (runner.lastHp === null && (runner.lastHp = hp), runner.lastBalance === null && (runner.lastBalance = balance), balance > runner.lastBalance && (runner.deltaBalance += balance - runner.lastBalance, push("收益 +" + (balance - runner.lastBalance) + "，本次累计 +" + runner.deltaBalance)), runner.lastBalance = balance, hp < runner.lastHp && !runner.combatMode) {
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
            if (trackEnemyMotion(Date.now()), handleCombatMode(me, hp) || (runner.autoFireMode ? (setStepInterval(100), handleAutoFire(me)) : setStepInterval(150), driveHuntTarget(me))) return;
            let threats = richEnemies(me, 25e3), urgentThreat = escapeEnemies(me, 17e3)[0];
            if (urgentThreat) {
              let reason = urgentThreat.dropForAvoid > 10 ? "高Drop敌人进入170m射程缓冲，立即逃离" : "低Drop移动敌人进入170m射程缓冲，立即逃离";
              fleeFrom(urgentThreat, me, reason, !0);
              return;
            }
            setDanger(!1);
            let keepawayThreat = threats.find((enemy) => enemy.dist < 22e3);
            if (keepawayThreat) {
              fleeFrom(keepawayThreat, me, "富敌过近，拉开到200-250m外", !1);
              return;
            }
            if (runner.fleeing = !1, runner.fleeKey = "", driveManualTarget(me, "前往")) return;
            let target = currentCoinRouteTarget(me, threats);
            if (!target || Date.now() >= runner.planNextAt) {
              let planned = bestDropRoute(me, threats), switchFactor = runner.routeAdvanced ? 0.98 : 1.14;
              planned && (!target || planned.score > runner.targetScore * switchFactor) ? (adoptCoinRoute(planned), target = currentCoinRouteTarget(me, threats), push("规划金币路线 " + runner.routeIds.join(">") + " / " + (runner.routeKind || "single") + " / " + planned.drops.length + "点 / 总额 " + Math.round(planned.value) + " / 路程 " + planned.travelSeconds.toFixed(1) + "s / 评分 " + planned.score.toFixed(3))) : runner.planNextAt = Date.now() + 1800, runner.routeAdvanced = !1;
            }
            if (!target) {
              stopMove(), runner.lastAction = threats.length ? "富敌250m内，无安全金币，保持距离" : "视野内没有金币";
              return;
            }
            let rx = Number(target.x) - Number(me.x), ry = Number(target.y) - Number(me.y), dist = Math.hypot(rx, ry);
            if (dist <= 160) {
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
        function start() {
          if (runner.running) return;
          let me = getMe();
          runner.running = !0, runner.startedAt = Date.now(), runner.lastHp = me ? Number(me.hp || 0) : null, runner.lastBalance = me ? Number(me.external_balance_snapshot || 0) : null, runner.hourlyLimitLeaveTriggered = !1, clearCoinRoute(), runner.planNextAt = 0, runner.tickMs = 150, runner.timer = window.setInterval(step, runner.tickMs), push("已启动"), step(), renderStatus();
        }
        function stop(reason) {
          runner.running = !1, runner.combatMode = !1, runner.huntMode = !1, clearHuntTarget(), runner.combatRisk = "clear", runner.combatProjectiles = 0, runner.combatTargets = 0, runner.combatManualOverride = !1, runner.autoFireMode = !1, runner.autoFireStatus = "OFF", runner.autoFireTarget = "", clearAutoFireBurst(!0), clearAttackLock("停止脚本"), runner.projectileMotion.clear(), runner.timer && (clearInterval(runner.timer), runner.timer = 0), runner.tickMs = 150, stopMove(), setDanger(!1), push("已停止" + (reason ? "：" + reason : "")), renderLines(), renderStatus();
        }
        function destroy(reason) {
          stop(reason || "destroy"), runner.statusTimer && clearInterval(runner.statusTimer), runner.sidebarSafetyTimer && clearInterval(runner.sidebarSafetyTimer), runner.dropLeaderboardTimer && clearInterval(runner.dropLeaderboardTimer), runner.lineRaf && (window.cancelAnimationFrame(runner.lineRaf), runner.lineRaf = 0), window.removeEventListener("resize", updateHudSceneBounds), window.removeEventListener("pointerdown", handlePointerDown, !0), window.removeEventListener("pointermove", handlePointerMove, !0), window.removeEventListener("pointerup", handlePointerUp, !0), window.removeEventListener("pointercancel", handlePointerUp, !0), window.removeEventListener("contextmenu", handleContextMenu, !0), window.removeEventListener("keydown", handleMovementKeyDown, !0), window.removeEventListener("keyup", handleMovementKeyUp, !0), window.removeEventListener("blur", clearUserMoveKeys), root.remove(), danger.remove(), style.remove();
        }
        function snapshot() {
          let me = getMe(), enemies = me ? richEnemies(me, 25e3) : [], drop = me && !runner.combatMode && !runner.huntMode ? nearestDrop(me, enemies) : null, threat = enemies[0] || runner.lastThreat, manual = runner.manualTarget, huntLabel = runner.huntMode ? "HUNT " + (runner.huntTargetName || runner.huntLastSeen && runner.huntLastSeen.name || runner.huntQuery || "-") : "";
          return {
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
            target: huntLabel || (manual ? manual.x + "," + manual.y : runner.targetId),
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
          let s = snapshot();
          renderAttackLockList(getMe()), root.classList.toggle("running", !!s.running), root.classList.toggle("manual-target", !!s.manualTarget), ui.cancelManual && (ui.cancelManual.textContent = s.manualTarget ? "取消 " + s.manualTarget.x + "," + s.manualTarget.y : "取消目标"), ui.combat && (ui.combat.classList.toggle("active", !!s.combatMode), ui.combat.textContent = s.combatMode ? "交战ON" : "交战"), ui.autoFire && (ui.autoFire.classList.toggle("active", !!s.autoFireMode), ui.autoFire.textContent = s.autoFireMode ? "攻击ON" : "自动攻击"), ui.hunt && (ui.hunt.classList.toggle("active", !!s.huntMode), ui.hunt.textContent = s.huntMode ? "追杀ON" : "追杀"), ui.attackDrawerToggle && (ui.attackDrawerToggle.textContent = s.autoFireMode ? "火控ON" : "火控"), ui.huntDrawerToggle && (ui.huntDrawerToggle.textContent = s.huntMode ? "追杀ON" : "追杀"), ui.dropRefresh && s.huntMode && (ui.dropRefresh.textContent = "追杀 " + (s.huntTargetName || s.huntQuery || "--"));
        }
        runner.start = start, runner.stop = stop, runner.destroy = destroy, runner.leave = (reason) => clickLeave(reason || "manual"), runner.setCombatMode = setCombatMode, runner.setHuntMode = setHuntMode, runner.setAutoFireMode = setAutoFireMode, runner.setManualTarget = setManualTarget, runner.clearManualTarget = clearManualTarget, runner.status = snapshot, window.addEventListener("pointerdown", handlePointerDown, !0), window.addEventListener("pointermove", handlePointerMove, !0), window.addEventListener("pointerup", handlePointerUp, !0), window.addEventListener("pointercancel", handlePointerUp, !0), window.addEventListener("contextmenu", handleContextMenu, !0), window.addEventListener("keydown", handleMovementKeyDown, !0), window.addEventListener("keyup", handleMovementKeyUp, !0), window.addEventListener("blur", clearUserMoveKeys), ui.start.addEventListener("click", start), ui.stop.addEventListener("click", () => stop("manual")), ui.combat.addEventListener("click", toggleCombatMode), ui.autoFire.addEventListener("click", toggleAutoFireMode), ui.hunt.addEventListener("click", toggleHuntMode), ui.huntQuery.addEventListener("keydown", (event) => {
          event.key === "Enter" && (event.preventDefault(), setHuntMode(!0, "enter"));
        }), ui.leave.addEventListener("click", () => clickLeave("manual")), ui.dropList.addEventListener("click", handleDropLeaderboardClick), ui.attackList.addEventListener("click", handleAttackListClick), ui.cancelManual.addEventListener("click", () => {
          clearManualTarget("用户取消"), renderStatus();
        }), ui.attackDrawerToggle.addEventListener("click", () => toggleMobileDrawer("attack")), ui.huntDrawerToggle.addEventListener("click", () => toggleMobileDrawer("hunt")), ui.attackDrawerClose.addEventListener("click", () => setMobileDrawer("")), ui.huntDrawerClose.addEventListener("click", () => setMobileDrawer("")), runner.statusTimer = window.setInterval(renderStatus, 500), runner.sidebarSafetyTimer = window.setInterval(checkHourlyStaminaLimitLeave, 1e3), runner.dropLeaderboardTimer = window.setInterval(renderDropLeaderboard, 3e4), startLineLoop(), checkHourlyStaminaLimitLeave(), renderDropLeaderboard(), renderStatus();
      }
    }
  })();
})();
