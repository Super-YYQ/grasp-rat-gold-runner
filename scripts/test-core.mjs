/**
 * Phase 4 core 模块测试(§任务与验收):
 *   - action-arbiter:按优先级选唯一动作,无候选→STOP;
 *   - action-types:优先级表常量、makeCandidate;
 *   - state-machine:显式状态、合法迁移、非法迁移拒绝;
 *   - scheduler:多周期任务统一调度、start/stop 清理。
 *
 * 全部用内存 fixture。同 tick 唯一动作、优先级排序是本阶段核心。
 * Run: node scripts/test-core.mjs
 */
import assert from "node:assert/strict";
import { ACTION_PRIORITY, makeCandidate } from "../src/core/action-types.js";
import { pickAction, withUserInput } from "../src/core/action-arbiter.js";
import { createStateMachine, RUNNER_STATES } from "../src/core/state-machine.js";
import { createScheduler } from "../src/core/scheduler.js";

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log("PASS", name);
  } catch (err) {
    failed += 1;
    console.error("FAIL", name);
    console.error("   ", err && err.message || err);
  }
}

// ---- action-arbiter ----
test("arbiter: 按优先级选唯一动作(受伤离开 > 弹道躲避 > 金币路线)", () => {
  const candidates = [
    makeCandidate("MOVE", "coin", ACTION_PRIORITY.COIN_ROUTE, "金币路线", { vector: { x: 1, y: 0 } }),
    makeCandidate("MOVE", "dodge", ACTION_PRIORITY.PROJECTILE_DODGE, "弹道躲避", { vector: { x: -1, y: 0 } }),
    makeCandidate("LEAVE", "hp", ACTION_PRIORITY.HP_LEAVE, "血量下降", {})
  ];
  const picked = pickAction(candidates);
  assert.equal(picked.type, "LEAVE");
  assert.equal(picked.source, "hp");
  assert.equal(picked.priority, ACTION_PRIORITY.HP_LEAVE);
});

test("arbiter: 同优先级取先提交者(稳定)", () => {
  const a = makeCandidate("MOVE", "coin", 400, "route1", { vector: { x: 1, y: 0 } });
  const b = makeCandidate("MOVE", "coin", 400, "route2", { vector: { x: 0, y: 1 } });
  const picked = pickAction([a, b]);
  assert.equal(picked.reason, "route1");
});

test("arbiter: 用户手动输入优先于自动躲避,且不删除用户按键", () => {
  // 用户按住 W → withUserInput 抬高到 USER_MANUAL_INPUT
  const candidates = [
    makeCandidate("MOVE", "dodge", ACTION_PRIORITY.PROJECTILE_DODGE, "近弹规避", { vector: { x: -1, y: 0 } })
  ];
  const withUser = withUserInput(candidates, ["w"]);
  const picked = pickAction(withUser);
  assert.equal(picked.type, "MOVE");
  assert.equal(picked.source, "user");
  assert.equal(picked.priority, ACTION_PRIORITY.USER_MANUAL_INPUT);
  assert.ok(picked.priority > ACTION_PRIORITY.PROJECTILE_DODGE);
});

test("arbiter: 无候选 → 空闲 STOP", () => {
  const picked = pickAction([]);
  assert.equal(picked.type, "STOP");
  assert.equal(picked.source, "idle");
});

test("arbiter: MOVE 候选缺 vector 时补零向量", () => {
  const c = makeCandidate("MOVE", "coin", 400, "route");
  const picked = pickAction([c]);
  assert.deepEqual(picked.vector, { x: 0, y: 0 });
});

