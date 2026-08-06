/**
 * Phase 5 导航模块测试(§任务与验收):
 *   - SpatialGrid 接线:grid 簇评分/最近威胁 与暴力 oracle 一致;
 *   - RoutePlan 统一结构;
 *   - 到达控制器(确认/轻推/临时黑名单);
 *   - 鲁棒:无金币、坏坐标、重复 ID 不抛错;
 *   - 性能预算:1000 金币 + 50 威胁构建网格 P95。
 *
 * 全部用内存 fixture。Run: node scripts/test-nav-core.mjs
 */
import assert from "node:assert/strict";
import {
  buildRouteGrids,
  dropClusterValueGrid,
  routeClusterStatsGrid,
  nearestThreatDistGrid,
  dropClusterValueBrute,
  nearestThreatDistBrute,
  makeRoutePlan
} from "../src/strategy/navigation/route-planner.js";
import { SpatialGrid, randomEntities } from "../src/strategy/navigation/spatial-grid.js";
import { createArrivalController } from "../src/strategy/navigation/arrival-controller.js";

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

function makeCoins(n, seed) {
  const pts = randomEntities(n, 200000, seed);
  return pts.map((p, i) => ({ drop_id: String(i + 1), x: p.x, y: p.y, amount: 1 + (i % 5) }));
}

// ---- grid vs 暴力 oracle ----
test("grid: dropClusterValueGrid 与暴力一致(随机 300 金币)", () => {
  const coins = makeCoins(300, 42);
  const threats = randomEntities(10, 200000, 7);
  const grid = buildRouteGrids(coins, threats, 9000);
  const idx = new Map(coins.map(c => [String(c.drop_id), c]));
  for (let i = 0; i < 40; i++) {
    const drop = coins[i * 7 % coins.length];
    const g = dropClusterValueGrid(grid, drop, idx, 9000, 0.65);
    const b = dropClusterValueBrute(drop, coins, 9000, 0.65);
    assert.ok(Math.abs(g - b) < 1e-9, `dropClusterValue mismatch at ${i}: grid=${g} brute=${b}`);
  }
});

test("grid: nearestThreatDistGrid 与暴力一致(半径内)", () => {
  const coins = [];
  const threats = randomEntities(20, 200000, 11);
  const grid = buildRouteGrids(coins, threats, 9000);
  for (let i = 0; i < 30; i++) {
    const x = 100000 + i * 5000;
    const y = 80000 + i * 3000;
    const r = 25000;
    const g = nearestThreatDistGrid(grid, x, y, r);
    const b = nearestThreatDistBrute(x, y, threats, r);
    assert.equal(g, b, `nearestThreat mismatch at ${i}: grid=${g} brute=${b}`);
  }
});

test("grid: routeClusterStatsGrid 与暴力 count 一致", () => {
  const coins = makeCoins(150, 5);
  const grid = buildRouteGrids(coins, [], 13000);
  const drop = coins[10];
  const g = routeClusterStatsGrid(grid, drop, 13000);
  let bruteCount = 0;
  for (const other of coins) {
    if (other.drop_id === drop.drop_id) continue;
    if (Math.hypot(other.x - drop.x, other.y - drop.y) <= 13000) bruteCount++;
  }
  assert.equal(g.count, bruteCount);
});

// ---- RoutePlan ----
test("RoutePlan: 统一结构含 id/coinIds/score/snapshotVersion", () => {
  const route = { drops: [{ drop_id: "a" }, { drop_id: "b" }], score: 1.23, value: 18, travelSeconds: 6.4, minSafetyFactor: 0.98 };
  const plan = makeRoutePlan(route, 42, { __now: 1785940000000 });
  assert.equal(plan.id, "route:42:a");
  assert.deepEqual(plan.coinIds, ["a", "b"]);
  assert.equal(plan.score, 1.23);
  assert.equal(plan.snapshotVersion, 42);
  assert.equal(plan.createdAt, 1785940000000);
});

// ---- 到达控制器 ----
test("arrival: 确认周期内 wait,随后轻推,耗尽后 skip+黑名单", () => {
  let t = 0;
  const ctrl = createArrivalController({ now: () => t, confirmMs: 600, maxNudges: 2, blacklistMs: 8000 });
  // 贴近金币 A
  assert.deepEqual(ctrl.tick(true, "A"), { action: "wait", coinId: "A" });
  t = 100;
  assert.deepEqual(ctrl.tick(true, "A"), { action: "wait", coinId: "A" });
  t = 700; // 超确认期
  const n1 = ctrl.tick(true, "A");
  assert.equal(n1.action, "nudge");
  assert.equal(n1.nudgeIndex, 1);
  t = 1400;
  const n2 = ctrl.tick(true, "A");
  assert.equal(n2.action, "nudge");
  assert.equal(n2.nudgeIndex, 2);
  t = 2100;
  const skip = ctrl.tick(true, "A");
  assert.equal(skip.action, "skip");
  assert.equal(skip.blacklistMs, 8000);
});

test("arrival: 金币变化重置状态", () => {
  let t = 0;
  const ctrl = createArrivalController({ now: () => t, maxNudges: 2 });
  ctrl.tick(true, "A");
  t = 700;
  ctrl.tick(true, "A"); // nudge 1
  // 换金币 B → 重置
  const r = ctrl.tick(true, "B");
  assert.deepEqual(r, { action: "wait", coinId: "B" });
});

test("arrival: 不贴近金币时不记录", () => {
  let t = 0;
  const ctrl = createArrivalController({ now: () => t });
  assert.deepEqual(ctrl.tick(false, null), { action: null });
  assert.equal(ctrl.state.arrivalId, null);
});

// ---- 鲁棒 ----
test("鲁棒: 空金币/坏坐标/重复 ID 不抛错", () => {
  const grid = buildRouteGrids([], [], 9000);
  assert.equal(dropClusterValueGrid(grid, { drop_id: "x", x: null, y: null }, new Map(), 9000, 0.65), 0);
  // 重复 ID 金币
  const dup = [{ drop_id: "same", x: 0, y: 0, amount: 5 }, { drop_id: "same", x: 100, y: 100, amount: 3 }];
  const g2 = buildRouteGrids(dup, [], 9000);
  const val = dropClusterValueGrid(g2, dup[0], new Map(dup.map(c => [c.drop_id, c])), 9000, 0.65);
  assert.ok(Number.isFinite(val), "重复 ID 不应抛错");
});

// ---- 性能预算 ----
test("性能: 1000 金币 + 50 威胁构建网格 P95 < 8ms", () => {
  const coins = makeCoins(1000, 1);
  const threats = randomEntities(50, 200000, 2);
  const times = [];
  for (let i = 0; i < 30; i++) {
    const t0 = process.hrtime.bigint();
    buildRouteGrids(coins, threats, 9000);
    const t1 = process.hrtime.bigint();
    times.push(Number(t1 - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.floor(times.length * 0.95)];
  console.log(`  构建网格 P95 = ${p95.toFixed(3)}ms`);
  assert.ok(p95 < 8, `P95 ${p95.toFixed(3)}ms 应 < 8ms`);
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`);
  process.exit(1);
}
console.log("\nAll navigation tests passed.");