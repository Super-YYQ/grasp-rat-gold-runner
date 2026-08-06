/**
 * Phase 3 adapter fixture 测试(§任务与验收):
 *   - GameContractProbe:完整契约 / 缺 canvas / 缺 sendVelocity;
 *   - GameStateAdapter.snapshot():self/players/coins/input 标准化,
 *     超大字符串 ID、coinDrops 非法元素、字段别名变化、缺失字段保留 null;
 *   - ControlAdapter:move/stop/leave/fire 封装;
 *   - CoordinateAdapter:世界→Client 换算。
 *
 * 全部用内存 fixture,不依赖真实游戏页。
 * Run: node scripts/test-adapter.mjs
 */
import assert from "node:assert/strict";
import {
  classifyGameContract,
  buildContractReport,
  contractPresent
} from "../src/game/contract.js";
import {
  gameStateSnapshot
} from "../src/game/state-adapter.js";
import {
  createControlAdapter
} from "../src/game/control-adapter.js";
import {
  worldToClientFactory,
  gameScreenCenter
} from "../src/game/coordinate-adapter.js";

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

function fullGame() {
  return {
    state: {
      entities: [],
      coinDrops: [],
      keys: new Set(),
      currentUserId: 1,
      minimap: { points: [] },
      pointerWorld: { x: 0, y: 0 }
    },
    els: {
      canvas: { getContext: () => ({}) },
      screenCenter: () => ({ x: 0, y: 0 }),
      setPointerFromClient: () => {}
    },
    sendVelocity: () => {},
    canvas: { getContext: () => ({}) },
    screenCenter: () => ({ x: 0, y: 0 }),
    setPointerFromClient: () => {}
  };
}

// ---- GameContractProbe ----
test("contract: 完整页面契约 → READY", () => {
  const verdict = classifyGameContract(buildContractReport(fullGame()));
  assert.equal(verdict.status, "READY");
  assert.equal(verdict.missing.length, 0);
  assert.equal(verdict.criticalMissing.length, 0);
});

test("contract: 缺少 canvas → DEGRADED(自动移动/攻击关闭,只读展示)", () => {
  const game = fullGame();
  game.els.canvas = undefined;
  game.canvas = undefined;
  const verdict = classifyGameContract(buildContractReport(game));
  assert.equal(verdict.status, "DEGRADED");
  assert.ok(verdict.criticalMissing.includes("canvas"));
  assert.equal(verdict.missing.length, 0, "canvas 缺失不应算 required 缺失");
});

test("contract: 缺少 sendVelocity → INCOMPATIBLE", () => {
  const game = fullGame();
  game.sendVelocity = undefined;
  const verdict = classifyGameContract(buildContractReport(game));
  assert.equal(verdict.status, "INCOMPATIBLE");
  assert.ok(verdict.missing.includes("sendVelocity"));
});

test("contract: 缺 state.coinDrops → INCOMPATIBLE", () => {
  const game = fullGame();
  game.state.coinDrops = undefined;
  const verdict = classifyGameContract(buildContractReport(game));
  assert.equal(verdict.status, "INCOMPATIBLE");
  assert.ok(verdict.missing.includes("state.coinDrops"));
});

test("contractPresent: Set-like / HTMLElement 判定", () => {
  assert.equal(contractPresent(new Set(), "Set-like"), true);
  assert.equal(contractPresent({}, "Set-like"), false);
  assert.equal(contractPresent({ getContext: () => ({}) }, "HTMLElement"), true);
  assert.equal(contractPresent({}, "HTMLElement"), false);
});

// ---- GameStateAdapter.snapshot ----
test("snapshot: self 从 entities 按 currentUserId 匹配,ID 为字符串", () => {
  const game = fullGame();
  game.state.currentUserId = "9007199254740992"; // 超大字符串 ID
  game.state.entities = [
    { user_id: "9007199254740992", x: 100, y: 200, hp: 80, life: "Alive",
      stamina_5s_remaining_milli: 7500, stamina_1h_remaining_milli: 1200000 },
    { user_id: "9007199254740993", x: 300, y: 400, hp: 50, life: "Alive" }
  ];
  const snap = gameStateSnapshot({ state: game.state, selfId: "9007199254740992", now: 1785940000000 });
  assert.equal(snap.now, 1785940000000);
  assert.equal(snap.self.id, "9007199254740992", "self ID 应为字符串");
  assert.equal(snap.self.x, 100);
  assert.equal(snap.self.hp, 80);
  assert.equal(snap.self.stamina5sMs, 7500);
  assert.equal(snap.self.stamina1hMs, 1200000);
  assert.equal(snap.players.length, 1, "另一个实体应进入 players");
  assert.equal(snap.players[0].id, "9007199254740993");
});

