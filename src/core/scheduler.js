// 单一 Scheduler(Phase 4 §任务1):统一管理 50/100/150/500/1000ms 任务。
//
// 以最细间隔(默认 50ms)驱动一个 setInterval,按任务注册的周期做欠账调度,
// 避免多个模块各自 setInterval/setTimeout 导致生命周期混乱与旧定时器残留。
//
// 纯逻辑外壳:setInterval/clearInterval 通过 inject 注入,便于测试与在宿主中替换。
//
// 双用途模块(同 src/shared/ids.js):
//   1) 测试直接 import;
//   2) 由 scripts/build.mjs 提取函数体内联进 pageMain。
export function createScheduler(inject) {
  const setInt = (inject && inject.setInterval) || ((fn, ms) => setInterval(fn, ms));
  const clearInt = (inject && inject.clearInterval) || ((id) => clearInterval(id));
  const now = (inject && inject.now) || (() => Date.now());

  const tasks = new Map(); // name -> { periodMs, lastRunAt, fn }
  let timer = 0;
  let driverMs = 50;
  let lastTick = 0;
  let running = false;

  function tick() {
    const t = now();
    lastTick = t;
    for (const [name, task] of tasks) {
      // lastRunAt === 0 表示从未运行过:第一个 driver tick 立即触发。
      const due = task.lastRunAt === 0 || (t - task.lastRunAt) >= task.periodMs;
      if (due) {
        task.lastRunAt = t;
        try { task.fn(t); } catch (_) {}
      }
    }
  }

  return {
    // 注册/更新一个周期任务。periodMs 为最小周期(实际按 driver 粒度触发)。
    register(name, periodMs, fn) {
      const p = Math.max(1, Number(periodMs) || 0);
      tasks.set(name, { periodMs: p, lastRunAt: 0, fn });
      if (p < driverMs) driverMs = p;
      if (running && tasks.size === 1) {
        clearInt(timer);
        timer = setInt(tick, driverMs);
      }
    },
    unregister(name) {
      tasks.delete(name);
    },
    start() {
      if (running) return;
      running = true;
      lastTick = now();
      // 重新计算 driver 为所有任务周期的最大公约近似(取最小周期)。
      let minPeriod = driverMs;
      for (const t of tasks.values()) minPeriod = Math.min(minPeriod, t.periodMs);
      driverMs = minPeriod;
      timer = setInt(tick, driverMs);
    },
    stop() {
      if (!running) return;
      running = false;
      clearInt(timer);
      timer = 0;
    },
    has(name) { return tasks.has(name); },
    count() { return tasks.size; }
  };
}