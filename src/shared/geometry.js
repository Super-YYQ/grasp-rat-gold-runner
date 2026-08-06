// 几何工具:两点距离、点到线段距离、整条线段到威胁最近距离、行程 tick/秒、方向向量。
// 全部不依赖 DOM/GM,纯数学。
//
// 双用途模块(同 src/shared/ids.js):
//   1) 测试直接 import(常量在模块内声明,与 pageMain 内同名同值);
//   2) 由 scripts/build.mjs 提取函数体(去掉 export)内联进 pageMain,
//      函数体内引用的常量名与 pageMain 内 const 同名,内联后自然闭包读取。
//
// 常量值必须与 pageMain 保持一致;golden 测试会对照验证。
export const AXIS_DOMINANCE_RATIO = 1.65;
export const TRAVEL_TICK_DIAGONAL_DIV = 35;
export const TRAVEL_TICK_AXIS_DIV = 42;

export function minDistanceToEntities(x, y, entities) {
  let min = Infinity;
  for (const entity of entities || []) {
    const d = Math.hypot(Number(entity && entity.x) - x, Number(entity && entity.y) - y);
    if (d < min) min = d;
  }
  return min;
}

export function pointToSegmentDistance(px, py, ax, ay, bx, by) {
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
export function minSegmentThreatDistance(ax, ay, bx, by, threats) {
  let min = Infinity;
  for (const t of threats || []) {
    const d = pointToSegmentDistance(Number(t.x), Number(t.y), ax, ay, bx, by);
    if (d < min) min = d;
  }
  return min;
}

// §11.2:非法/缺失坐标按"不可达"(Infinity)处理,绝不返回 NaN。
export function travelTicks(fromX, fromY, toX, toY) {
  const ax = Math.abs(Number(toX) - Number(fromX));
  const ay = Math.abs(Number(toY) - Number(fromY));
  if (!Number.isFinite(ax) || !Number.isFinite(ay)) return Infinity;
  const diagonal = Math.min(ax, ay);
  const axis = Math.max(ax, ay) - diagonal;
  return diagonal / TRAVEL_TICK_DIAGONAL_DIV + axis / TRAVEL_TICK_AXIS_DIV;
}

export function travelSeconds(fromX, fromY, toX, toY) {
  return Math.max(0.2, travelTicks(fromX, fromY, toX, toY) * 0.05);
}

export function steerVector(rx, ry) {
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