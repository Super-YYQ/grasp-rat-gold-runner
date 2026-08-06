// 时间工具:时钟格式化。不依赖 DOM/GM。
//
// 双用途模块(同 src/shared/ids.js):
//   1) 测试直接 import;
//   2) 由 scripts/build.mjs 提取函数体内联进 pageMain。
export function formatClock(ms) {
  const date = new Date(Number.isFinite(Number(ms)) ? Number(ms) : Date.now());
  const pad = value => String(value).padStart(2, "0");
  return pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
}