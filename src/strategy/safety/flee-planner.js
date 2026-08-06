// FleePlanner(Phase 6 §任务2):输出反向、锚点或保持动作。
//
// 把 fleeFrom 的撤离阶段决策(纯反向 / 安全金币锚点 / 换锚点 / 回纯反向)
// 抽成可测试的纯状态机。不依赖 DOM/GM。
//
// 双用途模块(同 src/shared/ids.js):
//   1) 测试直接 import;
//   2) 由 scripts/build.mjs 提取函数体内联进 pageMain。
export const FLEE_STAGE_REVERSE = "reverse";
export const FLEE_STAGE_ANCHOR = "anchor";

// 输入当前撤离状态 + 时间 + 敌人 key,输出这一拍应进入的阶段。
// 返回 { stage, anchorAt, drop_id, x, y }(anchor 时带坐标)。
export function nextFleeStage(evade, now, sameEnemy, arrivedAtAnchor, staleAnchor,
  anchorAvailable, excludeId, holdMs, maxMs) {
  const hold = holdMs == null ? 1500 : holdMs;
  const max = maxMs == null ? 3500 : maxMs;

  // 无状态或换敌人 → 纯反向
  if (!sameEnemy || !evade || evade.startedAt == null) {
    return { stage: FLEE_STAGE_REVERSE, drop_id: null, x: null, y: null, anchorAt: 0 };
  }

  // 已处于锚点阶段
  if (evade.x != null) {
    if (arrivedAtAnchor || staleAnchor) {
      const anchor = anchorAvailable ? { x: anchorAvailable.x, y: anchorAvailable.y, drop_id: anchorAvailable.drop_id } : null;
      if (anchor) {
        return { stage: FLEE_STAGE_ANCHOR, ...anchor, anchorAt: now };
      }
      return { stage: FLEE_STAGE_REVERSE, drop_id: null, x: null, y: null, anchorAt: 0 };
    }
    return { stage: FLEE_STAGE_ANCHOR, x: evade.x, y: evade.y, drop_id: evade.drop_id, anchorAt: evade.anchorAt };
  }

  // 纯反向阶段:超过 hold 且锚点可用 → 转锚点
  if ((now - evade.startedAt) >= hold) {
    if (anchorAvailable) {
      return { stage: FLEE_STAGE_ANCHOR, x: anchorAvailable.x, y: anchorAvailable.y, drop_id: anchorAvailable.drop_id, anchorAt: now };
    }
  }
  return { stage: FLEE_STAGE_REVERSE, drop_id: null, x: null, y: null, anchorAt: 0 };
}

// 规避事件计数:同敌人连续 tick 不重复;换敌人/首次进入才 +1。
// 返回 { countIncrement, fleeing, fleeKey }。
export function fleeEpisode(fleeing, fleeKey, newKey) {
  const key = String(newKey || "");
  if (!fleeing || (fleeKey && fleeKey !== key)) {
    return { countIncrement: 1, fleeing: true, fleeKey: key };
  }
  return { countIncrement: 0, fleeing: true, fleeKey: fleeKey || key };
}