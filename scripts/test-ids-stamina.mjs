/**
 * H3/H2 回归测试:身份键字符串化 与 自动攻击体力 fail closed。
 *
 * 覆盖:
 *  1. idKey 对 null/undefined → "",数字/字符串 → String(value);
 *  2. 超大字符串 ID("9007199254740992" / "9007199254740993")作为 Map/Set 身份键不碰撞;
 *  3. finiteStaminaMs 对 undefined/null/NaN/非数字字符串 → null(未知体力 fail closed);
 *  4. finiteStaminaMs 对有限非负数值 → 原值(可用于连发预算)。
 *
 * 实现说明:idKey / finiteStaminaMs 定义在 userscript pageMain 内部(页面上下文),
 * 这里通过正则从其源码抽取函数体,用 vm 隔离求值,避免依赖整个游戏页面环境。
 * Run: node scripts/test-ids-stamina.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
// idKey/finiteStaminaMs 已被抽到 src/shared 并在 build 时内联进 dist。
// 本测试读取构建产物 dist(确保 `npm run build` 已执行;release:check 会先 build)。
const sources = {
  pc: fs.readFileSync(path.join(root, "dist", "grasp-rat-gold-runner.user.js"), "utf8"),
  mobile: fs.readFileSync(path.join(root, "dist", "grasp-rat-gold-runner-mobile.user.js"), "utf8")
};

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

function extractFunction(source, name) {
  const re = new RegExp("function\\s+" + name + "\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\s*\\}\\n(?=\\s*function\\s)", "m");
  const body = source.match(re);
  assert.ok(body, `应在源码中找到 function ${name}`);
  return body[1];
}

function loadHelpers(source, helpers) {
  const defs = helpers.map(n => `${(n === "idKey") ? "function idKey(value) {" : "function finiteStaminaMs(raw) {"}${extractFunction(source, n)}\n}`).join("\n");
  const exports = helpers.map(n => `globalThis.__t_${n} = ${n};`).join("\n");
  const code = `${defs}\n${exports}`;
  const sandbox = { Math, Number, String, globalThis: {} };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "extracted-helpers.js" });
  return Object.fromEntries(helpers.map(n => [n, sandbox[`__t_${n}`]]));
}

const pc = loadHelpers(sources.pc, ["idKey", "finiteStaminaMs"]);
const mobile = loadHelpers(sources.mobile, ["idKey", "finiteStaminaMs"]);

for (const [label, helpers] of [["PC", pc], ["Mobile", mobile]]) {
  // ---- idKey 基础 ----
  test(`${label} idKey: null/undefined → ""`, () => {
    assert.equal(helpers.idKey(null), "");
    assert.equal(helpers.idKey(undefined), "");
  });

  test(`${label} idKey: 数字与字符串归一为字符串`, () => {
    assert.equal(helpers.idKey(28886), "28886");
    assert.equal(helpers.idKey("28886"), "28886");
    assert.equal(helpers.idKey(0), "0");
    assert.equal(helpers.idKey(""), "");
  });

  test(`${label} idKey: 超大 ID 原样保留为字符串`, () => {
    assert.equal(helpers.idKey("9007199254740992"), "9007199254740992");
    assert.equal(helpers.idKey("9007199254740993"), "9007199254740993");
    assert.notEqual(helpers.idKey("9007199254740992"), helpers.idKey("9007199254740993"));
  });

  test(`${label} idKey: 作为 Map/Set 键不碰撞`, () => {
    const seen = new Set([helpers.idKey("9007199254740992"), helpers.idKey("9007199254740993")]);
    assert.equal(seen.size, 2, "两个超大且相邻的字符串 ID 必须是不相同键");
    const map = new Map();
    map.set(helpers.idKey("9007199254740992"), "a");
    map.set(helpers.idKey("9007199254740993"), "b");
    assert.equal(map.get(helpers.idKey("9007199254740992")), "a");
    assert.equal(map.get(helpers.idKey("9007199254740993")), "b");
    assert.equal(map.size, 2, "两个字符串键必须共存于同一 Map");
    // 旧实现 Number("9007199254740993") 会舍入成 2^53,与
    // "9007199254740992" 碰撞——这正是 H3 要修的 bug。
    assert.equal(Number("9007199254740993"), 9007199254740992, "原始 JS 舍入事实:Number 会丢失超安全整数 ID");
    assert.notEqual(helpers.idKey(9007199254740993), helpers.idKey("9007199254740993"),
      "数字字面量已舍入,必须用字符串形式保留原始 ID");
  });

  // ---- finiteStaminaMs:未知体力 fail closed ----
  test(`${label} finiteStaminaMs: undefined/null/NaN/非数字 → null(不发射)`, () => {
    assert.equal(helpers.finiteStaminaMs(undefined), null);
    assert.equal(helpers.finiteStaminaMs(null), null);
    assert.equal(helpers.finiteStaminaMs(NaN), null);
    assert.equal(helpers.finiteStaminaMs("abc"), null);
    assert.equal(helpers.finiteStaminaMs(""), null);
    assert.equal(helpers.finiteStaminaMs("   "), null, "纯空白串算未知,不算 0 体力");
    assert.equal(helpers.finiteStaminaMs({}), null);
  });

  test(`${label} finiteStaminaMs: 有限非负数值 → 原值(可参与连发预算)`, () => {
    assert.equal(helpers.finiteStaminaMs(7500), 7500);
    assert.equal(helpers.finiteStaminaMs("7500"), 7500);
    assert.equal(helpers.finiteStaminaMs(0), 0);
    assert.equal(helpers.finiteStaminaMs(499), 499);
  });

  test(`${label} finiteStaminaMs: 负值视为未知(不可发射)`, () => {
    assert.equal(helpers.finiteStaminaMs(-1), null);
    assert.equal(helpers.finiteStaminaMs(-Infinity), null);
    assert.equal(helpers.finiteStaminaMs(Infinity), null);
  });
}

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`);
  process.exit(1);
}
console.log("\nAll ID / stamina tests passed.");