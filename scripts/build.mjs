#!/usr/bin/env node
// 确定性 userscript 构建(Phase 1)。
// 输入:src/entries/{desktop,mobile}.user.js(纯 IIFE 体,无 metadata 头)
// 输出:dist/grasp-rat-gold-runner.user.js、grasp-rat-raider-runner.user.js
//      与 grasp-rat-gold-runner-mobile.user.js
//       (esbuild IIFE bundle + 顶部 metadata banner)
// 保证:
//   - 输出为单文件,自包含,无动态 import / 远程 @require / 运行时下载;
//   - target es2020,format iife,只做 syntax folding（保留命名与 pageMain.toString() 注入语义）;
//   - 构建两次输出哈希一致(确定性);
//   - 开发 sourcemap 只写 artifacts/(不提交),正式 dist 不含源码路径泄露。
import { build } from "esbuild";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { desktopMeta, mobileMeta, raiderMeta, renderMetadata } from "./userscript-meta.mjs";
import { sharedInlineText, spliceSharedInline } from "./inline-shared.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const artifactsDir = path.join(root, "artifacts");

// 禁止源码路径泄露:esbuild 默认会在 bundle 里带 "// <entry>" 注释,
// 若 meta 注释里含本地绝对路径会泄露。这里统一生成不含绝对路径的 banner。
function bannerFor(meta) {
  return renderMetadata(meta);
}

// esbuild 默认会在 bundle 前输出一行 "// <entry>" 注释,泄露本地源码路径。
// 确定性构建必须剥离它,避免正式 dist 携带源码路径。
function stripEntryComments(code) {
  return code.replace(/^[ \t]*\/\/ src\/entries\/[^\n]*\n/mg, "");
}

// 读取 entry,把 __SHARED_INLINE__ 标记替换为共享函数内联文本,写出到临时文件。
// 这样 pageMain.toString() 注入时能捕获这些函数(单一真相源)。
function prepareEntry(entry) {
  const srcPath = path.join(root, entry);
  const raw = fs.readFileSync(srcPath, "utf8");
  const inlined = spliceSharedInline(raw, sharedInlineText(raw));
  const tmp = path.join(artifactsDir, "prepared-" + path.basename(entry));
  fs.mkdirSync(artifactsDir, { recursive: true });
  fs.writeFileSync(tmp, inlined, "utf8");
  return tmp;
}

async function buildOne({ entry, out, meta, sourcemap, define }) {
  const preparedEntry = prepareEntry(entry);
  const result = await build({
    entryPoints: [preparedEntry],
    outfile: path.join(root, out),
    bundle: true,
    format: "iife",
    target: "es2020",
    minify: false,
    // 仅做语法级折叠：保留可读命名/格式，同时清掉构建期 profile 的恒假分支。
    minifySyntax: true,
    define: define || {},
    // 不写 sourcemap 到 dist:sourcemap 只在源内嵌 //# sourceMappingURL 时才有用,
    // 我们显式关闭,避免泄露本地路径。
    sourcemap: false,
    banner: { js: bannerFor(meta) },
    charset: "utf8",
    logLevel: "warning"
  });
  // 剥离去掉 esbuild 的入口注释,消除源码路径泄露。
  const outPath = path.join(root, out);
  const built = fs.readFileSync(outPath, "utf8");
  fs.writeFileSync(outPath, stripEntryComments(built), "utf8");
  if (sourcemap) {
    // 开发用 sourcemap 只放 artifacts/,不含于发布产物。
    fs.mkdirSync(artifactsDir, { recursive: true });
    await build({
      entryPoints: [preparedEntry],
      outfile: path.join(artifactsDir, path.basename(out) + ".dev.js"),
      bundle: true,
      format: "iife",
      target: "es2020",
      minify: false,
      minifySyntax: true,
      define: define || {},
      sourcemap: "inline",
      charset: "utf8",
      logLevel: "warning"
    });
  }
  return result;
}

function hashFile(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function main() {
  const devSourcemap = process.argv.includes("--sourcemap");
  const targets = [
    {
      entry: "src/entries/desktop.user.js",
      out: "dist/grasp-rat-gold-runner.user.js",
      meta: desktopMeta,
      define: { __CRGR_PROFILE__: JSON.stringify("scavenger") }
    },
    {
      entry: "src/entries/desktop.user.js",
      out: "dist/grasp-rat-raider-runner.user.js",
      meta: raiderMeta,
      define: { __CRGR_PROFILE__: JSON.stringify("raider") }
    },
    { entry: "src/entries/mobile.user.js", out: "dist/grasp-rat-gold-runner-mobile.user.js", meta: mobileMeta }
  ];

  for (const t of targets) {
    await buildOne({ ...t, sourcemap: devSourcemap });
    const h = hashFile(path.join(root, t.out));
    console.log(`built ${t.out}  sha256=${h.slice(0, 16)}`);
  }

  // 确定性验证:再次构建并比较哈希
  const first = targets.map(t => hashFile(path.join(root, t.out)));
  for (const t of targets) {
    await buildOne(t);
  }
  const second = targets.map(t => hashFile(path.join(root, t.out)));
  const ok = first.every((h, i) => h === second[i]);
  if (!ok) {
    console.error("DETERMINISM FAILED: rebuilt dist differs from first build.");
    process.exit(1);
  }
  console.log("Determinism verified: two builds produced identical dist output.");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
