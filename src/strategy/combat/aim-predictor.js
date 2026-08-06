// AimPredictor(Phase 7 §任务2):运动历史与短时预判。
//
// 拦截提前量 + 短时预判坐标。纯数学,不依赖 DOM/GM。
//
// 双用途模块(同 src/shared/ids.js):
//   1) 测试直接 import;
//   2) 由 scripts/build.mjs 提取函数体内联进 pageMain。
export function interceptLeadSeconds(me, target, velocity, projectileSpeed, leadMinMs, leadMaxMs) {
  const rx = Number(target.x) - Number(me.x);
  const ry = Number(target.y) - Number(me.y);
  const vx = Number(velocity.vx) || 0;
  const vy = Number(velocity.vy) || 0;
  const speed = Math.max(1, Number(projectileSpeed) || 10000);
  const min = (leadMinMs == null ? 60 : leadMinMs) / 1000;
  const max = (leadMaxMs == null ? 1150 : leadMaxMs) / 1000;
  const a = vx * vx + vy * vy - speed * speed;
  const b = 2 * (rx * vx + ry * vy);
  const c = rx * rx + ry * ry;
  let lead = Math.sqrt(c) / speed;
  if (Math.abs(a) > 0.001) {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const root = Math.sqrt(disc);
      const t1 = (-b - root) / (2 * a);
      const t2 = (-b + root) / (2 * a);
      const positive = [t1, t2].filter(value => Number.isFinite(value) && value > 0).sort((x, y) => x - y)[0];
      if (Number.isFinite(positive)) lead = positive;
    }
  } else if (Math.abs(b) > 0.001) {
    const linear = -c / b;
    if (Number.isFinite(linear) && linear > 0) lead = linear;
  }
  return Math.min(max, Math.max(min, lead));
}

// 短时预判点:目标当前位置 + 速度 * 提前量。
export function predictedPoint(target, velocity, leadSeconds) {
  return {
    x: Number(target.x) + (Number(velocity.vx) || 0) * leadSeconds,
    y: Number(target.y) + (Number(velocity.vy) || 0) * leadSeconds,
    leadSeconds
  };
}

// 从运动历史估算速度(最近两次观察)。
export function velocityFromHistory(prev, cur, dtMs) {
  if (!prev || !cur) return { vx: 0, vy: 0 };
  const dt = Math.max(0.05, (dtMs == null ? 0 : dtMs) / 1000);
  const vx = (Number(cur.x) - Number(prev.x)) / dt;
  const vy = (Number(cur.y) - Number(prev.y)) / dt;
  return { vx: Number.isFinite(vx) ? vx : 0, vy: Number.isFinite(vy) ? vy : 0 };
}