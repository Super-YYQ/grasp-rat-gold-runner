// 运行时进展 watchdog（看门狗）。只根据调用方提供的只读样本判断：
// 先做一次可恢复重规划，连续无进展或状态长期不新鲜时升级为离开/重连。

export function createRuntimeWatchdog(options) {
  const cfg = {
    stallMs: 4500,
    staleMs: 12000,
    maxRecoveries: 2,
    progressCm: 80,
    ...(options || {})
  };
  let lastX = null;
  let lastY = null;
  let lastTargetKey = "";
  let lastPulse = "";
  let lastProgressAt = null;
  let lastFreshAt = null;
  let recoveries = 0;

  function reset(now) {
    lastX = null;
    lastY = null;
    lastTargetKey = "";
    lastPulse = "";
    lastProgressAt = Number.isFinite(Number(now)) ? Number(now) : null;
    lastFreshAt = lastProgressAt;
    recoveries = 0;
  }

  return {
    observe(sample) {
      const now = Number(sample && sample.now);
      if (!Number.isFinite(now)) return { action: "none", reason: "invalid-time", recoveries };
      const active = !!(sample && sample.active);
      const expectedMove = !!(sample && sample.expectedMove);
      const x = Number(sample && sample.x);
      const y = Number(sample && sample.y);
      const targetKey = String(sample && sample.targetKey || "");
      const pulse = String(sample && sample.pulse || "");
      if (!active || !Number.isFinite(x) || !Number.isFinite(y)) {
        reset(now);
        return { action: "none", reason: active ? "invalid-position" : "inactive", recoveries: 0 };
      }

      if (lastProgressAt === null) {
        lastX = x;
        lastY = y;
        lastTargetKey = targetKey;
        lastPulse = pulse;
        lastProgressAt = now;
        lastFreshAt = now;
        return { action: "none", reason: "baseline", recoveries };
      }

      if (pulse && pulse !== lastPulse) {
        lastPulse = pulse;
        lastFreshAt = now;
      }
      const staleFor = now - Number(lastFreshAt);
      if (pulse && staleFor >= cfg.staleMs) {
        recoveries = cfg.maxRecoveries;
        lastProgressAt = now;
        return { action: "leave", reason: "state-stale", recoveries, staleFor };
      }
      if (!expectedMove) {
        lastX = x;
        lastY = y;
        lastTargetKey = targetKey;
        lastProgressAt = now;
        recoveries = 0;
        return { action: "none", reason: "idle", recoveries };
      }
      if (targetKey !== lastTargetKey) {
        lastTargetKey = targetKey;
        lastX = x;
        lastY = y;
        lastProgressAt = now;
        recoveries = 0;
        return { action: "none", reason: "target-changed", recoveries };
      }

      const moved = Math.hypot(x - Number(lastX), y - Number(lastY));
      if (moved >= cfg.progressCm) {
        lastX = x;
        lastY = y;
        lastProgressAt = now;
        recoveries = 0;
        return { action: "none", reason: "progress", recoveries };
      }

      const stalledFor = now - Number(lastProgressAt);
      if (stalledFor < cfg.stallMs) {
        return { action: "none", reason: "watching", recoveries, stalledFor, staleFor };
      }
      recoveries += 1;
      lastProgressAt = now;
      return recoveries >= cfg.maxRecoveries
        ? { action: "leave", reason: "repeated-stall", recoveries, stalledFor, staleFor }
        : { action: "replan", reason: "movement-stall", recoveries, stalledFor, staleFor };
    },
    reset,
    snapshot() {
      return { lastProgressAt, lastFreshAt, recoveries, targetKey: lastTargetKey };
    }
  };
}
