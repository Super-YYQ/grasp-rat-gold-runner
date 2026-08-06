// LeavePolicy(Phase 6 §任务4):统一离开类型分类。
//
// 把 recordLeave 的 type 判定(manual/stamina/lowhp/damage/other)与
// "常态掉血只触发一次 leave"、"手动离开不重连"抽成纯逻辑。
//
// 双用途模块(同 src/shared/ids.js):
//   1) 测试直接 import;
//   2) 由 scripts/build.mjs 提取函数体内联进 pageMain。
export const LEAVE_TYPE = {
  MANUAL: "manual",
  STAMINA: "stamina",
  LOWHP: "lowhp",
  DAMAGE: "damage",
  OTHER: "other"
};

// 根据离开原因与 HP 分类离开类型。
// noReconnect=true → other(不重连);stamina 词 → stamina;
// 否则 hp<=critical → lowhp,其余 → damage。
export function classifyLeave(reason, hp, noReconnect, criticalHp) {
  if (noReconnect) return LEAVE_TYPE.OTHER;
  if (String(reason || "") === "manual") return LEAVE_TYPE.MANUAL;
  if (/1h体力限制/.test(String(reason || ""))) return LEAVE_TYPE.STAMINA;
  const h = Number(hp);
  if (Number.isFinite(h)) {
    return h <= (criticalHp == null ? 25 : criticalHp) ? LEAVE_TYPE.LOWHP : LEAVE_TYPE.DAMAGE;
  }
  return LEAVE_TYPE.DAMAGE;
}

// 离开记录是否应触发自动重连流程(仅 damage/lowhp/stamina 自动)。
// 开关关闭或 noReconnect 时不自动。
export function shouldAutoReconnect(type, autoReconnectOn, noReconnect) {
  if (noReconnect) return false;
  if (!autoReconnectOn) return false;
  return type === LEAVE_TYPE.DAMAGE || type === LEAVE_TYPE.LOWHP || type === LEAVE_TYPE.STAMINA;
}

// 常态掉血离开的"只触发一次"判定:同一离开会话内,首次掉血才触发。
// 返回该拍是否应触发 leave。
export function shouldLeaveOnHpDrop(prevHp, hp, combatMode, alreadyTriggered) {
  if (combatMode) return false;      // 临时交战允许受伤
  if (alreadyTriggered) return false; // 本会话已触发过
  const prev = Number(prevHp);
  const cur = Number(hp);
  if (!Number.isFinite(prev) || !Number.isFinite(cur)) return false;
  return cur < prev;
}