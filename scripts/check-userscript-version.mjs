#!/usr/bin/env node
// 版本一致性检查:package.json 版本 必须 与 PC userscript 头部 @version 一致。
// 手机端是独立组件(自己的版本号),只要求存在 @version。
// 用法:`node scripts/check-userscript-version.mjs`,不一致时退出码非 0。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const pcSrc = fs.readFileSync(path.join(root, "src", "grasp-rat-gold-runner.user.js"), "utf8");
const mobileSrc = fs.readFileSync(path.join(root, "src", "grasp-rat-gold-runner-mobile.user.js"), "utf8");

function userscriptVersion(source) {
  const m = source.match(/^\s*\/\/\s*@version\s+(\S+)/m);
  return m ? m[1] : null;
}

const pcVersion = userscriptVersion(pcSrc);
const mobileVersion = userscriptVersion(mobileSrc);
const pkgVersion = String(pkg.version);

let failed = false;
if (!pcVersion) {
  console.error("PC userscript 缺少 @version"); failed = true;
} else if (pcVersion !== pkgVersion) {
  console.error(`版本不一致:package.json=${pkgVersion} 但 PC userscript=${pcVersion}`);
  failed = true;
} else {
  console.log(`PC userscript @version ${pcVersion} 与 package.json ${pkgVersion} 一致。`);
}

if (!mobileVersion) {
  console.error("mobile userscript 缺少 @version"); failed = true;
} else {
  console.log(`mobile userscript @version ${mobileVersion}(独立组件)。`);
}

if (failed) process.exit(1);