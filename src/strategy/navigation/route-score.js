// 路线评分纯函数:首段偏好、整腿安全系数、转向惩罚。
// 全部不依赖 DOM/GM,纯数学;供 Phase 2 模块化后接入 PC/手机 userscript。
//
// 双用途模块(同 src/shared/ids.js):
//   1) 测试直接 import(常量在模块内声明,与 pageMain 内同名同值);
//   2) 由 scripts/build.mjs 提取函数体(去掉 export)内联进 pageMain,
//      函数体内引用的常量名与 pageMain 内 const 同名,内联后自然闭包读取。
//
// 常量值必须与 pageMain 保持一致;golden 测试会对照验证。
import { minSegmentThreatDistance } from "../../shared/geometry.js";

export const ROUTE_NEAR_PREFER_CM = 12000;
export const ROUTE_FAR_SOFT_CM = 35000;
export const ROUTE_FAR_FACTOR_FLOOR = 0.28;
export const RICH_ENEMY_KEEP_CM = 22000;
export const RICH_ENEMY_SCAN_CM = 25000;

export function routeFirstLegPreferFactor(firstLegCm) {
  const dist = Number(firstLegCm) || 0;
  if (dist <= ROUTE_NEAR_PREFER_CM) return 1;
  if (dist >= ROUTE_FAR_SOFT_CM) return ROUTE_FAR_FACTOR_FLOOR;
  const t = (dist - ROUTE_NEAR_PREFER_CM) / (ROUTE_FAR_SOFT_CM - ROUTE_NEAR_PREFER_CM);
  return 1 - (1 - ROUTE_FAR_FACTOR_FLOOR) * t;
}

export function routeLegSafetyFactor(fromX, fromY, toX, toY, threats) {
  // 整条腿到威胁的最近距离(§5.2),而非只查端点/中点。
  const safety = minSegmentThreatDistance(fromX, fromY, toX, toY, threats);
  if (safety < RICH_ENEMY_KEEP_CM) return 0;
  if (safety >= RICH_ENEMY_SCAN_CM) return 1;
  return 0.55 + 0.45 * ((safety - RICH_ENEMY_KEEP_CM) / (RICH_ENEMY_SCAN_CM - RICH_ENEMY_KEEP_CM));
}

export function routeTurnFactor(prevDx, prevDy, nextDx, nextDy) {
  const prevLen = Math.hypot(prevDx, prevDy);
  const nextLen = Math.hypot(nextDx, nextDy);
  if (prevLen < 1 || nextLen < 1) return 1;
  const cos = (prevDx * nextDx + prevDy * nextDy) / (prevLen * nextLen);
  if (cos < -0.45) return 0.58;
  if (cos < -0.12) return 0.76;
  if (cos > 0.72) return 1.08;
  return 1;
}