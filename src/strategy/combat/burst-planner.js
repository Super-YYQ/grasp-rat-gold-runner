// BurstPlanner(Phase 7 §任务3):burst 计划器。
//
// 整组连发的发数预算(§6.1 带保留余量)与覆盖偏移(预测点周边散布)。
// 纯数学,不依赖 DOM/GM。
//
// 双用途模块(同 src/shared/ids.js):
//   1) 测试直接 import;
//   2) 由 scripts/build.mjs 提取函数体内联进 pageMain。
export function planBurstShots(staminaMs, minShots, maxShots, costPerShotMs, reserveShots) {
  const min = minShots == null ? 5 : minShots;
  const max = maxShots == null ? 8 : maxShots;
  const cost = costPerShotMs == null ? 500 : costPerShotMs;
  const reserve = reserveShots == null ? 2 : reserveShots;
  // 体力必须有限非负
  const s = Number(staminaMs);
  if (!Number.isFinite(s) || s < 0) return { shots: 0, reason: "stamina-unknown" };
  const affordable = Math.max(0, Math.floor(s / cost) - reserve);
  if (affordable < min) return { shots: 0, reason: "insufficient" };
  // 随机 5-8 发(与现有行为一致),再按预算封顶
  const base = min + Math.floor(Math.random() * (max - min + 1));
  return { shots: Math.min(base, affordable), reason: "ok" };
}

// 覆盖偏移:沿目标运动方向 + 垂直方向散布,覆盖预测点周边。
export function planCoverageOffsets(me, target, velocity, count, random) {
  const rnd = random || Math.random;
  const targetSpeed = Math.hypot(Number(velocity.vx) || 0, Number(velocity.vy) || 0);
  const rx = Number(target.x) - Number(me.x);
  const ry = Number(target.y) - Number(me.y);
  const dist = Math.max(1, Math.hypot(rx, ry));
  const moveBasis = targetSpeed > 80
    ? { x: (Number(velocity.vx) || 0) / targetSpeed, y: (Number(velocity.vy) || 0) / targetSpeed }
    : { x: rx / dist, y: ry / dist };
  const perp = { x: -moveBasis.y, y: moveBasis.x };
  const along = moveBasis;
  const spread = Math.min(980, Math.max(220, dist * 0.038 + targetSpeed * 0.075));
  const pattern = [0, -0.85, 0.85, -0.42, 0.42, -1.22, 1.22, 0.18];
  const mid = (count - 1) / 2;
  const offsets = [];
  for (let i = 0; i < count; i += 1) {
    const lateral = (pattern[i] != null ? pattern[i] : (rnd() * 2.3 - 1.15)) * spread;
    const forward = (i - mid) * spread * 0.18 + (rnd() * 0.24 - 0.12) * spread;
    offsets.push({
      x: perp.x * lateral + along.x * forward,
      y: perp.y * lateral + along.y * forward
    });
  }
  return offsets;
}