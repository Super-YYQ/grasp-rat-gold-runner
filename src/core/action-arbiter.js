// ActionArbiter(Phase 4 §任务4):每 tick 从多个候选动作中选唯一一个最终动作。
//
// 纯逻辑:输入候选数组,按优先级(数值大优先)选最高者;同优先级按提交顺序稳定。
// 输出唯一动作,供 ControlAdapter 执行一次移动/停止/离开。
//
// 双用途模块(同 src/shared/ids.js):
//   1) 测试直接 import;
//   2) 由 scripts/build.mjs 提取函数体内联进 pageMain。
export function pickAction(candidates) {
  if (!candidates || !candidates.length) {
    // 无候选 → 空闲停止
    return { type: "STOP", source: "idle", priority: 0, reason: "无动作候选", vector: null, target: null };
  }
  let best = candidates[0];
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i];
    if (c.priority > best.priority) best = c;
  }
  // 归一:LEAVE/NONE 不带 vector;MOVE 必须有 vector(缺省为 0)
  if (best.type === "MOVE" && !best.vector) {
    best = { ...best, vector: { x: 0, y: 0 } };
  }
  return best;
}

// 在候选列表里加入"用户手动输入"候选,若用户正按住移动键则其优先级应高于
// 自动移动。返回更新后的候选数组(不修改入参)。
export function withUserInput(candidates, userKeys) {
  const hasUserMove = Array.isArray(userKeys) && userKeys.length > 0;
  if (!hasUserMove) return candidates;
  const rest = (candidates || []).filter(c => c.source !== "user");
  rest.push({
    type: "MOVE",
    source: "user",
    priority: 850,
    reason: "用户手动输入接管",
    vector: null, // 由 ControlAdapter 保留用户按键,不清空
    target: null
  });
  return rest;
}