// ---- action-types ----
test("action-types: 优先级表数值递增,IDLE 最低 DEAD 最高", () => {
  assert.ok(ACTION_PRIORITY.DEAD > ACTION_PRIORITY.HP_LEAVE);
  assert.ok(ACTION_PRIORITY.HP_LEAVE > ACTION_PRIORITY.REJOIN_SAFETY_LEAVE);
  assert.ok(ACTION_PRIORITY.REJOIN_SAFETY_LEAVE > ACTION_PRIORITY.USER_MANUAL_INPUT);
  assert.ok(ACTION_PRIORITY.USER_MANUAL_INPUT > ACTION_PRIORITY.PROJECTILE_DODGE);
  assert.ok(ACTION_PRIORITY.PROJECTILE_DODGE > ACTION_PRIORITY.THREAT_FLEE);
  assert.ok(ACTION_PRIORITY.THREAT_FLEE > ACTION_PRIORITY.COMBAT_SPACING);
  assert.ok(ACTION_PRIORITY.COMBAT_SPACING > ACTION_PRIORITY.MANUAL_TARGET);
  assert.ok(ACTION_PRIORITY.MANUAL_TARGET > ACTION_PRIORITY.HUNT_TARGET);
  assert.ok(ACTION_PRIORITY.HUNT_TARGET > ACTION_PRIORITY.COIN_ROUTE);
  assert.ok(ACTION_PRIORITY.COIN_ROUTE > ACTION_PRIORITY.IDLE);
});

// ---- state-machine ----
test("state-machine: CRUISE 可进 HUNT/COMBAT/LEAVING,不可直接 LEAVING->HUNT", () => {
  const sm = createStateMachine(RUNNER_STATES.CRUISE);
  assert.equal(sm.get(), "CRUISE");
  assert.equal(sm.transition(RUNNER_STATES.HUNT, "启用追杀"), true);
  assert.equal(sm.get(), "HUNT");
  assert.equal(sm.transition(RUNNER_STATES.COMBAT, "临时交战"), true);
  assert.equal(sm.transition(RUNNER_STATES.LEAVING, "掉血离开"), true);
  // LEAVING 不能直接回 CRUISE
  assert.equal(sm.transition(RUNNER_STATES.CRUISE, "非法回退"), false);
  assert.equal(sm.get(), "LEAVING");
});

test("state-machine: RAID 可在巡航与掠夺闭环之间合法切换", () => {
  const sm = createStateMachine(RUNNER_STATES.CRUISE);
  assert.equal(sm.transition(RUNNER_STATES.RAID, "选中击杀收益"), true);
  assert.equal(sm.get(), "RAID");
  assert.equal(sm.transition(RUNNER_STATES.CRUISE, "转回金币路线"), true);
});

test("state-machine: 转移监听器收到 prev/new/reason", () => {
  const sm = createStateMachine(RUNNER_STATES.STANDBY);
  const events = [];
  sm.onTransition((prev, next, reason) => events.push({ prev, next, reason }));
  sm.transition(RUNNER_STATES.CRUISE, "start");
  assert.deepEqual(events, [{ prev: "STANDBY", next: "CRUISE", reason: "start" }]);
});

test("state-machine: 同状态转移视为成功(幂等)", () => {
  const sm = createStateMachine(RUNNER_STATES.CRUISE);
  assert.equal(sm.transition(RUNNER_STATES.CRUISE, "noop"), true);
});

// ---- scheduler ----
test("scheduler: 多周期任务按各自周期触发,start/stop 清理", () => {
  let fast = 0, slow = 0;
  const timers = [];
  const inject = {
    setInterval: fn => { const id = timers.length + 1; timers.push({ id, fn }); return id; },
    clearInterval: id => {
      const i = timers.findIndex(t => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    now: () => 0
  };
  const sched = createScheduler(inject);
  sched.register("fast", 50, () => { fast++; });
  sched.register("slow", 100, () => { slow++; });
  sched.start();

  // 模拟 tick:驱动 50ms 一次
  const driver = timers[0].fn;
  // 第一次 tick:两个任务都欠账触发
  driver();
  assert.ok(fast >= 1, "fast 应触发");
  assert.ok(slow >= 1, "slow 应触发(首次欠账)");

  sched.stop();
  assert.equal(timers.length, 0, "stop 后 timer 应被清理");
  assert.equal(sched.count(), 2, "任务注册仍在(可重启)");
});

test("scheduler: unregister 后不再触发", () => {
  let count = 0;
  const timers = [];
  const inject = {
    setInterval: fn => { const id = timers.length + 1; timers.push({ id, fn }); return id; },
    clearInterval: id => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); },
    now: () => 0
  };
  const sched = createScheduler(inject);
  sched.register("t", 50, () => { count++; });
  sched.start();
  sched.unregister("t");
  timers[0].fn();
  assert.equal(count, 0, "unregister 后不应触发");
  sched.stop();
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`);
  process.exit(1);
}
console.log("\nAll core tests passed.");
