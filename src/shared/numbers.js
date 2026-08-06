// 数值工具:字段取值、体力校验、金额读取。全部不依赖 DOM/GM。
//
// 双用途模块(同 src/shared/ids.js):
//   1) 测试直接 import;
//   2) 由 scripts/build.mjs 提取函数体内联进 pageMain。
export function numberFrom(obj, keys, fallback) {
  for (const key of keys) {
    const value = Number(obj && obj[key]);
    if (Number.isFinite(value)) return value;
  }
  return fallback;
}

// 5s 体力必须是有限非负数值才可用于火控预算;未知/缺失/NaN/非数字一律 fail closed。
// "" 与纯空白串也算未知(Number("")===0 不代表真的 0 体力)。
export function finiteStaminaMs(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string" && raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function dropAmount(drop) {
  return Math.max(1, Number(drop && drop.amount || 1));
}

// §5.6:金额缺失/非法返回 null,不作为 1 去追无效目标(由候选过滤)。
export function readDropAmount(drop) {
  const value = Number(drop && drop.amount);
  return Number.isFinite(value) && value > 0 ? value : null;
}