#!/usr/bin/env node
// 跨平台唯一发布门禁入口(替代仅 Windows 的 release-check.ps1)。
// 依次执行:版本一致 → 语法 → src/dist 哈希 → 导航/重连/DOM 测试 → 禁用 CSS。
// PowerShell 的 release-check.ps1 仅作为包装调用本脚本。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const join = (...p) => path.join(root, ...p);

function run(cli) {
  const r = spawnSync(cli.file, cli.args, { cwd: root, stdio: "inherit" });
  if (r.status !== 0) {
    process.exit(r.status === null ? 1 : r.status);
  }
}

// 1) 版本一致性
run({ file: process.execPath, args: ["scripts/check-userscript-version.mjs"] });

// 2) 语法检查
const sources = [
  "src/grasp-rat-gold-runner.user.js",
  "dist/grasp-rat-gold-runner.user.js",
  "src/grasp-rat-gold-runner-mobile.user.js",
  "dist/grasp-rat-gold-runner-mobile.user.js"
];
for (const s of sources) {
  run({ file: process.execPath, args: ["--check", s] });
}

// 3) src/dist 哈希一致性(改 src 后必须先同步 dist)
const pairs = [
  ["src/grasp-rat-gold-runner.user.js", "dist/grasp-rat-gold-runner.user.js"],
  ["src/grasp-rat-gold-runner-mobile.user.js", "dist/grasp-rat-gold-runner-mobile.user.js"]
];
for (const [src, dist] of pairs) {
  const hash = f => createHash("sha256").update(fs.readFileSync(join(f))).digest("hex");
  if (hash(src) !== hash(dist)) {
    console.error(`src/dist 不一致:${src} 与 ${dist}。请先运行 scripts/sync-dist.ps1。`);
    process.exit(1);
  }
}

// 4) 测试(nav + reconnect 状态机 + reconnect DOM fixture)
run({ file: process.execPath, args: ["scripts/test-coin-nav.mjs"] });
run({ file: process.execPath, args: ["scripts/test-reconnect-safety.mjs"] });
run({ file: process.execPath, args: ["scripts/test-reconnect-dom.mjs"] });
run({ file: process.execPath, args: ["scripts/test-contract.mjs"] });
run({ file: process.execPath, args: ["scripts/test-spatial.mjs"] });

// 5) 禁用 CSS(毛玻璃)
const allUserscriptText = sources.map(s => fs.readFileSync(join(s), "utf8")).join("\n");
if (/backdrop-filter|-webkit-backdrop-filter/.test(allUserscriptText)) {
  console.error("发现禁用 CSS(backdrop-filter)。请使用普通半透明背景。");
  process.exit(1);
}

// 6) DOM fixture 必须存在(release 门禁不允许只靠正则 stub)
const fixtures = [
  "test/fixtures/game-unauth.html",
  "test/fixtures/oauth-consent.html",
  "test/fixtures/oauth-unknown-layout.html",
  "test/fixtures/oauth-decoy-buttons.html"
];
for (const f of fixtures) {
  if (!fs.existsSync(join(f))) {
    console.error(`缺少 DOM fixture:${f}`);
    process.exit(1);
  }
}

console.log("Release checks passed.");