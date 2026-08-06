// TargetSelector(Phase 7 §任务1):目标选择、锁定、可见性验证。
//
// 纯逻辑:从归一化敌人列表里选目标(HP 最低/最近)、校验锁定目标是否仍可见存续。
// 不依赖 DOM/GM。
//
// 双用途模块(同 src/shared/ids.js):
//   1) 测试直接 import;
//   2) 由 scripts/build.mjs 提取函数体内联进 pageMain。
export function selectAutoTarget(enemies, lockedEnemy) {
  // 有锁定目标且仍存活 → 保持锁定(即使超射程也不自动换人,由调用方判射程)
  if (lockedEnemy && lockedEnemy.life === "Alive") {
    return { target: lockedEnemy, locked: true };
  }
  // 无锁定 → 选 HP 最低、距离最近、存活的敌人
  const candidates = (enemies || [])
    .filter(e => e && e.life === "Alive" && Number.isFinite(e.hpForFire) && e.hpForFire > 0);
  if (!candidates.length) return null;
  const best = candidates.sort((a, b) =>
    a.hpForFire - b.hpForFire || a.dist - b.dist || String(a.user_id).localeCompare(String(b.user_id))
  )[0];
  return { target: best, locked: false };
}

// 开火前逐项验证(§6.2 + Phase 7 §任务4):目标必须仍存活且可见。
// valid = 目标存在、Alive、HP>0;其余校验(控制权/画布/体力)由 FireController 做。
export function validateFireTarget(enemy) {
  if (!enemy) return { ok: false, reason: "no-target" };
  if (enemy.life !== "Alive") return { ok: false, reason: "not-alive" };
  const hp = Number(enemy.hpForFire);
  if (!Number.isFinite(hp) || hp <= 0) return { ok: false, reason: "no-hp" };
  return { ok: true, reason: "ok" };
}

// 锁定目标超出射程时暂停但不换人(§7 验收:锁定目标超出射程时不自动换人)。
export function lockFireRange(lockedEnemy, fireRangeCm) {
  if (!lockedEnemy) return { inRange: false, locked: false };
  return {
    inRange: Number.isFinite(Number(lockedEnemy.dist)) && Number(lockedEnemy.dist) <= fireRangeCm,
    locked: true
  };
}