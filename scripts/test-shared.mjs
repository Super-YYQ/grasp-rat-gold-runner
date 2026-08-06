/**
 * Phase 2 golden 对照测试:src/shared 与 src/strategy/navigation 的纯模块,
 * 必须与 userscript 页面 Runtime(pageMain)内联的旧副本在同一批输入上产生一致结果。
 *
 * 覆盖:
 *   - idKey(大 ID、null/undefined、数字/字符串);
 *   - 数值工具(numberFrom/finiteStaminaMs/dropAmount/readDropAmount);
 *   - 几何(minDistanceToEntities/pointToSegmentDistance/minSegmentThreatDistance/
 *     travelTicks/travelSeconds/steerVector),含零长度线段、非法坐标、空数组;
 *   - 路线评分(routeFirstLegPreferFactor/routeLegSafetyFactor/routeTurnFactor);
 *   - 时间(formatClock)。
 *
 * 实现:从 src/entries/{desktop,mobile}.user.js 提取同名函数体(旧内联版),
 * 与 src/shared 模块(新规范版)分别执行同一批样例,断言结果一致。
 * 常量值也在对照中验证(模块导出常量 vs 页面内联常量文本)。
 * Run: node scripts/test-shared.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import * as ids from "../src/shared/ids.js";
import * as numbers from "../src/shared/numbers.js";
import * as geometry from "../src/shared/geometry.js";
import * as time from "../src/shared/time.js";
import * as routeScore from "../src/strategy/navigation/route-score.js";
import { SpatialGrid } from "../src/strategy/navigation/spatial-grid.js";

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

// ---- 从 entry 源码提取一个函数体(旧内联版) ----
function extractInlineFn(source, name) {
  const re = new RegExp("function\\s+" + name + "\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\s*\\}\\n(?=\\s*(?:function|//|const|let|var|\\}))", "m");
  const m = source.match(re);
  if (!m) throw new Error(`未在 entry 中找到 function ${name}`);
  return m[1];
}

// 在 vm 沙盒里构造"旧内联版"函数对象。
// 依赖的兄弟函数(如 pointToSegmentDistance / travelTicks)也以内联文本注入,
// 保证被提取函数体内的引用可解析。
function inlineFn(source, name, extraDecls = "", deps = []) {
  const body = extractInlineFn(source, name);
  const sandbox = { Math, Number, String, Date, Infinity, Set, Map, globalThis: {} };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const depDecls = deps.map(d => `function ${d}(${argsOf(d)}) {\n${extractInlineFn(source, d)}\n}`).join("\n");
  const code = `${extraDecls}\n${depDecls}\nfunction ${name}(${argsOf(name)}) {\n${body}\n}\nglobalThis.__fn = ${name};`;
  vm.runInContext(code, sandbox, { filename: `inline-${name}.js` });
  return sandbox.__fn;
}

// 从入口源码提取函数签名参数列表(用于重新构造函数)。
function argsOf(name) {
  const sigs = {
    idKey: "value",
    numberFrom: "obj, keys, fallback",
    finiteStaminaMs: "raw",
    dropAmount: "drop",
    readDropAmount: "drop",
    minDistanceToEntities: "x, y, entities",
    pointToSegmentDistance: "px, py, ax, ay, bx, by",
    minSegmentThreatDistance: "ax, ay, bx, by, threats",
    travelTicks: "fromX, fromY, toX, toY",
    travelSeconds: "fromX, fromY, toX, toY",
    steerVector: "rx, ry",
    routeFirstLegPreferFactor: "firstLegCm",
    routeLegSafetyFactor: "fromX, fromY, toX, toY, threats",
    routeTurnFactor: "prevDx, prevDy, nextDx, nextDy",
    formatClock: "ms"
  };
  return sigs[name] || "";
}

// 常量声明文本:内联版依赖的常量在 vm 沙盒里补齐。
const pcConsts = `
  const AXIS_DOMINANCE_RATIO = 1.65;
  const TRAVEL_TICK_DIAGONAL_DIV = 35;
  const TRAVEL_TICK_AXIS_DIV = 42;
  const ROUTE_NEAR_PREFER_CM = 12000;
  const ROUTE_FAR_SOFT_CM = 35000;
  const ROUTE_FAR_FACTOR_FLOOR = 0.28;
  const RICH_ENEMY_KEEP_CM = 22000;
  const RICH_ENEMY_SCAN_CM = 25000;
`;

// Phase 2 接线后,入口不再内联共享函数(改由 build 内联)。golden 对照应读取
// 构建产物 dist(内含内联共享函数),证明"构建出的运行时"与 shared 模块行为一致。
const pcSrc = fs.readFileSync(path.join(root, "dist", "grasp-rat-gold-runner.user.js"), "utf8");
const mobSrc = fs.readFileSync(path.join(root, "dist", "grasp-rat-gold-runner-mobile.user.js"), "utf8");

// ---- ids ----
for (const [label, src] of [["PC", pcSrc], ["Mobile", mobSrc]]) {
  const oldIdKey = inlineFn(src, "idKey");
  test(`${label} idKey golden: 大 ID / null / 数字 / 字符串`, () => {
    const cases = [null, undefined, "9007199254740992", "9007199254740993", 28886, "28886", 0, ""];
    for (const c of cases) {
      assert.equal(ids.idKey(c), oldIdKey(c), `idKey(${String(c)}) 不一致`);
    }
    assert.notEqual(ids.idKey("9007199254740992"), ids.idKey("9007199254740993"));
  });

  // ---- 数值 ----
  const oldNumberFrom = inlineFn(src, "numberFrom");
  const oldStamina = inlineFn(src, "finiteStaminaMs");
  const oldDropAmount = inlineFn(src, "dropAmount");
  const oldReadDropAmount = inlineFn(src, "readDropAmount");
  test(`${label} numberFrom golden`, () => {
    const cases = [
      [{ a: 1 }, ["a"], 0],
      [{}, ["a"], 0],
      [{ a: "x" }, ["a"], 0],
      [{}, [], 42]
    ];
    for (const [obj, keys, fb] of cases) {
      assert.equal(numbers.numberFrom(obj, keys, fb), oldNumberFrom(obj, keys, fb));
    }
  });
  test(`${label} finiteStaminaMs golden: 未知体力 fail closed`, () => {
    const cases = [undefined, null, NaN, "abc", "", "   ", {}, 7500, "7500", 0, 499, -1, Infinity];
    for (const c of cases) {
      assert.equal(numbers.finiteStaminaMs(c), oldStamina(c), `finiteStaminaMs(${String(c)})`);
    }
  });
  test(`${label} dropAmount / readDropAmount golden`, () => {
    const cases = [{}, { amount: 0 }, { amount: "abc" }, { amount: -3 }, { amount: 5 }, { amount: "12" }];
    for (const c of cases) {
      assert.equal(numbers.dropAmount(c), oldDropAmount(c));
      assert.equal(numbers.readDropAmount(c), oldReadDropAmount(c));
    }
  });

  // ---- 几何 ----
  const oldMinDist = inlineFn(src, "minDistanceToEntities");
  const oldPtSeg = inlineFn(src, "pointToSegmentDistance");
  const oldMinSeg = inlineFn(src, "minSegmentThreatDistance", "", ["pointToSegmentDistance"]);
  const oldTravelTicks = inlineFn(src, "travelTicks", "const TRAVEL_TICK_DIAGONAL_DIV=35;const TRAVEL_TICK_AXIS_DIV=42;");
  const oldTravelSeconds = inlineFn(src, "travelSeconds", "const TRAVEL_TICK_DIAGONAL_DIV=35;const TRAVEL_TICK_AXIS_DIV=42;", ["travelTicks"]);

  test(`${label} minDistanceToEntities golden: 空数组/非法/普通`, () => {
    assert.equal(geometry.minDistanceToEntities(0, 0, []), oldMinDist(0, 0, []));
    assert.equal(geometry.minDistanceToEntities(0, 0, []), Infinity);
    const ents = [{ x: 3, y: 4 }, { x: null, y: 5 }, { x: 8, y: 6 }];
    assert.equal(geometry.minDistanceToEntities(0, 0, ents), oldMinDist(0, 0, ents));
  });
  test(`${label} pointToSegmentDistance golden: 零长度线段 / 投影外 / 垂直`, () => {
    const cases = [
      [0, 0, 10, 10, 20, 10],   // 投影在端点外
      [15, 12, 10, 10, 20, 10], // 垂直投影
      [0, 0, 5, 5, 5, 5],       // 零长度线段
      [1, 2, NaN, 0, 3, 0]      // 非法坐标 → Infinity
    ];
    for (const c of cases) {
      assert.equal(geometry.pointToSegmentDistance(...c), oldPtSeg(...c), `ptSeg(${c.join(",")})`);
    }
  });
  test(`${label} minSegmentThreatDistance golden: 空威胁 / 1/4 位置 / 非法威胁`, () => {
    assert.equal(geometry.minSegmentThreatDistance(0, 0, 100, 0, []), oldMinSeg(0, 0, 100, 0, []));
    const threats = [{ x: 25, y: 30 }, { x: null, y: 5 }, { x: 75, y: 0 }];
    assert.equal(geometry.minSegmentThreatDistance(0, 0, 100, 0, threats), oldMinSeg(0, 0, 100, 0, threats));
  });
  test(`${label} travelTicks / travelSeconds golden: 非法坐标 → Infinity`, () => {
    assert.equal(geometry.travelTicks(0, 0, 5000, 0), oldTravelTicks(0, 0, 5000, 0));
    assert.equal(geometry.travelTicks(0, 0, NaN, 0), oldTravelTicks(0, 0, NaN, 0));
    assert.equal(geometry.travelSeconds(0, 0, 5000, 0), oldTravelSeconds(0, 0, 5000, 0));
    assert.equal(geometry.travelSeconds(0, 0, NaN, 0), oldTravelSeconds(0, 0, NaN, 0));
  });
  test(`${label} steerVector golden`, () => {
    const oldSteer = inlineFn(src, "steerVector", "const AXIS_DOMINANCE_RATIO=1.65;");
    const cases = [[0, 0], [200, 150], [300, 50], [80, 60], [50, 0], [0, 50], [100, 100]];
    const norm = v => ({ dx: Object.is(v.dx, -0) ? 0 : v.dx, dy: Object.is(v.dy, -0) ? 0 : v.dy, mode: v.mode });
    for (const [rx, ry] of cases) {
      // 归一 -0(deepEqual 会把 -0 与 0 视为不同,但两者语义等价)。
      assert.deepEqual(norm(geometry.steerVector(rx, ry)), norm(oldSteer(rx, ry)), `steer(${rx},${ry})`);
    }
  });

  // ---- 路线评分 ----
  const oldFirstLeg = inlineFn(src, "routeFirstLegPreferFactor", pcConsts);
  const oldLegSafety = inlineFn(src, "routeLegSafetyFactor", pcConsts, ["minSegmentThreatDistance", "pointToSegmentDistance"]);
  const oldTurn = inlineFn(src, "routeTurnFactor");
  test(`${label} routeFirstLegPreferFactor golden`, () => {
    const cases = [0, 5000, 12000, 20000, 35000, 40000, null];
    for (const c of cases) {
      assert.equal(routeScore.routeFirstLegPreferFactor(c), oldFirstLeg(c), `firstLeg(${c})`);
    }
  });
  test(`${label} routeLegSafetyFactor golden`, () => {
    const threats = [{ x: 25, y: 30 }, { x: 10000, y: 0 }];
    const cases = [
      [0, 0, 100, 0, threats],
      [0, 0, 100, 0, []],
      [0, 0, 30000, 0, [{ x: 5000, y: 0 }]]
    ];
    for (const c of cases) {
      assert.equal(routeScore.routeLegSafetyFactor(...c), oldLegSafety(...c), `legSafety`);
    }
  });
  test(`${label} routeTurnFactor golden`, () => {
    const cases = [[1, 0, 1, 0], [1, 0, -1, 0], [1, 0, 0, 1], [0, 0, 1, 0], [1, 0, 0, 0]];
    for (const c of cases) {
      assert.equal(routeScore.routeTurnFactor(...c), oldTurn(...c), `turn(${c.join(",")})`);
    }
  });

  // ---- 时间 ----
  const oldClock = inlineFn(src, "formatClock");
  test(`${label} formatClock golden`, () => {
    const cases = [0, 3600000, 86399999, null];
    const RealDate = Date;
    for (const c of cases) {
      assert.equal(time.formatClock(c), oldClock(c), `formatClock(${c})`);
    }
  });
}

// ---- 常量值对照:模块声明 vs 页面内联声明 ----
test("常量值对照:shared 模块与页面内联常量一致", () => {
  const checks = [
    ["AXIS_DOMINANCE_RATIO", geometry.AXIS_DOMINANCE_RATIO, 1.65],
    ["TRAVEL_TICK_DIAGONAL_DIV", geometry.TRAVEL_TICK_DIAGONAL_DIV, 35],
    ["TRAVEL_TICK_AXIS_DIV", geometry.TRAVEL_TICK_AXIS_DIV, 42],
    ["ROUTE_NEAR_PREFER_CM", routeScore.ROUTE_NEAR_PREFER_CM, 12000],
    ["ROUTE_FAR_SOFT_CM", routeScore.ROUTE_FAR_SOFT_CM, 35000],
    ["ROUTE_FAR_FACTOR_FLOOR", routeScore.ROUTE_FAR_FACTOR_FLOOR, 0.28],
    ["RICH_ENEMY_KEEP_CM", routeScore.RICH_ENEMY_KEEP_CM, 22000],
    ["RICH_ENEMY_SCAN_CM", routeScore.RICH_ENEMY_SCAN_CM, 25000]
  ];
  for (const [name, moduleVal, expected] of checks) {
    assert.equal(moduleVal, expected, `${name} 应与页面一致`);
  }
});

// ---- SpatialGrid 冒烟(纯迁移,不接线) ----
test("SpatialGrid 迁移后仍能构建/查询", () => {
  const grid = new SpatialGrid(9000).build([{ x: 100, y: 100 }, { x: 8000, y: 8000 }]);
  assert.equal(grid.queryRadius(0, 0, 20000).length, 2);
  const near = grid.nearestWithin(0, 0, 20000);
  assert.ok(near && near.entity.x === 100);
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`);
  process.exit(1);
}
console.log("\nAll shared-module golden tests passed.");