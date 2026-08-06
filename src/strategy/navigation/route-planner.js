// 路线规划器(Phase 5 §任务1/2/3/4):SpatialGrid 接线 + 统一 RoutePlan。
//
// 核心思想:
//   - 每个规划周期构建一次网格(金币/威胁),避免逐调用 O(N) 全量扫描;
//   - dropClusterValue / routeClusterStats / 最近威胁查询改用半径查询;
//   - 保留暴力实现作为测试 oracle(grid 结果必须与暴力一致)。
//
// 双用途模块(同 src/shared/ids.js):
//   1) 测试直接 import;
//   2) 由 scripts/build.mjs 提取函数体内联进 pageMain。
import { SpatialGrid } from "./spatial-grid.js";
import { idKey } from "../../shared/ids.js";
import { dropAmount } from "../../shared/numbers.js";

// 一次规划周期使用的网格集合。
export function buildRouteGrids(candidates, threats, clusterRadius) {
  const coinGrid = new SpatialGrid(clusterRadius || 9000).build(candidates || []);
  const threatGrid = new SpatialGrid(13000).build(threats || []);
  return { coinGrid, threatGrid, clusterRadius: clusterRadius || 9000 };
}

// grid 半径查询的簇评分(与暴力 dropClusterValue 同公式)。
// candidatesIndex:drop_id -> drop 的 Map(用于按 id 跳过自身)。
export function dropClusterValueGrid(grid, drop, candidatesIndex, radius, weight) {
  const scanRadius = radius || grid.clusterRadius;
  const valueWeight = weight == null ? 0.65 : weight;
  const x = Number(drop.x);
  const y = Number(drop.y);
  const selfId = idKey(drop.drop_id);
  let sum = 0;
  for (const other of grid.coinGrid.queryRadius(x, y, scanRadius)) {
    if (idKey(other.drop_id) === selfId) continue;
    const dist = Math.hypot(Number(other.x) - x, Number(other.y) - y);
    if (dist > scanRadius) continue;
    sum += dropAmount(other) * (1 - dist / scanRadius) * valueWeight;
  }
  return sum;
}

// grid 半径查询的簇统计(与暴力 routeClusterStats 同公式)。
export function routeClusterStatsGrid(grid, drop, radius) {
  const scanRadius = radius || grid.clusterRadius;
  const x = Number(drop.x);
  const y = Number(drop.y);
  const selfId = idKey(drop.drop_id);
  let count = 0;
  let amount = 0;
  let weighted = 0;
  for (const other of grid.coinGrid.queryRadius(x, y, scanRadius)) {
    if (idKey(other.drop_id) === selfId) continue;
    const dist = Math.hypot(Number(other.x) - x, Number(other.y) - y);
    if (dist > scanRadius) continue;
    const value = dropAmount(other);
    count += 1;
    amount += value;
    weighted += value * (1 - dist / scanRadius);
  }
  return { count, amount, weighted };
}

// grid 半径查询的最近威胁距离(与暴力 minDistanceToEntities 同公式)。
// radius 为扫描上限(运行时用 RICH_ENEMY_SCAN_CM);范围内无威胁返回 Infinity。
// 语义:返回 (x,y) 到威胁的最近距离,等价于暴力遍历后取 min(但只统计 radius 内)。
export function nearestThreatDistGrid(grid, x, y, radius) {
  const r = radius == null ? 25000 : radius;
  let min = Infinity;
  for (const t of grid.threatGrid.queryRadius(x, y, r)) {
    const d = Math.hypot(Number(t.x) - x, Number(t.y) - y);
    if (d < min) min = d;
  }
  return min;
}

// ---- 暴力 oracle(测试对照,不用于运行时) ----
export function dropClusterValueBrute(drop, candidates, radius, weight) {
  const scanRadius = radius || 9000;
  const valueWeight = weight == null ? 0.65 : weight;
  const selfId = idKey(drop.drop_id);
  let sum = 0;
  for (const other of candidates || []) {
    if (idKey(other.drop_id) === selfId) continue;
    const dist = Math.hypot(Number(other.x) - Number(drop.x), Number(other.y) - Number(drop.y));
    if (dist > scanRadius) continue;
    sum += dropAmount(other) * (1 - dist / scanRadius) * valueWeight;
  }
  return sum;
}

export function nearestThreatDistBrute(x, y, threats, radius) {
  const r = radius == null ? 25000 : radius;
  let min = Infinity;
  for (const t of threats || []) {
    const d = Math.hypot(Number(t.x) - x, Number(t.y) - y);
    if (d <= r && d < min) min = d;
  }
  return min;
}

// 统一 RoutePlan 结构(计划 §5 建议)。
export function makeRoutePlan(route, snapshotVersion, me) {
  const coinIds = (route && route.drops ? route.drops : []).map(d => idKey(d.drop_id));
  return {
    id: "route:" + (snapshotVersion || 0) + ":" + (coinIds[0] || "none"),
    coinIds,
    score: route ? route.score : 0,
    value: route ? route.value : 0,
    travelSeconds: route ? route.travelSeconds : 0,
    minSafetyCm: route && route.minSafetyFactor != null ? route.minSafetyFactor * 25000 : 25000,
    createdAt: (me && me.__now) || Date.now(),
    snapshotVersion: snapshotVersion || 0
  };
}