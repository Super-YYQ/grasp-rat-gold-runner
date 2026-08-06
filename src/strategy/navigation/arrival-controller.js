// 到达控制器(Phase 5 §任务7):确认、轻推、临时黑名单独立管理。
//
// 把 step() 里"贴近金币后确认/轻推/黑名单"的状态机抽成可测试模块。
// 纯逻辑:输入当前时间与上一次到达状态,返回这一拍该做什么。
//
// 双用途模块(同 src/shared/ids.js):
//   1) 测试直接 import;
//   2) 由 scripts/build.mjs 提取函数体内联进 pageMain。
export function createArrivalController(opts) {
  const now = (opts && opts.now) || (() => Date.now());
  const confirmMs = (opts && opts.confirmMs) || 600;
  const maxNudges = (opts && opts.maxNudges) || 2;
  const blacklistMs = (opts && opts.blacklistMs) || 8000;

  let arrivalId = null;
  let arrivedAt = 0;
  let nudges = 0;

  return {
    // 每拍调用:areWeAtCoin = 当前是否已贴近某枚金币;coinId = 该金币 id。
    // 返回 { action: "wait"|"nudge"|"skip"|"move", coinId, nudgeIndex }
    tick(areWeAtCoin, coinId) {
      const t = now();
      if (!areWeAtCoin) {
        // 不贴近任何金币
        arrivalId = null;
        arrivedAt = 0;
        nudges = 0;
        return { action: null };
      }
      const id = String(coinId);
      if (arrivalId !== id) {
        arrivalId = id;
        arrivedAt = t;
        nudges = 0;
      }
      if (t - arrivedAt < confirmMs) {
        return { action: "wait", coinId: id };
      }
      if (nudges < maxNudges) {
        nudges += 1;
        arrivedAt = t;
        return { action: "nudge", coinId: id, nudgeIndex: nudges };
      }
      // 轻推耗尽:临时黑名单 + 跳过
      arrivalId = null;
      arrivedAt = 0;
      nudges = 0;
      return { action: "skip", coinId: id, blacklistMs };
    },
    reset() {
      arrivalId = null;
      arrivedAt = 0;
      nudges = 0;
    },
    get state() {
      return { arrivalId, arrivedAt, nudges };
    }
  };
}