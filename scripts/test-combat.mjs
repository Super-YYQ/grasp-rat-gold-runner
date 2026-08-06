/**
 * Phase 7 战斗/火控测试(§任务与验收):
 *   - aim-predictor:拦截提前量、短时预判、运动历史速度;
 *   - burst-planner:体力未知不发射、预算封顶;
 *   - target-selector:锁定不换人、可见性校验;
 *   - fire-controller:generation token 取消、stop 无残留、目标中途死亡释放。
 *
 * 全部用内存 fixture(setTimeout 用注入的假定时器)。Run: node scripts/test-combat.mjs
 */
import assert from "node:assert/strict";
import { interceptLeadSeconds, predictedPoint, velocityFromHistory } from "../src/strategy/combat/aim-predictor.js";
import { planBurstShots, planCoverageOffsets } from "../src/strategy/combat/burst-planner.js";
import { selectAutoTarget, validateFireTarget, lockFireRange } from "../src/strategy/combat/target-selector.js";
import { createFireController } from "../src/strategy/combat/fire-controller.js";

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log("PASS", name);
  } catch (err) {
    failed += 1;
    console.error("FAIL", name);
    console.error("   ", err && err.message || err);
  }
}

// ---- aim-predictor ----
test("aim: 静止目标拦截提前量 = 距离/弹速(夹在 min/max)", () => {
  const lead = interceptLeadSeconds({ x: 0, y: 0 }, { x: 10000, y: 0 }, { vx: 0, vy: 0 }, 10000);
  assert.ok(Math.abs(lead - 1.0) < 0.01, `lead=${lead}`);
  const clamped = interceptLeadSeconds({ x: 0, y: 0 }, { x: 100, y: 0 }, { vx: 0, vy: 0 }, 10000, 60, 1150);
  assert.ok(clamped >= 0.06 && clamped <= 1.15, `clamped=${clamped}`);
});

test("aim: 预判点 = 当前位置 + 速度*提前量", () => {
  const p = predictedPoint({ x: 100, y: 200 }, { vx: 50, vy: 0 }, 2);
  assert.equal(p.x, 200);
  assert.equal(p.y, 200);
});

test("aim: 运动历史估算速度", () => {
  const v = velocityFromHistory({ x: 0, y: 0 }, { x: 100, y: 50 }, 1000);
  assert.ok(Math.abs(v.vx - 100) < 0.01, `vx=${v.vx}`);
  assert.ok(Math.abs(v.vy - 50) < 0.01);
});

// ---- burst-planner ----
test("burst: 体力未知(NaN/负数)不发射", () => {
  assert.equal(planBurstShots(NaN, 5, 8, 500, 2).shots, 0);
  assert.equal(planBurstShots(-1, 5, 8, 500, 2).shots, 0);
  assert.equal(planBurstShots(undefined, 5, 8, 500, 2).shots, 0);
});

test("burst: 预算足够按 5-8 发,预算不足按 affordable 封顶", () => {
  const r = planBurstShots(100000, 5, 8, 500, 2);
  assert.ok(r.shots >= 5 && r.shots <= 8, `shots=${r.shots}`);
  // 体力 3000ms -> floor(3000/500)-2 = 4 -> 不足 5 → 不发射
  const low = planBurstShots(3000, 5, 8, 500, 2);
  assert.equal(low.shots, 0);
  assert.equal(low.reason, "insufficient");
});

test("burst: 覆盖偏移数量与分发一致", () => {
  const offsets = planCoverageOffsets({ x: 0, y: 0 }, { x: 5000, y: 0 }, { vx: 0, vy: 0 }, 5, () => 0.5);
  assert.equal(offsets.length, 5);
  for (const o of offsets) assert.ok(Number.isFinite(o.x) && Number.isFinite(o.y));
});

// ---- target-selector ----
test("target: 锁定目标存活时保持锁定,即使超射程也不换人", () => {
  const locked = { user_id: "a", life: "Alive", hpForFire: 10, dist: 20000 };
  const other = { user_id: "b", life: "Alive", hpForFire: 5, dist: 5000 };
  const sel = selectAutoTarget([other, locked], locked);
  assert.equal(sel.target.user_id, "a", "锁定目标保持");
  assert.equal(sel.locked, true);
  // 超射程 → 暂停但不换人
  const range = lockFireRange(locked, 15000);
  assert.equal(range.inRange, false);
  assert.equal(range.locked, true);
});

