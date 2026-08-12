#!/usr/bin/env node
// 版本一致性检查:package.json 版本 必须 与 PC userscript 元数据一致。
// 手机端是独立组件(自己的版本号),只要求存在 @version。
// Phase 1 起版本号的单一来源是 scripts/userscript-meta.mjs(从 package.json 读 PC 版本)。
// 用法:`node scripts/check-userscript-version.mjs`,不一致时退出码非 0。
import { desktopMeta, mobileMeta, raiderMeta } from "./userscript-meta.mjs";

let failed = false;

const pkgVersion = desktopMeta.version;
if (!desktopMeta.version) {
  console.error("desktop userscript 缺少 version"); failed = true;
} else {
  console.log(`desktop userscript @version ${desktopMeta.version} 与 package.json 一致。`);
}

if (!mobileMeta.version) {
  console.error("mobile userscript 缺少 version"); failed = true;
} else {
  console.log(`mobile userscript @version ${mobileMeta.version}(独立组件)。`);
}
if (raiderMeta.version !== pkgVersion) {
  console.error(`raider userscript @version=${raiderMeta.version} 与 package=${pkgVersion} 不一致`);
  failed = true;
}

// 校验 @version 与 dist 头部一致性(build 后应同步)。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

function distVersion(file) {
  const p = path.join(root, "dist", file);
  if (!fs.existsSync(p)) return null;
  const m = fs.readFileSync(p, "utf8").match(/^\s*\/\/\s*@version\s+(\S+)/m);
  return m ? m[1] : null;
}

const pcDist = distVersion("grasp-rat-gold-runner.user.js");
const raiderDist = distVersion("grasp-rat-raider-runner.user.js");
const mobileDist = distVersion("grasp-rat-gold-runner-mobile.user.js");
if (pcDist !== desktopMeta.version) {
  console.error(`dist PC @version=${pcDist} 与 meta=${desktopMeta.version} 不一致,请先 npm run build`);
  failed = true;
}
if (mobileDist !== mobileMeta.version) {
  console.error(`dist Mobile @version=${mobileDist} 与 meta=${mobileMeta.version} 不一致,请先 npm run build`);
  failed = true;
}
if (raiderDist !== raiderMeta.version) {
  console.error(`dist Raider @version=${raiderDist} 与 meta=${raiderMeta.version} 不一致,请先 npm run build`);
  failed = true;
}

if (failed) process.exit(1);
console.log("版本一致性检查通过。");
