import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyRaidCandidate,
  scoreRaidCandidate,
  chooseProfileOpportunity,
  raidShouldAbort
} from "../src/strategy/profiles/raider.js";
import { createRuntimeWatchdog } from "../src/core/runtime-watchdog.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

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

test("raider: 静止 8 秒且有 Drop 的存活目标可进入掠夺候选", () => {
  const candidate = classifyRaidCandidate(
    { user_id: "enemy", life: "Alive", hpForFire: 30, dropForAvoid: 8, dist: 14000 },
    { firstSeenAt: 1000, lastMovedAt: 0 },
    { hp: 90 },
    9000
  );
  assert.equal(candidate.eligible, true);
  assert.equal(candidate.kind, "afk");
});

test("raider: 活跃目标只有在血量/收益占优时才追击", () => {
  const weak = classifyRaidCandidate(
    { user_id: "weak", life: "Alive", hpForFire: 24, dropForAvoid: 5, dist: 12000 },
    { firstSeenAt: 1000, lastMovedAt: 8500 },
    { hp: 80 },
    9000
  );
  const strong = classifyRaidCandidate(
    { user_id: "strong", life: "Alive", hpForFire: 95, dropForAvoid: 5, dist: 12000 },
    { firstSeenAt: 1000, lastMovedAt: 8500 },
    { hp: 80 },
    9000
  );
  assert.equal(weak.eligible, true);
  assert.equal(weak.kind, "finish");
  assert.equal(strong.eligible, false);
});

test("raider: 无敌目标不进入候选，交战损伤/体力储备触发止损", () => {
  const invincible = classifyRaidCandidate(
    { user_id: "safe", life: "Alive", hpForFire: 20, dropForAvoid: 12, dist: 9000, invincible_remaining_ms: 5000 },
    { firstSeenAt: 0, lastMovedAt: 0 },
    { hp: 90 },
    9000
  );
  assert.equal(invincible.eligible, false);
  assert.equal(invincible.reason, "invincible");
  assert.equal(raidShouldAbort({ hp: 61, stamina_5s_remaining_milli: 9000 }, { kind: "afk", hpForFire: 15 }, 80).reason, "damage-budget");
  assert.equal(raidShouldAbort({ hp: 90, stamina_5s_remaining_milli: 1000 }, { kind: "afk", hpForFire: 15 }, 90).reason, "stamina-reserve");
});

test("raider: 击杀与金币统一评分，15% 迟滞避免来回切换", () => {
  const target = { user_id: "enemy", hpForFire: 12, dropForAvoid: 10, dist: 10000, kind: "finish" };
  const kill = scoreRaidCandidate({ hp: 90, stamina_5s_remaining_milli: 9000, stamina_1h_remaining_milli: 900000 }, target);
  assert.ok(kill && kill.score > 0);
  const held = { kind: "kill", id: "enemy", score: kill.score, adoptedAt: 1000 };
  const coin = { kind: "coin", id: "coin-1", score: kill.score * 1.10 };
  const choice = chooseProfileOpportunity(coin, { ...kill, kind: "kill", id: "enemy" }, held, 2000);
  assert.equal(choice.kind, "kill", "仅高 10% 不应打断已选击杀目标");
  const betterCoin = { ...coin, score: kill.score * 1.20 };
  assert.equal(chooseProfileOpportunity(betterCoin, { ...kill, kind: "kill", id: "enemy" }, held, 2200).kind, "coin");
});

test("watchdog: 移动无进展先重规划，连续卡住升级为离开恢复", () => {
  const watchdog = createRuntimeWatchdog({ stallMs: 4000, staleMs: 12000, maxRecoveries: 2, progressCm: 80 });
  const base = { active: true, expectedMove: true, x: 0, y: 0, targetKey: "coin:a", pulse: "tick:1" };
  assert.equal(watchdog.observe({ ...base, now: 0 }).action, "none");
  assert.equal(watchdog.observe({ ...base, now: 4100 }).action, "replan");
  assert.equal(watchdog.observe({ ...base, now: 8200 }).action, "leave");
});

test("watchdog: 有实际位移会清除卡住累计", () => {
  const watchdog = createRuntimeWatchdog({ stallMs: 4000, staleMs: 12000, maxRecoveries: 2, progressCm: 80 });
  assert.equal(watchdog.observe({ active: true, expectedMove: true, now: 0, x: 0, y: 0, targetKey: "coin:a", pulse: "1" }).action, "none");
  assert.equal(watchdog.observe({ active: true, expectedMove: true, now: 3000, x: 100, y: 0, targetKey: "coin:a", pulse: "2" }).action, "none");
  assert.equal(watchdog.observe({ active: true, expectedMove: true, now: 6500, x: 100, y: 0, targetKey: "coin:a", pulse: "3" }).action, "none");
  assert.equal(watchdog.observe({ active: true, expectedMove: true, now: 7100, x: 100, y: 0, targetKey: "coin:a", pulse: "3" }).action, "replan");
});

test("watchdog: 即使原地待机，服务器脉冲停滞也会触发恢复", () => {
  const watchdog = createRuntimeWatchdog({ stallMs: 4000, staleMs: 12000, maxRecoveries: 2, progressCm: 80 });
  const idle = { active: true, expectedMove: false, x: 0, y: 0, targetKey: "idle", pulse: "tick:9" };
  assert.equal(watchdog.observe({ ...idle, now: 0 }).action, "none");
  assert.equal(watchdog.observe({ ...idle, now: 12100 }).action, "leave");
});

test("build profiles: 生成两个不同 PC 身份，旧模式入口保持隐藏", () => {
  const scavenger = fs.readFileSync(path.join(root, "dist", "grasp-rat-gold-runner.user.js"), "utf8");
  const raider = fs.readFileSync(path.join(root, "dist", "grasp-rat-raider-runner.user.js"), "utf8");
  assert.match(scavenger, /@name Grasp Rat Gold Runner/);
  assert.match(scavenger, /BUILD_PROFILE = "scavenger"/);
  assert.match(raider, /@name Grasp Rat Raider Runner/);
  assert.match(raider, /BUILD_PROFILE = "raider"/);
  for (const built of [scavenger, raider]) {
    assert.match(built, /data-crgr="combat" hidden/);
    assert.match(built, /class="crgr-hunt-row" hidden/);
    assert.match(built, /class="crgr-attack-lock" hidden/);
    assert.doesNotMatch(built, /__CRGR_PROFILE__/);
  }
});

test("build profiles: mobile 产物不携带桌面掠夺/watchdog 模块", () => {
  const mobile = fs.readFileSync(path.join(root, "dist", "grasp-rat-gold-runner-mobile.user.js"), "utf8");
  assert.doesNotMatch(mobile, /function createRuntimeWatchdog/);
  assert.doesNotMatch(mobile, /RAIDER_DEFAULTS/);
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`);
  process.exit(1);
}
console.log("\nAll profile/watchdog tests passed.");
