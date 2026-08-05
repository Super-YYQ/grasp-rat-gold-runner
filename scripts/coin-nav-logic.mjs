/**
 * Pure coin / flee navigation helpers.
 * Kept free of game globals so node can regression-test the three nav bugs.
 * PC/mobile userscripts mirror these formulas.
 */

export const COIN_REACHED_CM = 160;
export const AXIS_DOMINANCE_RATIO = 1.65;
export const FLEE_ANCHOR_HOLD_MS = 1500;
export const FLEE_ANCHOR_MAX_MS = 3500;
export const FLEE_ANCHOR_SAFE_RADIUS_CM = 19000;
export const ROUTE_NEAR_PREFER_CM = 12000;
export const ROUTE_FAR_SOFT_CM = 35000;
export const ROUTE_FAR_FACTOR_FLOOR = 0.28;
export const ROUTE_LENGTH_PENALTY_START_CM = 30000;
export const ROUTE_LENGTH_PENALTY_PER_CM = 0.000018;
export const ROUTE_LENGTH_PENALTY_FLOOR = 0.5;
export const TRAVEL_TICK_DIAGONAL_DIV = 35;
export const TRAVEL_TICK_AXIS_DIV = 42;

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

/** Stop when close enough to collect; avoids 8-dir overshoot orbit. */
export function coinMoveDecision(rx, ry, dist) {
  if (dist <= COIN_REACHED_CM) {
    return { dx: 0, dy: 0, mode: "reached", stop: true };
  }
  const move = steerVector(rx, ry);
  return { ...move, stop: move.mode === "stop" };
}

/**
 * Simulate approaching a coin with fixed step sizes.
 * Returns whether motion settled (stop) within maxSteps without oscillating.
 */
export function simulateCoinApproach(startX, startY, stepAxis, stepDiag, maxSteps = 40) {
  let x = startX;
  let y = startY;
  let stops = 0;
  const seen = new Set();
  for (let i = 0; i < maxSteps; i += 1) {
    const dist = Math.hypot(x, y);
    const key = `${Math.round(x / 5) * 5},${Math.round(y / 5) * 5}`;
    if (seen.has(key)) {
      return { settled: false, reason: "orbit", steps: i, x, y, dist };
    }
    seen.add(key);
    const decision = coinMoveDecision(-x, -y, dist);
    if (decision.stop) {
      stops += 1;
      return { settled: true, reason: "reached", steps: i, x, y, dist, stops };
    }
    const step = decision.dx && decision.dy ? stepDiag : stepAxis;
    x += decision.dx * step;
    y += decision.dy * step;
  }
  return { settled: false, reason: "timeout", steps: maxSteps, x, y, dist: Math.hypot(x, y) };
}

export function travelTicks(fromX, fromY, toX, toY) {
  const ax = Math.abs(Number(toX) - Number(fromX));
  const ay = Math.abs(Number(toY) - Number(fromY));
  // §11.2:非法/缺失坐标按"不可达"处理,绝不返回 NaN。
  if (!Number.isFinite(ax) || !Number.isFinite(ay)) return Infinity;
  const diagonal = Math.min(ax, ay);
  const axis = Math.max(ax, ay) - diagonal;
  return diagonal / TRAVEL_TICK_DIAGONAL_DIV + axis / TRAVEL_TICK_AXIS_DIV;
}

export function travelSeconds(fromX, fromY, toX, toY) {
  return Math.max(0.2, travelTicks(fromX, fromY, toX, toY) * 0.05);
}

/** §5.3: 循环求最近距离,不分配数组、无 Math.min(...) 参数上限问题。 */
export function minDistanceToEntities(x, y, entities) {
  let min = Infinity;
  for (const entity of entities || []) {
    const d = Math.hypot(Number(entity && entity.x) - x, Number(entity && entity.y) - y);
    if (d < min) min = d;
  }
  return min;
}

