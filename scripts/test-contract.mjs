// 游戏契约分级逻辑测试(审计文档 §4.5)。
// 采集整个 userscript 源,通过它暴露的只读分类器 window/unsafeWindow.__crgrContract
// 验收 READY / DEGRADED / INCOMPATIBLE 分级与 fail closed 判定。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "src", "grasp-rat-gold-runner.user.js"), "utf8");

function loadClassifier() {
  const pageWindow = { eval() {} };
  const sandbox = {
    window: {},
    document: { title: "t", forms: [] },
    location: { hostname: "grasp-rat-game.h-e.top", href: "https://grasp-rat-game.h-e.top/", origin: "https://grasp-rat-game.h-e.top", pathname: "/" },
    unsafeWindow: pageWindow,
    Set,
    Map,
    URL,
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "grasp-rat-gold-runner.user.js" });
  const classifier = pageWindow.__crgrContract && pageWindow.__crgrContract.classify;
  assert.equal(typeof classifier, "function", "__crgrContract.classify 应暴露只读分类器");
  return classifier;
}

const classify = loadClassifier();

function fullReport() {
  return {
    "state": {},
    "state.entities": [],
    "state.coinDrops": [],
    "state.keys": new Map(),
    "state.currentUserId": 1,
    "sendVelocity": function () {},
    "canvas": { getContext: () => ({}) },
    "setPointerFromClient": function () {},
    "screenCenter": function () {}
  };
}

// 全部必需 + 关键可选在场 → READY
{
  const r = classify(fullReport());
  assert.equal(r.status, "READY", "契约完整应为 READY");
  assert.equal(r.missing.length, 0);
  assert.equal(r.criticalMissing.length, 0);
}

// 缺失必需字段(state.coinDrops)→ INCOMPATIBLE + 列出缺失
{
  const rep = fullReport();
  delete rep["state.coinDrops"];
  const r = classify(rep);
  assert.equal(r.status, "INCOMPATIBLE", "缺必需字段应为 INCOMPATIBLE");
  assert.ok(r.missing.includes("state.coinDrops"));
  assert.equal(r.report["state.coinDrops"], "missing");
}

// 必需都在,但缺画布/指针(关键可选)→ DEGRADED
{
  const rep = fullReport();
  delete rep.canvas;
  delete rep.setPointerFromClient;
  const r = classify(rep);
  assert.equal(r.status, "DEGRADED", "缺画布/指针应为 DEGRADED");
  assert.ok(r.criticalMissing.includes("canvas"));
}

// state.keys 必须 Set-like(缺显式 add/has/delete 但非实例 → 不算)
{
  const rep = fullReport();
  rep["state.keys"] = { add() {}, delete() {} };
  assert.equal(classify(rep).status, "READY");
  rep["state.keys"] = {};
  assert.equal(classify(rep).status, "INCOMPATIBLE", "空对象不是 Set-like");
}

// sendVelocity 必须是函数
{
  const rep = fullReport();
  rep.sendVelocity = 42;
  assert.equal(classify(rep).status, "INCOMPATIBLE");
}

// state.entities 必须是数组
{
  const rep = fullReport();
  rep["state.entities"] = { length: 0 };
  assert.equal(classify(rep).status, "INCOMPATIBLE", "非数组 entities 不应通过");
}

console.log("All contract-classifier tests passed.");