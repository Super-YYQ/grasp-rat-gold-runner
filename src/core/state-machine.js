// 运行时显式状态机(Phase 4 §任务2)。
// 把 runner 的隐式模式(运行中/交战/追杀/重连恢复/停止)建模为显式状态。
//
// 状态:
//   STANDBY   - 未启动(等待 start)
//   CRUISE    - 金币巡航(默认运行态)
//   RAID      - 掠夺模式的追近/开火/拾取闭环
//   HUNT      - 自动追杀
//   COMBAT    - 临时交战
//   REJOIN    - 重连安全恢复态
//   LEAVING   - 正在离开
//   STOPPED   - 已停止(人工/错误)
//
// 纯逻辑,不依赖 DOM/GM。转移边界由调用方决策,这里只维护当前状态与合法迁移。
//
// 双用途模块(同 src/shared/ids.js):
//   1) 测试直接 import;
//   2) 由 scripts/build.mjs 提取函数体内联进 pageMain。
export const RUNNER_STATES = {
  STANDBY: "STANDBY",
  CRUISE: "CRUISE",
  RAID: "RAID",
  HUNT: "HUNT",
  COMBAT: "COMBAT",
  REJOIN: "REJOIN",
  LEAVING: "LEAVING",
  STOPPED: "STOPPED"
};

// 合法迁移表:state -> 允许进入的后续状态集合。
export const ALLOWED_TRANSITIONS = {
  STANDBY: new Set(["CRUISE", "RAID", "HUNT", "COMBAT", "REJOIN", "LEAVING", "STOPPED"]),
  CRUISE: new Set(["RAID", "HUNT", "COMBAT", "REJOIN", "LEAVING", "STOPPED", "STANDBY"]),
  RAID: new Set(["CRUISE", "HUNT", "COMBAT", "REJOIN", "LEAVING", "STOPPED", "STANDBY"]),
  HUNT: new Set(["CRUISE", "RAID", "COMBAT", "REJOIN", "LEAVING", "STOPPED", "STANDBY"]),
  COMBAT: new Set(["CRUISE", "RAID", "HUNT", "REJOIN", "LEAVING", "STOPPED", "STANDBY"]),
  REJOIN: new Set(["CRUISE", "RAID", "COMBAT", "LEAVING", "STOPPED", "STANDBY"]),
  LEAVING: new Set(["STOPPED", "STANDBY"]),
  STOPPED: new Set(["CRUISE", "RAID", "HUNT", "COMBAT", "REJOIN", "STANDBY"])
};

export function createStateMachine(initial) {
  let state = initial || RUNNER_STATES.STANDBY;
  const listeners = [];
  return {
    get() { return state; },
    is(...names) { return names.includes(state); },
    can(target) {
      const allowed = ALLOWED_TRANSITIONS[state] || new Set();
      return allowed.has(target);
    },
    transition(target, reason) {
      if (target === state) return true;
      if (!this.can(target)) return false;
      const prev = state;
      state = target;
      for (const fn of listeners) {
        try { fn(prev, state, reason); } catch (_) {}
      }
      return true;
    },
    onTransition(fn) {
      listeners.push(fn);
      return () => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    }
  };
}