test("snapshot: 缺失字段保留 null,不伪造 0", () => {
  const game = fullGame();
  game.state.currentUserId = 1;
  game.state.entities = [{ user_id: 1, x: 10, y: 20 }]; // 无 hp/stamina
  const snap = gameStateSnapshot({ state: game.state, selfId: "1", now: 0 });
  assert.equal(snap.self.hp, null, "缺 hp 应为 null,不是 0");
  assert.equal(snap.self.stamina5sMs, null);
  assert.equal(snap.self.x, 10, "坐标数值保留");
});

test("snapshot: coinDrops 含非法元素不中断,缺失字段保留 null", () => {
  const game = fullGame();
  game.state.coinDrops = [
    null,
    { drop_id: "9007199254740992", x: 5, y: 6, amount: 10 },
    { drop_id: "bad", x: undefined, y: 7, amount: "abc" }
  ];
  const snap = gameStateSnapshot({ state: game.state, selfId: "1", now: 0 });
  // null 元素被跳过;合法金币保留;amount 非法 → null(不强造 1/0),不中断 tick。
  assert.equal(snap.coins.length, 2);
  assert.equal(snap.coins[0].id, "9007199254740992");
  assert.equal(snap.coins[0].amount, 10);
  assert.equal(snap.coins[1].id, "bad");
  assert.equal(snap.coins[1].amount, null, "非法金额应为 null,不中断");
  assert.equal(snap.coins[1].x, null, "缺失坐标应为 null");
});

test("snapshot: 字段别名变化(hp→current_hp, x→pos_x)归一", () => {
  const game = fullGame();
  game.state.currentUserId = 5;
  game.state.entities = [{ user_id: 5, pos_x: 11, pos_y: 22, current_hp: 33 }];
  const snap = gameStateSnapshot({ state: game.state, selfId: "5", now: 0 });
  assert.equal(snap.self.x, 11);
  assert.equal(snap.self.y, 22);
  assert.equal(snap.self.hp, 33);
});

test("snapshot: userKeys 采集用户真实按键", () => {
  const game = fullGame();
  game.state.currentUserId = 1;
  game.state.keys = new Set(["w", "d"]);
  const snap = gameStateSnapshot({ state: game.state, selfId: "1", now: 0 });
  assert.deepEqual(snap.input.userKeys, ["w", "d"]);
});

// ---- ControlAdapter ----
test("control: move 写入脚本移动键并 sendVelocity", () => {
  const keys = new Set(["w"]); // 预置一个用户键,脚本不应删除
  let sent = 0;
  const ctrl = createControlAdapter({ state: { keys }, sendVelocity: () => { sent++; }, scriptMoveKeys: new Set() });
  ctrl.move({ dx: 1, dy: -1 });
  assert.ok(keys.has("d"), "右移应加 d");
  assert.ok(keys.has("w"), "上移应加 w");
  assert.ok(keys.has("w"), "用户原有 w 保留");
  assert.equal(sent, 1);
});

test("control: stop 清空脚本移动键", () => {
  const keys = new Set(["d"]);
  const scriptKeys = new Set(["d"]);
  const ctrl = createControlAdapter({ state: { keys }, sendVelocity: () => {}, scriptMoveKeys: scriptKeys });
  ctrl.stop();
  assert.equal(keys.has("d"), false);
  assert.equal(scriptKeys.size, 0);
});

test("control: leave 点击离开按钮", () => {
  let clicked = 0;
  const ctrl = createControlAdapter({ state: {}, sendVelocity: () => {}, scriptMoveKeys: new Set(),
    findLeaveBtn: () => ({ click: () => { clicked++; } }) });
  assert.equal(ctrl.leave(), true);
  assert.equal(clicked, 1);
  // 找不到按钮 → false
  const ctrl2 = createControlAdapter({ state: {}, sendVelocity: () => {}, scriptMoveKeys: new Set(), findLeaveBtn: null });
  assert.equal(ctrl2.leave(), false);
});

// ---- CoordinateAdapter ----
test("coordinate: worldToClientFactory 用原生 worldToScreen", () => {
  const deps = {
    canvasRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    viewParams: () => ({ scale: 1, cx: 0, cy: 0 }),
    worldToScreen: (x, y) => ({ x, y }),
    overlayRect: { left: 0, top: 0, width: 800, height: 600 },
    viewRadiusCm: 25000,
    localVisual: null
  };
  const toClient = worldToClientFactory({ x: 0, y: 0 }, { left: 0, top: 0 }, deps);
  const p = toClient({ x: 100, y: 200 });
  assert.equal(p.x, 100);
  assert.equal(p.y, 200);
});

test("coordinate: gameScreenCenter 用 screenCenter 或回退", () => {
  const rect = { left: 10, top: 20, width: 800, height: 600 };
  const c = gameScreenCenter(rect, () => ({ x: 50, y: 60 }));
  assert.equal(c.x, 60);
  assert.equal(c.y, 80);
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`);
  process.exit(1);
}
console.log("\nAll adapter tests passed.");