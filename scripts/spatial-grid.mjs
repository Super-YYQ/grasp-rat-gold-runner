/**
 * §5.1 空间哈希网格(SpatialGrid)。
 *
 * 用途:金币团统计(routeClusterStats / dropClusterValue)与"到最近威胁距离"
 * (minRichEnemyDistanceAt)都在候选/威胁上做全量 O(N) 扫描;网格把查询半径内
 * 的访问降到局部格,为 500-2000 枚金币 + 数十敌人的大规模场景提供性能预算。
 *
 * 本模块是纯逻辑,供 Phase 2 模块化后接入 PC/手机 userscript;通过
 * scripts/test-spatial.mjs 用"暴力对照 + 性能预算"验证。
 */
export class SpatialGrid {
  constructor(cellSize = 9000) {
    this.cellSize = cellSize;
    this.map = new Map();
  }

  _key(x, y) {
    return Math.floor(x / this.cellSize) + "," + Math.floor(y / this.cellSize);
  }

  clear() {
    this.map.clear();
    return this;
  }

  insert(entity) {
    const k = this._key(Number(entity.x), Number(entity.y));
    let arr = this.map.get(k);
    if (!arr) {
      arr = [];
      this.map.set(k, arr);
    }
    arr.push(entity);
    return this;
  }

  build(entities) {
    this.clear();
    for (const e of entities || []) this.insert(e);
    return this;
  }

  /** 返回圆心 (x,y)、半径 r 覆盖的所有格内的实体(未做圆内精筛)。 */
  cellsRadius(x, y, r) {
    const cs = this.cellSize;
    const minX = Math.floor((x - r) / cs);
    const maxX = Math.floor((x + r) / cs);
    const minY = Math.floor((y - r) / cs);
    const maxY = Math.floor((y + r) / cs);
    const out = [];
    for (let cx = minX; cx <= maxX; cx += 1) {
      for (let cy = minY; cy <= maxY; cy += 1) {
        const arr = this.map.get(cx + "," + cy);
        if (arr && arr.length) out.push(...arr);
      }
    }
    return out;
  }

  /** 半径 r 圆内实体(含精筛)。 */
  queryRadius(x, y, r) {
    const r2 = r * r;
    const out = [];
    for (const e of this.cellsRadius(x, y, r)) {
      const dx = Number(e.x) - x;
      const dy = Number(e.y) - y;
      if (dx * dx + dy * dy <= r2) out.push(e);
    }
    return out;
  }

  /** 半径 r 内最近实体;无则 null。 */
  nearestWithin(x, y, r) {
    let best = null;
    let bestD = Infinity;
    for (const e of this.cellsRadius(x, y, r)) {
      const d = Math.hypot(Number(e.x) - x, Number(e.y) - y);
      if (d <= r && d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best ? { entity: best, dist: bestD } : null;
  }
}

/** 构造 N 个随机实体(供测试/基准)。 */
export function randomEntities(count, maxCoord = 500000, seed = 1) {
  const out = [];
  let s = seed >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let i = 0; i < count; i += 1) {
    out.push({ x: rnd() * maxCoord, y: rnd() * maxCoord });
  }
  return out;
}