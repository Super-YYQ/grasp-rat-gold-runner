// §5.1 SpatialGrid 正确性(与暴力对照)+ 性能预算。
// Run: node scripts/test-spatial.mjs
import assert from "node:assert/strict";
import { SpatialGrid, randomEntities } from "../src/strategy/navigation/spatial-grid.js";

// ---- 正确性:queryRadius / nearestWithin 与暴力扫描一致 ----
{
  const points = randomEntities(300, 200000, 42);
  const grid = new SpatialGrid(9000).build(points);
  for (let i = 0; i < 40; i += 1) {
    const qx = 100000 + i * 5000;
    const qy = 80000 + i * 3000;
    const r = 18000;
    const brute = points.filter(p => {
      const d = Math.hypot(Number(p.x) - qx, Number(p.y) - qy);
      return d <= r;
    });
    const viaGrid = grid.queryRadius(qx, qy, r);
    assert.equal(viaGrid.length, brute.length,
      `queryRadius mismatch at ${i}: grid=${viaGrid.length} brute=${brute.length}`);
  }
  console.log("PASS queryRadius matches brute force");
}

{
  const pts = [{ x: 100, y: 100 }, { x: 5000, y: 0 }, { x: 8000, y: 8000 }];
  const grid = new SpatialGrid(9000).build(pts);
  const near = grid.nearestWithin(0, 0, 20000);
  assert.ok(near && near.entity === pts[0], "nearestWithin should find closest");
  assert.equal(Math.round(near.dist), Math.round(Math.hypot(100, 100)));
  const miss = grid.nearestWithin(0, 0, 50);
  assert.equal(miss, null, "no point within radius -> null");
  console.log("PASS nearestWithin");
}

// ---- 邻格边界:恰好在格线上的点也能被半径查询命中 ----
{
  const pts = [{ x: 8999, y: 0 }, { x: 9001, y: 0 }, { x: 0, y: 8999 }];
  const grid = new SpatialGrid(9000).build(pts);
  const all = grid.queryRadius(0, 0, 20000);
  assert.equal(all.length, 3, "cellsRadius must cover adjacent cells");
  console.log("PASS cross-cell coverage");
}

// ---- 性能预算:1000 金币 + 50 敌人,单次 queryRadius/nearestWithin P95 ----
{
  const coins = randomEntities(1000, 400000, 7);
  const grid = new SpatialGrid(9000).build(coins);
  const enemies = randomEntities(50, 400000, 11);
  const enemyGrid = new SpatialGrid(13000).build(enemies);

  // 预热
  for (let i = 0; i < 20; i += 1) {
    grid.queryRadius(i * 1000, i * 1000, 13000);
    enemyGrid.nearestWithin(i * 1000, i * 1000, 25000);
  }

  const N = 200;
  const times = [];
  for (let i = 0; i < N; i += 1) {
    const qx = (i * 977) % 400000;
    const qy = (i * 331) % 400000;
    const t0 = performance.now();
    grid.queryRadius(qx, qy, 13000);
    enemyGrid.nearestWithin(qx, qy, 25000);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.floor(N * 0.95)];
  console.log(`P95 for queryRadius+nearestWithin = ${p95.toFixed(3)}ms`);
  assert.ok(p95 < 8, `P95 (${p95.toFixed(3)}ms) must be < 8ms`);
  console.log("PASS §5.1 performance budget (P95 < 8ms)");
}

console.log("\nAll spatial-grid tests passed.");