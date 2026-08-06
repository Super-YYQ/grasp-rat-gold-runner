// GameContractProbe(Phase 3 §任务1):游戏契约分级。
//
// 把 userscript 顶层的契约字段采集与分级逻辑集中到适配层。
// 纯逻辑:输入一个"字段名 -> 实际值"的 report,返回 READY/DEGRADED/INCOMPATIBLE。
// 不读 DOM/GM,不产生副作用,便于离线 fixture 测试。
//
// 双用途模块(同 src/shared/ids.js):
//   1) 测试直接 import;
//   2) 由 scripts/build.mjs 提取函数体内联进 pageMain。
export function contractPresent(value, expectation) {
  if (typeof value === "undefined" || value === null || value === false) return false;
  if (expectation === "function") return typeof value === "function";
  if (expectation === "array") return Array.isArray(value);
  if (expectation === "Set-like") {
    return value && (value instanceof Set || typeof value.add === "function"
      || typeof value.has === "function" || typeof value.delete === "function");
  }
  if (expectation === "HTMLElement") {
    return typeof value === "object" && typeof value.getContext === "function";
  }
  if (expectation === "present") return true;
  if (expectation === "object") return typeof value === "object" && !Array.isArray(value);
  return true;
}

// 预期契约:required 缺失 → INCOMPATIBLE(不注入控制);required 全在但某些
// 关键可选(画布/坐标/指针)缺失 → DEGRADED(自动移动/攻击关闭,只读展示)。
export const GAME_CONTRACT_REQUIRED = [
  ["state", "object"],
  ["state.entities", "array"],
  ["state.coinDrops", "array"],
  ["state.keys", "Set-like"],
  ["state.currentUserId", "present"],
  ["sendVelocity", "function"]
];
export const GAME_CONTRACT_OPTIONAL_CRITICAL = [
  ["canvas", "HTMLElement"],
  ["setPointerFromClient", "function"],
  ["screenCenter", "function"]
];

export function classifyGameContract(report) {
  const out = { status: "READY", missing: [], criticalMissing: [], report: {} };
  for (const [key, expect] of GAME_CONTRACT_REQUIRED) {
    const value = report ? report[key] : undefined;
    const ok = contractPresent(value, expect);
    out.report[key] = ok ? expect : "missing";
    if (!ok) out.missing.push(key);
  }
  for (const [key, expect] of GAME_CONTRACT_OPTIONAL_CRITICAL) {
    const value = report ? report[key] : undefined;
    const ok = contractPresent(value, expect);
    out.report[key] = ok ? expect : "missing";
    if (!ok) out.criticalMissing.push(key);
  }
  if (out.missing.length) out.status = "INCOMPATIBLE";
  else if (out.criticalMissing.length) out.status = "DEGRADED";
  else out.status = "READY";
  return out;
}

// 构造契约 report(字段名 -> 实际值),供 classifyGameContract 使用。
// state/els/canvas 等游戏全局由调用方传入,adapter 不直接读 window。
export function buildContractReport(game) {
  const s = game && game.state;
  const d = game && game.els;
  return {
    "state": s,
    "state.entities": s && s.entities,
    "state.coinDrops": s && s.coinDrops,
    "state.keys": s && s.keys,
    "state.currentUserId": s && s.currentUserId,
    "state.minimap": s && s.minimap ? s.minimap.points : undefined,
    "state.pointerWorld": s && s.pointerWorld,
    "sendVelocity": game && game.sendVelocity,
    "canvas": (d && d.canvas) || game.canvas,
    "screenCenter": (d && d.screenCenter) || game.screenCenter,
    "setPointerFromClient": (d && d.setPointerFromClient) || game.setPointerFromClient
  };
}