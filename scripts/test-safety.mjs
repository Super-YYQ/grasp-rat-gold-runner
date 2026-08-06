/**
 * Phase 6 安全策略测试(§任务与验收):
 *   - ThreatModel:高 Drop / 最近移动 / 追击时长;
 *   - FleePlanner:反向/锚点/保持,同敌人连续 tick 不重复规避,换敌才新事件;
 *   - LeavePolicy:手动离开不创建自动重连、常态掉血只触发一次、类型分类。
 *
 * 全部用内存 fixture。Run: node scripts/test-safety.mjs
 */
import assert from "node:assert/strict";
import { isRichEnemy, isEscapeThreat, pursuitStatus, sortByThreat } from "../src/strategy/safety/threat-model.js";
import { nextFleeStage, fleeEpisode, FLEE_STAGE_REVERSE, FLEE_STAGE_ANCHOR } from "../src/strategy/safety/flee-planner.js";
import { classifyLeave, shouldAutoReconnect, shouldLeaveOnHpDrop, LEAVE_TYPE } from "../src/strategy/safety/leave-policy.js";

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

// ---- ThreatModel ----
test("threat: 高 Drop 敌人是富敌,低 Drop 非富敌", () => {
  assert.equal(isRichEnemy({ dropForAvoid: 15 }, 10), true);
  assert.equal(isRichEnemy({ dropForAvoid: 5 }, 10), false);
});

test("threat: 170m 逃离威胁 = 高Drop 或(低Drop但最近移动)", () => {
  assert.equal(isEscapeThreat({ dropForAvoid: 15 }, 10, false), true);
  assert.equal(isEscapeThreat({ dropForAvoid: 5 }, 10, true), true, "低Drop但移动 → 逃离威胁");
  assert.equal(isEscapeThreat({ dropForAvoid: 5 }, 10, false), false);
});

test("threat: 追击时长按 enemyMotion 判断", () => {
  const motion = new Map([["k", { firstSeenAt: 1000, lastSeenAt: 5000 }]]);
  const p = pursuitStatus({ key: "k" }, motion, 6000);
  assert.equal(p.pursuing, true);
  assert.equal(p.durationMs, 5000);
  // 超过 10s 未更新 → 不再追击
  const p2 = pursuitStatus({ key: "k" }, motion, 30000);
  assert.equal(p2.pursuing, false);
});

test("threat: sortByThreat 按 drop 降序、距离升序", () => {
  const sorted = sortByThreat([
    { dropForAvoid: 5, dist: 100 },
    { dropForAvoid: 20, dist: 200 },
    { dropForAvoid: 20, dist: 50 }
  ]);
  assert.equal(sorted[0].dist, 50, "同 drop 取更近");
  assert.equal(sorted[0].dropForAvoid, 20);
  assert.equal(sorted[2].dropForAvoid, 5);
});

// ---- FleePlanner ----
test("flee: 无状态 → 纯反向;同敌持续超 hold 且有锚点 → 锚点", () => {
  const stage1 = nextFleeStage(null, 0, false, false, false, null, null);
  assert.equal(stage1.stage, FLEE_STAGE_REVERSE);
  // 同敌超 hold,锚点可用
  const stage2 = nextFleeStage({ key: "k", startedAt: 0, x: null, y: null, drop_id: null, anchorAt: 0 },
    2000, true, false, false, { x: 100, y: 200, drop_id: "a" }, null, 1500, 3500);
  assert.equal(stage2.stage, FLEE_STAGE_ANCHOR);
  assert.equal(stage2.drop_id, "a");
});

test("flee: 锚点到达或过期 → 换锚点或回纯反向", () => {
  const prev = { key: "k", startedAt: 0, x: 100, y: 200, drop_id: "a", anchorAt: 1000 };
  // 到达锚点,无新锚点 → 回纯反向
  const s = nextFleeStage(prev, 2000, true, true, false, null, "a", 1500, 3500);
  assert.equal(s.stage, FLEE_STAGE_REVERSE);
  // 到达锚点,有新锚点 → 换锚点
  const s2 = nextFleeStage(prev, 2000, true, true, false, { x: 300, y: 400, drop_id: "b" }, "a", 1500, 3500);
  assert.equal(s2.stage, FLEE_STAGE_ANCHOR);
  assert.equal(s2.drop_id, "b");
});

test("fleeEpisode: 同敌人连续 tick 不重复计数,换敌才 +1", () => {
  const e1 = fleeEpisode(false, "", "enemyA");
  assert.equal(e1.countIncrement, 1, "首次进入 +1");
  const e2 = fleeEpisode(true, "enemyA", "enemyA");
  assert.equal(e2.countIncrement, 0, "同敌连续 tick 不加");
  const e3 = fleeEpisode(true, "enemyA", "enemyB");
  assert.equal(e3.countIncrement, 1, "换敌 +1");
  assert.equal(e3.fleeKey, "enemyB");
});

// ---- LeavePolicy ----
test("leave: 手动离开 = manual,不创建自动重连", () => {
  assert.equal(classifyLeave("manual", 50, false, 25), LEAVE_TYPE.MANUAL);
  assert.equal(shouldAutoReconnect(classifyLeave("manual", 50, false, 25), true, false), false);
});

test("leave: noReconnect → other,不自动重连", () => {
  assert.equal(classifyLeave("x", 50, true, 25), LEAVE_TYPE.OTHER);
  assert.equal(shouldAutoReconnect(LEAVE_TYPE.DAMAGE, true, true), false);
});

test("leave: 1h体力 → stamina,自动重连", () => {
  assert.equal(classifyLeave("左侧边栏检测到1h体力限制", 50, false, 25), LEAVE_TYPE.STAMINA);
  assert.equal(shouldAutoReconnect(LEAVE_TYPE.STAMINA, true, false), true);
});

test("leave: 掉血且 hp<=25 → lowhp,hp>25 → damage", () => {
  assert.equal(classifyLeave("常态血量下降", 20, false, 25), LEAVE_TYPE.LOWHP);
  assert.equal(classifyLeave("常态血量下降", 50, false, 25), LEAVE_TYPE.DAMAGE);
  assert.equal(shouldAutoReconnect(LEAVE_TYPE.LOWHP, true, false), true);
  assert.equal(shouldAutoReconnect(LEAVE_TYPE.DAMAGE, true, false), true);
});

test("leave: 常态掉血只触发一次,交战不触发", () => {
  assert.equal(shouldLeaveOnHpDrop(80, 70, false, false), true, "首次掉血触发");
  assert.equal(shouldLeaveOnHpDrop(70, 65, false, true), false, "已触发过不再触发");
  assert.equal(shouldLeaveOnHpDrop(80, 70, true, false), false, "交战模式不触发");
  assert.equal(shouldLeaveOnHpDrop(80, 90, false, false), false, "血量上升不触发");
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`);
  process.exit(1);
}
console.log("\nAll safety tests passed.");