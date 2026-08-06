// 实体字段标准化(Phase 3 §任务3):把游戏页面的原始实体字段(可能有多套别名)
// 归一为固定字段。所有 ID 转字符串;缺失保留 null(不伪造 0);数值字段才转 Number。
//
// 双用途模块(同 src/shared/ids.js):
//   1) 测试直接 import;
//   2) 由 scripts/build.mjs 提取函数体内联进 pageMain。
//   注意:numberFrom 由 src/shared/numbers.js 提供(内联进同一作用域),
//   这里不再重复定义,避免函数名冲突。
import { numberFrom } from "../shared/numbers.js";

// 玩家/敌人标准化:HP 用别名序列,ID 用字符串,坐标用 Number(含别名)。
export function normalizePlayer(raw) {
  if (!raw || typeof raw !== "object") return null;
  const x = numberFrom(raw, ["x", "pos_x", "world_x", "cx"], null);
  const y = numberFrom(raw, ["y", "pos_y", "world_y", "cy"], null);
  return {
    id: String((raw.user_id ?? raw.userId ?? raw.uid) ?? ""),
    x,
    y,
    hp: numberFrom(raw, ["hp", "health", "life_value", "current_hp"], null),
    life: raw.life ?? null,
    name: (raw.name ?? raw.userName ?? raw.username) != null ? String(raw.name ?? raw.userName ?? raw.username) : null,
    vx: numberFrom(raw, ["vx", "vel_x", "velocity_x", "speed_x"], 0),
    vy: numberFrom(raw, ["vy", "vel_y", "velocity_y", "speed_y"], 0),
    drop: numberFrom(raw, ["death_reward_preview", "death_drop_coins"], 0)
  };
}

// 金币标准化:drop_id 用字符串,金额用 readDropAmount 语义(非法/缺失→null,不强造 0/1)。
// 缺失字段保留 null;单坏实体不中断 tick。
export function normalizeCoin(raw) {
  if (!raw || typeof raw !== "object") return null;
  const x = numberFrom(raw, ["x", "pos_x", "world_x", "cx"], null);
  const y = numberFrom(raw, ["y", "pos_y", "world_y", "cy"], null);
  const amount = Number(raw.amount);
  return {
    id: String((raw.drop_id ?? raw.coinId ?? raw.id) ?? ""),
    x,
    y,
    amount: Number.isFinite(amount) && amount > 0 ? amount : null
  };
}

// 弹体标准化:start_x/y 与 dir 预判字段在策略层做,这里只取稳定字段。
export function normalizeProjectile(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String((raw.projectile_id ?? raw.bullet_id ?? raw.shot_id ?? raw.id ?? raw.uid) ?? "");
  return {
    id,
    startX: numberFrom(raw, ["start_x", "pos_x", "world_x", "x"], null),
    startY: numberFrom(raw, ["start_y", "pos_y", "world_y", "y"], null),
    vx: numberFrom(raw, ["vx", "vel_x", "velocity_x", "speed_x"], 0),
    vy: numberFrom(raw, ["vy", "vel_y", "velocity_y", "speed_y"], 0),
    owner: raw.owner_user_id != null ? String(raw.owner_user_id) : null
  };
}