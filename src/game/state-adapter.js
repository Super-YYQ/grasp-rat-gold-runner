// GameStateAdapter(Phase 3 §任务2):每 tick 生成不可变标准快照。
//
// 把对游戏全局变量的"读取"集中到这里,策略层不再直接引用 state/els/canvas。
// 快照规则:
//   - 缺失字段保留 null,不伪造为 0;
//   - 0 与"缺失"必须区分;
//   - 所有 ID 转字符串;
//   - 单坏实体不中断 tick(捕获异常输出到 diagnostics);
//   - 快照生成后策略只读。
//
// 双用途模块(同 src/shared/ids.js):
//   1) 测试直接 import;
//   2) 由 scripts/build.mjs 提取函数体内联进 pageMain。
import { normalizePlayer, normalizeCoin, normalizeProjectile } from "./entity-normalizer.js";
import { numberFrom } from "../shared/numbers.js";

// 生成标准快照。deps 由调用方注入(游戏全局 + 现有时钟),adapter 不直接读 window。
// deps: { state, selfId, now } 其中 state 为游戏全局 state,selfId 为当前玩家 ID 字符串。
export function gameStateSnapshot(deps) {
  const state = deps && deps.state;
  const now = deps && deps.now != null ? deps.now : Date.now();
  const selfId = deps && deps.selfId != null ? String(deps.selfId) : null;

  const snapshot = {
    now,
    self: null,
    players: [],
    coins: [],
    projectiles: [],
    input: { userKeys: [] },
    contract: { status: "UNKNOWN", missing: [] }
  };

  // self:从 entities 里找当前玩家
  const entities = Array.isArray(state && state.entities) ? state.entities : [];
  if (selfId) {
    for (const raw of entities) {
      try {
        if (raw && String(raw.user_id ?? raw.userId ?? raw.uid) === selfId) {
          const p = normalizePlayer(raw);
          if (p) {
            snapshot.self = {
              ...p,
              stamina5sMs: numberFrom(raw, ["stamina_5s_remaining_milli", "stamina5s"], null),
              stamina1hMs: numberFrom(raw, ["stamina_1h_remaining_milli", "stamina1h"], null),
              balance: numberFrom(raw, ["external_balance_snapshot", "balance"], null)
            };
          }
          break;
        }
      } catch (_) {
        // 单坏实体不中断
      }
    }
  }

  // players:除自己外的实体
  for (const raw of entities) {
    try {
      const p = normalizePlayer(raw);
      if (!p) continue;
      if (selfId && p.id === selfId) continue;
      snapshot.players.push(p);
    } catch (_) {}
  }

  // coins
  const coinDrops = Array.isArray(state && state.coinDrops) ? state.coinDrops : [];
  for (const raw of coinDrops) {
    try {
      const c = normalizeCoin(raw);
      if (!c) continue;
      snapshot.coins.push(c);
    } catch (_) {}
  }

  // user keys:用户真实按下的键(供动作仲裁区分手动 vs 脚本)
  const keys = state && state.keys;
  if (keys && typeof keys.has === "function") {
    const userKeys = [];
    for (const k of ["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"]) {
      try { if (keys.has(k)) userKeys.push(k); } catch (_) {}
    }
    snapshot.input.userKeys = userKeys;
  }

  return snapshot;
}