// ThreatModel(Phase 6 §任务1):统一威胁判断。
//
// 把"高 Drop / 最近移动 / 距离 / 追击时长"的判定集中到纯逻辑模块。
// 输入归一化的敌人实体(含 dropForAvoid/movedRecently/dist),输出威胁分类。
//
// 双用途模块(同 src/shared/ids.js):
//   1) 测试直接 import;
//   2) 由 scripts/build.mjs 提取函数体内联进 pageMain。
export function isRichEnemy(enemy, minDrop) {
  return !!enemy && enemy.dropForAvoid > (minDrop == null ? 10 : minDrop);
}

// 170m 紧急逃离威胁:高 Drop 或(低 Drop 但最近移动过)。
export function isEscapeThreat(enemy, minDrop, movedRecently) {
  if (!enemy) return false;
  const drop = enemy.dropForAvoid;
  if (drop > (minDrop == null ? 10 : minDrop)) return true;
  return drop <= (minDrop == null ? 10 : minDrop) && !!(movedRecently != null ? movedRecently : enemy.movedRecently);
}

// 追击持续时间:enemyMotion 里记录首次/最近观察,判断同一敌人是否持续逼近。
// 返回 { pursuing, durationMs }。enemyMotion 键为 enemyKey。
export function pursuitStatus(enemy, enemyMotion, now) {
  const key = enemy && enemy.key;
  const motion = key && enemyMotion ? enemyMotion.get(key) : null;
  if (!motion) return { pursuing: false, durationMs: 0 };
  const firstSeenAt = motion.firstSeenAt || motion.lastSeenAt || 0;
  return {
    pursuing: now - motion.lastSeenAt <= 10000, // 最近 10s 内仍见(与 MOVING_ENEMY_MEMORY 一致)
    durationMs: Math.max(0, now - firstSeenAt)
  };
}

// 把敌人列表按威胁强度排序(供决策层取最优先)。
export function sortByThreat(enemies) {
  return (enemies || [])
    .filter(Boolean)
    .sort((a, b) => Number(b.dropForAvoid || 0) - Number(a.dropForAvoid || 0) || Number(a.dist) - Number(b.dist));
}