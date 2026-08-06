// 动作候选与仲裁优先级的类型定义(Phase 4 §任务3)。
// 纯常量,不依赖 DOM/GM。
//
// 双用途模块(同 src/shared/ids.js):
//   1) 测试直接 import;
//   2) 由 scripts/build.mjs 提取函数体内联进 pageMain。
//
// 优先级表(计划 §8):数值越大越优先。同一 tick 只允许一个动作被仲裁器选中。
export const ACTION_PRIORITY = {
  DEAD: 1000,           // 已死亡/页面离开/实例销毁
  HP_LEAVE: 950,        // 血量下降/低血/小时体力限制
  REJOIN_SAFETY_LEAVE: 900, // 重连恢复态附近危险或再次掉血
  USER_MANUAL_INPUT: 850,   // 真实 WASD/方向键接管
  PROJECTILE_DODGE: 800,    // 近弹或高压弹道规避
  THREAT_FLEE: 750,         // 危险玩家过近
  COMBAT_SPACING: 650,      // 临时交战距离调节
  MANUAL_TARGET: 600,       // 用户右键/长按目标
  HUNT_TARGET: 550,         // 自动追杀目标
  COIN_ROUTE: 400,          // 金币路线
  IDLE: 0                   // 停止移动
};

// 仲裁器输出的最终动作结构。
// type: MOVE | STOP | LEAVE | NONE
// source: 产生该候选的模块标识(诊断用)
export function makeCandidate(type, source, priority, reason, extra) {
  return Object.assign({
    type,
    source,
    priority,
    reason,
    vector: null,   // { x, y } 仅在 MOVE 时有效
    target: null,   // { x, y } 世界坐标(导航/逃离用)
    expiresAt: null // 该动作的过期时刻(可选)
  }, extra || {});
}

// 判断一个候选是否"真的需要移动"(MOVE 且向量非零)。
export function candidateNeedsMove(c) {
  return c && c.type === "MOVE"
    && c.vector
    && (c.vector.x !== 0 || c.vector.y !== 0);
}