/**
 * Regression tests for coin orbit / far-chase / flee-anchor spin bugs.
 * Run: node scripts/test-coin-nav.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  COIN_REACHED_CM,
  coinMoveDecision,
  nextFleeState,
  routeFirstLegPreferFactor,
  scoreRoute,
  scoreSingleDrop,
  simulateCoinApproach,
  travelSeconds
} from "./coin-nav-logic.mjs";

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
    console.error(" ", err && err.message || err);
  }
}

// --- Bug 3: orbit / miss at coin ---
test("coin reach threshold is wide enough to stop before 8-dir overshoot", () => {
  assert.ok(COIN_REACHED_CM >= 100, "COIN_REACHED_CM should be >= 100cm");
});

test("coin approach settles for common step sizes instead of orbiting", () => {
  const starts = [
    [200, 150],
    [300, 50],
    [80, 60],
    [160, 20],
    [90, 90],
    [400, 10]
  ];
  const steps = [80, 120, 150, 195, 250];
  for (const [sx, sy] of starts) {
    for (const step of steps) {
      const result = simulateCoinApproach(sx, sy, step, step * 0.85, 50);
      assert.equal(
        result.settled,
        true,
        `from (${sx},${sy}) step=${step} should settle, got ${result.reason} dist=${result.dist.toFixed(1)}`
      );
    }
  }
});

test("within reach radius movement stops", () => {
  const d = coinMoveDecision(80, 40, Math.hypot(80, 40));
  assert.equal(d.stop, true);
  assert.equal(d.dx, 0);
  assert.equal(d.dy, 0);
});

// --- Bug 2: far coin chase ---
test("near modest coin outranks far rich single after first-leg prefer", () => {
  const near = scoreSingleDrop(5, 2, 0, 0, 6000, 0);
  const far = scoreSingleDrop(30, 0, 0, 0, 45000, 0);
  assert.ok(near > far, `near ${near.toFixed(3)} should beat far ${far.toFixed(3)}`);
});

test("near short route outranks long far cluster route", () => {
  const nearSec = travelSeconds(0, 0, 5000, 0) + travelSeconds(0, 0, 6000, 0);
  const near = scoreRoute(6, 1, nearSec, 11000, 2, 5000);
  const farSec = travelSeconds(0, 0, 28000, 0) + travelSeconds(0, 0, 8000, 0) + travelSeconds(0, 0, 8000, 0);
  const far = scoreRoute(24, 8, farSec, 44000, 3, 28000);
  assert.ok(near > far, `near route ${near.toFixed(3)} should beat far route ${far.toFixed(3)}`);
});

test("first-leg prefer factor decays beyond near band", () => {
  assert.equal(routeFirstLegPreferFactor(5000), 1);
  assert.ok(routeFirstLegPreferFactor(20000) < 0.85);
  assert.ok(routeFirstLegPreferFactor(40000) <= 0.30);
});

// --- Bug 1: flee + coin spin ---
test("flee switches from reverse to safe anchor after hold", () => {
  const me = { x: 0, y: 0 };
  const enemy = { x: 10000, y: 0, user_id: 1 };
  const coins = [
    { drop_id: 1, x: -5000, y: 0 },
    { drop_id: 2, x: -15000, y: 2000 }
  ];
  const t0 = 1000;
  const early = nextFleeState(null, t0, me, enemy, coins);
  assert.equal(early.mode, "reverse");
  const later = nextFleeState(early.evade, t0 + 1600, me, enemy, coins);
  assert.equal(later.mode, "anchor");
  assert.ok(later.evade.x != null);
});

test("flee re-picks or reverses after arriving at anchor instead of spinning", () => {
  const enemy = { x: 20000, y: 0, user_id: 7 };
  const coins = [
    { drop_id: 11, x: 0, y: 0 },
    { drop_id: 12, x: -8000, y: 1000 }
  ];
  // Already on anchor coin 11
  const prev = {
    key: "7",
    startedAt: 0,
    x: 0,
    y: 0,
    drop_id: 11,
    anchorAt: 1000
  };
  const me = { x: 30, y: 20 }; // within COIN_REACHED_CM of anchor
  const next = nextFleeState(prev, 2000, me, enemy, coins);
  // Must not keep targeting the same reached coin.
  assert.notEqual(Number(next.evade.drop_id), 11);
  if (next.mode === "anchor") {
    assert.equal(Number(next.evade.drop_id), 12);
  } else {
    assert.equal(next.mode, "reverse");
  }
  // Movement must be non-zero so we do not idle-spin while enemies approach.
  assert.ok(Math.hypot(next.moveRx, next.moveRy) > 10, "flee move vector must stay active");
});

test("flee stale anchor refreshes away from current coin", () => {
  const enemy = { x: 25000, y: 0, user_id: 3 };
  const me = { x: 500, y: 0 }; // not quite arrived, but anchor is stale
  const coins = [
    { drop_id: 1, x: 0, y: 0 },
    { drop_id: 2, x: -12000, y: 0 }
  ];
  const prev = {
    key: "3",
    startedAt: 0,
    x: 0,
    y: 0,
    drop_id: 1,
    anchorAt: 1000
  };
  const next = nextFleeState(prev, 1000 + 4000, me, enemy, coins);
  assert.notEqual(Number(next.evade.drop_id || 0), 1);
});

// --- Source wiring checks (PC userscript must mirror the pure fixes) ---
test("PC userscript wires coin reach / flee refresh / far-leg prefer", () => {
  const srcPath = path.join(root, "src", "grasp-rat-gold-runner.user.js");
  const src = fs.readFileSync(srcPath, "utf8");
  assert.match(src, /COIN_REACHED_CM\s*=\s*1[0-9]{2,}/, "PC source needs COIN_REACHED_CM >= 100");
  assert.match(src, /dist\s*<=\s*COIN_REACHED_CM|dist\s*<\s*COIN_REACHED_CM/, "PC coin branch must use COIN_REACHED_CM");
  assert.match(src, /FLEE_ANCHOR_MAX_MS/, "PC source needs flee anchor max lifetime");
  assert.match(src, /routeFirstLegPreferFactor|ROUTE_FIRST_LEG|ROUTE_FAR_SOFT_CM|ROUTE_NEAR_PREFER_CM/, "PC source needs far-leg prefer");
  assert.match(src, /excludeId|drop_id[\s\S]{0,80}exclude|safeFleeAnchor\([\s\S]{0,120}exclude/, "PC safeFleeAnchor must support excluding current coin");
});

test("mobile userscript shares coin reach fix", () => {
  const srcPath = path.join(root, "src", "grasp-rat-gold-runner-mobile.user.js");
  const src = fs.readFileSync(srcPath, "utf8");
  assert.match(src, /COIN_REACHED_CM\s*=\s*1[0-9]{2,}/, "mobile source needs COIN_REACHED_CM >= 100");
  assert.match(src, /TRAVEL_TICK_AXIS_DIV|axis \/ 42/, "mobile should use corrected axis travel divisor");
  assert.match(src, /ROUTE_NEAR_PREFER_CM|routeFirstLegPreferFactor|ROUTE_FAR_SOFT_CM/, "mobile needs far-leg prefer");
});

if (failed) {
  console.error(`\n${failed} failing test(s)`);
  process.exit(1);
}
console.log("\nAll coin-nav tests passed.");
