// FireController(Phase 7 §任务4/5/6):可取消、可预算的连发控制器。
//
// 用内部 generation token 取代"定时器堆叠":每次 startBurst 递增 token,
// 所有 scheduled 回调都带 token 校验 —— stop/destroy 使 token 失效即取消所有
// 后续发数,且不残留 mouseup/click 误触。
//
// 统计区分:
//   - plannedShots:计划发数(启动时预算);
//   - dispatchedShots:实际派发(发出 mousedown/推进);
//   - confirmedShots:游戏确认发数(若无确认信号保持 null)。
//
// 依赖注入:setTimeout / getMe / dispatchMouse / validateShot,便于测试与在宿主替换。
//
// 双用途模块(同 src/shared/ids.js):
//   1) 测试直接 import;
//   2) 由 scripts/build.mjs 提取函数体内联进 pageMain。
export function createFireController(opts) {
  const setTimeoutFn = (opts && opts.setTimeout) || ((fn, ms) => setTimeout(fn, ms));
  const clearTimeoutFn = (opts && opts.clearTimeout) || (id => clearTimeout(id));
  const getMe = (opts && opts.getMe) || (() => null);
  const dispatch = (opts && opts.dispatch) || (() => {});
  const validateShot = (opts && opts.validateShot) || (() => ({ ok: true, reason: "ok" }));
  const shotMs = (opts && opts.shotMs) || 100;
  const randomDelay = (opts && opts.randomDelay) || (() => 0);

  let token = 0;
  let timers = [];
  let active = false;
  let stats = { planned: 0, dispatched: 0, confirmed: null };

  function clearAll(release) {
    for (const id of timers) clearTimeoutFn(id);
    timers = [];
    if (release && active) {
      const client = stats.lastClient;
      if (client) {
        dispatch(client, "mouseup", 0);
        dispatch(client, "click", 0);
      }
    }
    active = false;
  }

  return {
    // 启动一组连发。shots 已由 burst-planner 预算好。
    // begin(x, y) 派发首发 mousedown;每发前回调 beforeShot(shotIndex) 做校验。
    startBurst(shots, begin, beforeShot) {
      const gen = ++token;
      clearAll(false);
      active = true;
      stats = { planned: shots, dispatched: 0, confirmed: null };
      // 首发作校验
      const v0 = validateShot();
      if (!v0.ok) {
        active = false;
        return { ok: false, reason: v0.reason };
      }
      const first = begin(0);
      if (!first) {
        active = false;
        return { ok: false, reason: "no-client" };
      }
      stats.lastClient = first;
      stats.dispatched += 1;
      dispatch(first, "mousemove", 0);
      dispatch(first, "mousedown", 1);

      for (let i = 1; i < shots; i += 1) {
        const id = setTimeoutFn(() => {
          if (token !== gen || !active) return; // 过期 token:取消
          const v = validateShot();
          if (!v.ok) {
            clearAll(true);
            return { ok: false, reason: v.reason, aborted: true };
          }
          const me = getMe();
          const client = beforeShot ? beforeShot(i, me) : null;
          if (!client) return;
          stats.lastClient = client;
          stats.dispatched += 1;
          dispatch(client, "mousemove", 1);
        }, i * shotMs);
        timers.push(id);
      }

      // 释放
      const holdMs = shots * shotMs + randomDelay();
      const releaseId = setTimeoutFn(() => {
        if (token !== gen || !active) return;
        const releaseClient = stats.lastClient;
        dispatch(releaseClient, "mouseup", 0);
        dispatch(releaseClient, "click", 0);
        active = false;
        stats.confirmed = null; // 无确认信号
      }, holdMs);
      timers.push(releaseId);
      return { ok: true, reason: "ok" };
    },

    // 取消当前连发。release=true 时补发 mouseup/click 让游戏按键复位。
    cancel(release) {
      token += 1;
      clearAll(!!release);
      return this;
    },

    get active() { return active; },
    get stats() { return { ...stats }; }
  };
}