/** §5.6: 金额缺失/非法返回 null,不作为 1 去追无效目标。 */
export function readDropAmount(drop) {
  const value = Number(drop && drop.amount);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** §5.2: 点到线段的最短距离(端点/中点可能漏判的 1/4、3/4 位置覆盖在内)。 */
export function pointToSegmentDistance(px, py, ax, ay, bx, by) {
  const vx = Number(bx) - Number(ax);
  const vy = Number(by) - Number(ay);
  // §11.2:非法/缺失坐标按"不可达"(Infinity)处理,绝不返回 NaN。
  if (!Number.isFinite(vx) || !Number.isFinite(vy)) return Infinity;
  const len2 = vx * vx + vy * vy;
  if (len2 <= 1e-9) return Math.hypot(Number(px) - Number(ax), Number(py) - Number(ay));
  const t = Math.max(0, Math.min(1, ((Number(px) - Number(ax)) * vx + (Number(py) - Number(ay)) * vy) / len2));
  return Math.hypot(Number(px) - (Number(ax) + t * vx), Number(py) - (Number(ay) + t * vy));
}

/** §5.2: 整条线段到最近威胁的距离。 */
export function minSegmentThreatDistance(ax, ay, bx, by, threats) {
  let min = Infinity;
  for (const t of threats || []) {
    const d = pointToSegmentDistance(Number(t.x), Number(t.y), ax, ay, bx, by);
    if (d < min) min = d;
  }
  return min;
}

export function routeLengthFactor(totalLegCm) {
  const lengthExcessCm = Math.max(0, (Number(totalLegCm) || 0) - ROUTE_LENGTH_PENALTY_START_CM);
  const lengthFactorBase = 1 - ROUTE_LENGTH_PENALTY_PER_CM * lengthExcessCm;
  return Math.max(ROUTE_LENGTH_PENALTY_FLOOR, lengthFactorBase);
}

/** Soft-penalize routes whose first coin is far, even if amount/cluster looks rich. */
export function routeFirstLegPreferFactor(firstLegCm) {
  const dist = Number(firstLegCm) || 0;
  if (dist <= ROUTE_NEAR_PREFER_CM) return 1;
  if (dist >= ROUTE_FAR_SOFT_CM) return ROUTE_FAR_FACTOR_FLOOR;
  const t = (dist - ROUTE_NEAR_PREFER_CM) / (ROUTE_FAR_SOFT_CM - ROUTE_NEAR_PREFER_CM);
  return 1 - (1 - ROUTE_FAR_FACTOR_FLOOR) * t;
}

export function scoreSingleDrop(amount, cluster, fromX, fromY, toX, toY, sameBias = 1) {
  const seconds = travelSeconds(fromX, fromY, toX, toY);
  const firstLeg = Math.hypot(Number(toX) - Number(fromX), Number(toY) - Number(fromY));
  return ((amount + cluster) / (seconds + 1.6)) * sameBias * routeFirstLegPreferFactor(firstLeg);
}

export function scoreRoute(totalValue, densityBonus, totalSeconds, totalLegCm, count, firstLegCm, sameBias = 1) {
  const countBonus = 1 + Math.min(0.18, (count - 1) * 0.045);
  return ((totalValue + densityBonus) / (totalSeconds + 1.4))
    * countBonus
    * sameBias
    * routeLengthFactor(totalLegCm)
    * routeFirstLegPreferFactor(firstLegCm);
}

/**
 * Flee anchor state machine.
 * - reverse for FLEE_ANCHOR_HOLD_MS
 * - then lock a safe coin anchor
 * - on reach / stale / same-coin spin: re-pick excluding current, else reverse
 */
export function nextFleeState(prev, now, me, enemy, candidates, options = {}) {
  const key = String(options.enemyKey || enemy.user_id || "e");
  const holdMs = options.holdMs == null ? FLEE_ANCHOR_HOLD_MS : options.holdMs;
  const maxAnchorMs = options.maxAnchorMs == null ? FLEE_ANCHOR_MAX_MS : options.maxAnchorMs;
  const reachCm = options.reachCm == null ? COIN_REACHED_CM : options.reachCm;
  const safeRadius = options.safeRadius == null ? FLEE_ANCHOR_SAFE_RADIUS_CM : options.safeRadius;

  let evade = prev && prev.key === key
    ? { ...prev }
    : { key, startedAt: now, x: null, y: null, drop_id: null, anchorAt: 0 };

  const pickAnchor = (excludeId) => {
    let best = null;
    for (const drop of candidates || []) {
      if (excludeId != null && Number(drop.drop_id) === Number(excludeId)) continue;
      const dx = Number(drop.x);
      const dy = Number(drop.y);
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) continue;
      const distFromEnemy = Math.hypot(dx - Number(enemy.x), dy - Number(enemy.y));
      if (distFromEnemy < safeRadius) continue;
      const distToMe = Math.hypot(dx - Number(me.x), dy - Number(me.y));
      if (!Number.isFinite(distToMe) || distToMe > 500000) continue;
      // Prefer anchors that continue away from the enemy (half-plane bias).
      const awayX = Number(me.x) - Number(enemy.x);
      const awayY = Number(me.y) - Number(enemy.y);
      const toDropX = dx - Number(me.x);
      const toDropY = dy - Number(me.y);
      const awayLen = Math.hypot(awayX, awayY) || 1;
      const align = (awayX * toDropX + awayY * toDropY) / awayLen;
      const score = (distFromEnemy + 1) / (distToMe + 1) + Math.max(0, align) / 20000;
      if (!best || score > best.score) {
        best = { x: dx, y: dy, drop_id: drop.drop_id, score, distToMe };
      }
    }
    return best;
  };

  if (evade.x != null) {
    const distToAnchor = Math.hypot(Number(evade.x) - Number(me.x), Number(evade.y) - Number(me.y));
    const stale = evade.anchorAt && (now - evade.anchorAt) >= maxAnchorMs;
    if (distToAnchor <= reachCm || stale) {
      const next = pickAnchor(evade.drop_id);
      if (next) {
        evade = {
          key,
          startedAt: evade.startedAt,
          x: next.x,
          y: next.y,
          drop_id: next.drop_id,
          anchorAt: now
        };
      } else {
        evade = { key, startedAt: now, x: null, y: null, drop_id: null, anchorAt: 0 };
      }
    }
  } else if ((now - evade.startedAt) >= holdMs) {
    const anchor = pickAnchor(null);
    if (anchor) {
      evade = {
        key,
        startedAt: evade.startedAt,
        x: anchor.x,
        y: anchor.y,
        drop_id: anchor.drop_id,
        anchorAt: now
      };
    }
  }

  let moveRx;
  let moveRy;
  let mode;
  if (evade.x != null) {
    moveRx = Number(evade.x) - Number(me.x);
    moveRy = Number(evade.y) - Number(me.y);
    mode = "anchor";
  } else {
    moveRx = Number(me.x) - Number(enemy.x) || 1;
    moveRy = Number(me.y) - Number(enemy.y);
    mode = "reverse";
  }
  return { evade, mode, moveRx, moveRy };
}
