// §5.4 身份键统一为字符串:user_id/drop_id/flowId/targetId/Map·Set 键
// 一律用 idKey 归一,禁止 Number(id) 做身份比较(超 JS 安全整数会碰撞)。
// 只有坐标、速度、距离、金额、HP、体力、tick 才能转 Number。
//
// 双用途模块:
//   1) 作为 ES 模块被测试 engine 直接 import(golden 对照);
//   2) 由 scripts/build.mjs 提取函数体,内联进 pageMain(保持 toString() 注入语义)。
export function idKey(value) {
  if (value === null || value === undefined) return "";
  return String(value);
}