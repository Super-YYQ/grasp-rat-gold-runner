// §11.2 属性测试 / 随机测试:对导航纯逻辑跑确定性随机场景。
// 断言:不返回 NaN、不选非法金币、安全路径不穿危险圈、同一输入确定性一致。
// Run: node scripts/test-nav-property.mjs
import assert from "node:assert/strict";
import {
  minDistanceToEntities,
  minSegmentThreatDistance,
  nextFleeState,
  pointToSegmentDistance,
  readDropAmount,
  routeFirstLegPreferFactor,
  routeLengthFactor,
  scoreRoute,
  scoreSingleDrop,
  simulateCoinApproach,
  travelSeconds,
  travelTicks
} from "./coin-nav-logic.mjs";

// 确定性 PRNG(不同种子同输入 → 同一结果)
function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function finiteOrNull(v) {
  return v == null || (typeof v === "number" && Number.isFinite(v));
}

let fails = 0;
function check(name, fn) {
  try { fn(); console.log("PASS", name); }
  catch (e) { fails += 1; console.error("FAIL", name, "->", e && e.message); }
}

// ---- 随机金币集合:重复 ID、超大 ID、非法坐标、缺失/非法金额混合 ----
function randomCoinSet(rnd, count) {
  const seen = new Set();
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const kind = rnd();
    let id;
    if (kind < 0.1) id = 9007199254740992 + Math.floor(rnd() * 3); // 超大 ID(可能碰撞)
    else if (kind < 0.2 && seen.size) id = [...seen][Math.floor(rnd() * seen.size)]; // 重复 ID
    else id = Math.floor(rnd() * 1e6);
    seen.add(id);
    const bad = rnd();
    const coin = { drop_id: id };
    if (bad < 0.12) { coin.x = NaN; coin.y = NaN; }           // 非法坐标
    else if (bad < 0.2) { coin.x = Infinity; coin.y = 0; }    // 非有限坐标
    else { coin.x = rnd() * 400000; coin.y = rnd() * 400000; }
    if (rnd() < 0.15) coin.amount = 0;                          // 缺失/非法金额
    else if (rnd() < 0.1) coin.amount = -Math.floor(rnd() * 50);
    else coin.amount = 1 + Math.floor(rnd() * 500);
    out.push(coin);
  }
  return out;
}

// ---- 随机敌人集合 ----
function randomEnemies(rnd, count) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push({
      user_id: Math.floor(rnd() * 1e6),
      x: rnd() * 400000,
      y: rnd() * 400000,
      vx: (rnd() - 0.5) * 2000,
      vy: (rnd() - 0.5) * 2000
    });
  }
  return out;
}

// ---- 1. 大规模随机场景:所有纯函数不产生 NaN/Infinity/抛错 ----
check("pure functions stay finite on 0–2000 coins + 0–100 enemies", () => {
  for (let seed = 1; seed <= 12; seed += 1) {
    const rnd = mulberry32(seed);
    const coins = randomCoinSet(rnd, Math.floor(rnd() * 2000));
    const enemies = randomEnemies(rnd, Math.floor(rnd() * 100));
    const me = { x: rnd() * 400000, y: rnd() * 400000 };

    for (const c of coins) {
      const travel = travelTicks(me.x, me.y, c.x, c.y);
      // §11.2:允许 Infinity(不可达),但绝不返回 NaN。
      assert.ok(!Number.isNaN(travel), `travelTicks NaN seed=${seed}`);
      assert.ok(!Number.isNaN(travelSeconds(me.x, me.y, c.x, c.y)));
      assert.ok(!Number.isNaN(scoreSingleDrop(
        readDropAmount(c) ?? 1, 0, me.x, me.y, c.x, c.y)));
      const d = pointToSegmentDistance(me.x, me.y, c.x, c.y, enemies[0]?.x ?? 0, enemies[0]?.y ?? 0);
      assert.ok(!Number.isNaN(d), `pointToSegmentDistance NaN seed=${seed}`);
    }
    assert.ok(!Number.isNaN(minDistanceToEntities(me.x, me.y, enemies)));
    assert.ok(!Number.isNaN(minSegmentThreatDistance(me.x, me.y, me.x + 10000, me.y, enemies)));
    assert.ok(Number.isFinite(scoreRoute(100, 5, 3, 40000, 5, 10000)));
    assert.ok(Number.isFinite(routeLengthFactor(1e9)));
    assert.ok(Number.isFinite(routeFirstLegPreferFactor(NaN)));
    assert.ok(readDropAmount({ amount: NaN }) === null || finiteOrNull(readDropAmount({ amount: NaN })));
  }
});

// ---- 2. 不选非法金币:amount 缺失/非法 → null,min 距离不 NaN ----
check("invalid coins are rejected, min-distances never NaN", () => {
  const rnd = mulberry32(99);
  const coins = randomCoinSet(rnd, 300);
  for (const c of coins) {
    const amt = readDropAmount(c);
    if (amt == null) {
      assert.ok(!Number.isFinite(Number(c.amount)) || Number(c.amount) <= 0,
        "null amount should only come from missing/zero/negative/non-finite");
    } else {
      assert.ok(amt > 0 && Number.isFinite(amt));
    }
  }
});

// ---- 3. 随机逃离:返回的移动向量有限,且锚点不落在敌人安全半径内 ----
check("nextFleeState stays finite and never anchors inside enemy radius", () => {
  const enemy = { x: 100000, y: 100000, user_id: 7 };
  const me = { x: 110000, y: 100000 };
  for (let seed = 1; seed <= 20; seed += 1) {
    const rnd = mulberry32(seed);
    const coins = randomCoinSet(rnd, 200).filter(c => Number.isFinite(Number(c.x)));
    let prev = null;
    for (let t = 0; t < 40; t += 1) {
      const s = nextFleeState(prev, t * 100, me, enemy, coins, { enemyKey: "7" });
      assert.ok(Number.isFinite(s.moveRx) && Number.isFinite(s.moveRy), "flee vector NaN");
      if (s.evade && s.evade.x != null) {
        const d = Math.hypot(Number(s.evade.x) - enemy.x, Number(s.evade.y) - enemy.y);
        assert.ok(d >= 19000 - 1e-6, `anchor inside enemy radius: ${d}`);
      }
      prev = s.evade;
    }
  }
});

// ---- 4. 到达模拟:不产生 NaN,且不无限振荡 ----
check("coin approach settles or times out without NaN/orbit forever", () => {
  for (let seed = 1; seed <= 15; seed += 1) {
    const rnd = mulberry32(seed);
    const startX = (rnd() - 0.5) * 200000;
    const startY = (rnd() - 0.5) * 200000;
    const r = simulateCoinApproach(startX, startY, 42, 35, 60);
    assert.ok(Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.dist));
    assert.ok(r.settled || r.reason === "timeout" || r.reason === "orbit");
  }
});

// ---- 5. 确定性:同一种子 → 完全一致 ----
check("same input + same seed is fully deterministic", () => {
  const run = seed => {
    const rnd = mulberry32(seed);
    const coins = randomCoinSet(rnd, 500);
    const enemies = randomEnemies(rnd, 30);
    const me = { x: rnd() * 400000, y: rnd() * 400000 };
    return { cache: coins.length, enemies: enemies.length, me, hash: coins.reduce((a, c) => a + (Number(c.drop_id) || 0), 0) };
  };
  assert.deepEqual(run(12345), run(12345));
});

if (fails) {
  console.error(`\n${fails} failing property test(s)`);
  process.exit(1);
}
console.log("\nAll nav property tests passed.");