test("target: 无锁定时选 HP 最低最近", () => {
  const sel = selectAutoTarget([
    { user_id: "a", life: "Alive", hpForFire: 30, dist: 1000 },
    { user_id: "b", life: "Alive", hpForFire: 10, dist: 5000 },
    { user_id: "c", life: "Alive", hpForFire: 10, dist: 2000 }
  ], null);
  assert.equal(sel.target.user_id, "c", "HP 最低且最近");
});

test("target: validateFireTarget 校验存活/HP", () => {
  assert.equal(validateFireTarget(null).ok, false);
  assert.equal(validateFireTarget({ life: "Dead", hpForFire: 10 }).ok, false);
  assert.equal(validateFireTarget({ life: "Alive", hpForFire: 0 }).ok, false);
  assert.equal(validateFireTarget({ life: "Alive", hpForFire: 10 }).ok, true);
});

// ---- fire-controller ----
test("fire: 目标中途死亡 → 释放(无残留 mousedown 后续)", () => {
  const timers = [];
  let now = 0;
  const events = [];
  const inject = {
    setTimeout: fn => { const id = timers.length + 1; timers.push({ id, fn, at: now }); return id; },
    clearTimeout: id => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); },
    getMe: () => ({ x: 0, y: 0 }),
    dispatch: (client, type, buttons) => events.push({ type, buttons }),
    shotMs: 100,
    randomDelay: () => 50
  };
  // validateShot:第 2 发后目标死亡
  let alive = true;
  const fc = createFireController({ ...inject, validateShot: () => (alive ? { ok: true } : { ok: false, reason: "dead" }) });
  const r = fc.startBurst(5, () => ({ x: 1, y: 1 }), (i) => ({ x: i, y: i }));
  assert.equal(r.ok, true);
  assert.equal(fc.active, true);
  // 模拟目标在第 2 发前死亡
  alive = false;
  // 逐个触发定时器(第 2 发 beforeShot 校验失败 → 取消)
  while (timers.length) {
    const t = timers.shift();
    t.fn();
  }
  // 不应有后续 mousemove(mousedown 后目标死亡)
  const moves = events.filter(e => e.type === "mousemove");
  assert.ok(moves.length <= 2, `moves=${moves.length}`);
  // 取消后应补 release(mouseup) 或无残留
  assert.equal(fc.active, false);
});

test("fire: stop/cancel 后无残留 mouseup 补发", () => {
  const timers = [];
  const events = [];
  const inject = {
    setTimeout: fn => { const id = timers.length + 1; timers.push({ id, fn }); return id; },
    clearTimeout: id => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); },
    getMe: () => ({ x: 0, y: 0 }),
    dispatch: (client, type, buttons) => events.push({ type, buttons }),
    shotMs: 100,
    randomDelay: () => 50
  };
  const fc = createFireController(inject);
  fc.startBurst(3, () => ({ x: 1, y: 1 }), i => ({ x: i, y: i }));
  const before = timers.length;
  fc.cancel(true); // release
  assert.equal(timers.length, 0, "所有定时器被清除");
  assert.equal(fc.active, false);
  // 触发任何残留定时器都不应产生事件
  const remaining = timers.length;
  assert.equal(remaining, 0);
});

test("fire: 无 canvas 时 begin 返回 null → 不发射", () => {
  const fc = createFireController({
    setTimeout: fn => 0, clearTimeout: () => {},
    getMe: () => ({ x: 0, y: 0 }),
    dispatch: () => {},
    validateShot: () => ({ ok: true })
  });
  const r = fc.startBurst(3, () => null, i => null); // begin 返回 null(无 canvas)
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no-client");
});

test("fire: planned/dispatched 统计区分,confirmed 保持 null", () => {
  const events = [];
  const fc = createFireController({
    setTimeout: () => 0, clearTimeout: () => {},
    getMe: () => ({ x: 0, y: 0 }),
    dispatch: (c, t, b) => events.push(t),
    shotMs: 100, randomDelay: () => 50
  });
  fc.startBurst(2, () => ({ x: 1, y: 1 }), i => ({ x: i, y: i }));
  const s = fc.stats;
  assert.equal(s.planned, 2);
  assert.equal(s.dispatched, 1, "仅首发 mousedown 派发(后续异步)");
  assert.equal(s.confirmed, null, "无确认信号保持 null");
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`);
  process.exit(1);
}
console.log("\nAll combat tests passed.");