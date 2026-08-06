// Phase 2:把 src/shared 与 src/strategy 的纯函数体内联进 userscript 的 pageMain。
//
// 背景:pageMain 通过 toString() 序列化后注入游戏页面上下文,因此 pageMain 内
// 调用的所有 helper 必须物理存在于 pageMain 函数体内(或随其一起注入)。共享模块
// 是 ES module(供测试 import),但运行时不能直接 import(toString 捕获不到模块作用域)。
//
// 方案:build 时把共享模块的"函数声明文本"(去掉 export)内联进 pageMain 的
// 标记区域。这样:
//   - 源码单一真相:逻辑只写一次在 src/shared|strategy;
//   - 运行时正确:内联后 pageMain.toString() 包含这些函数,注入可用。
//
// 用法:build.mjs 读取本模块提供的 inlineText(desktop|mobile),替换 entry 内
// 标记 `// __SHARED_INLINE__` 起始到 `// __SHARED_INLINE_END__` 的区域。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

// 从 ES module 源码提取"可内联声明文本"(去掉 export 前缀与模块级 import)。
// 返回数组:包含 `export function` 与 `export const`(对象/字面量)声明。
// 函数体配平花括号;const 取到行尾(`export const X = {...};` 或 `export const X = 1;`)。
function extractDecls(modulePath) {
  const src = fs.readFileSync(modulePath, "utf8");
  const decls = [];

  // export function
  const fnRe = /^export\s+function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
  let m;
  while ((m = fnRe.exec(src))) {
    const start = m.index;
    const bodyStart = src.indexOf("{", m.index + m[0].length);
    if (bodyStart < 0) continue;
    let depth = 0;
    let end = -1;
    for (let i = bodyStart; i < src.length; i++) {
      const c = src[i];
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    if (end < 0) continue;
    let decl = src.slice(start, end).replace(/^export\s+/, "");
    decls.push(decl);
  }

  // export const (对象/数组/字面量声明,取到语句结束)
  const constRe = /^export\s+const\s+([A-Za-z_$][\w$]*)\s*=/gm;
  while ((m = constRe.exec(src))) {
    const start = m.index;
    // 从 = 后开始找:若为 { 或 [ 则配平,否则到分号
    const eq = src.indexOf("=", m.index);
    const afterEq = eq + 1;
    let end = -1;
    const first = src[afterEq];
    if (first === "{" || first === "[") {
      const open = first;
      const close = open === "{" ? "}" : "]";
      let depth = 0;
      for (let i = afterEq; i < src.length; i++) {
        const c = src[i];
        if (c === open) depth++;
        else if (c === close) { depth--; if (depth === 0) { end = i + 1; break; } }
      }
    } else {
      const semi = src.indexOf(";", afterEq);
      end = semi < 0 ? src.length : semi + 1;
    }
    if (end < 0) continue;
    let decl = src.slice(start, end).replace(/^export\s+/, "");
    decls.push(decl);
  }

  // export class (类声明,配平花括号)
  const classRe = /^export\s+class\s+([A-Za-z_$][\w$]*)/gm;
  while ((m = classRe.exec(src))) {
    const start = m.index;
    const bodyStart = src.indexOf("{", m.index + m[0].length);
    if (bodyStart < 0) continue;
    let depth = 0;
    let end = -1;
    for (let i = bodyStart; i < src.length; i++) {
      const c = src[i];
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    if (end < 0) continue;
    let decl = src.slice(start, end).replace(/^export\s+/, "");
    decls.push(decl);
  }

  return decls;
}

// 收集 esbuild/引擎会合法的标识符名判断:entry 内已声明过的 const/let/function 名。
// 用于跳过会与 pageMain 已有常量冲突的模块级 const(函数体内引用将解析到 pageMain 同名常量)。
function declaredNames(entrySource) {
  const names = new Set();
  const re = /(?:const|let|function|class)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(entrySource))) names.add(m[1]);
  return names;
}

// 跳过 name 已在 entry 中声明的 const 声明(避免重复声明被 esbuild 改名为 X2)。
function isConstCollision(declText, entryNames) {
  const m = /^const\s+([A-Za-z_$][\w$]*)\s*=/.exec(declText);
  return !!(m && entryNames.has(m[1]));
}

// 内联文本:按依赖顺序拼接所有共享函数声明。
// desktop 与 mobile 共用同一套共享模块(纯逻辑),因此内联文本相同。
// Phase 3 加 src/game adapter;Phase 4 加 src/core(scheduler/state-machine/arbiter)。
// 注意:模块级 const 若与 pageMain 已有常量同名,则跳过(函数体引用 pageMain 版本)。
export function sharedInlineText(entrySource) {
  const sharedDir = path.join(root, "src", "shared");
  const navDir = path.join(root, "src", "strategy", "navigation");
  const safetyDir = path.join(root, "src", "strategy", "safety");
  const gameDir = path.join(root, "src", "game");
  const coreDir = path.join(root, "src", "core");
  const modules = [
    path.join(sharedDir, "ids.js"),
    path.join(sharedDir, "numbers.js"),
    path.join(sharedDir, "geometry.js"),
    path.join(sharedDir, "time.js"),
    path.join(navDir, "spatial-grid.js"),
    path.join(navDir, "route-score.js"),
    path.join(navDir, "route-planner.js"),
    path.join(navDir, "arrival-controller.js"),
    path.join(safetyDir, "threat-model.js"),
    path.join(safetyDir, "flee-planner.js"),
    path.join(safetyDir, "leave-policy.js"),
    path.join(gameDir, "contract.js"),
    path.join(gameDir, "entity-normalizer.js"),
    path.join(gameDir, "state-adapter.js"),
    path.join(gameDir, "control-adapter.js"),
    path.join(gameDir, "coordinate-adapter.js"),
    path.join(coreDir, "action-types.js"),
    path.join(coreDir, "action-arbiter.js"),
    path.join(coreDir, "state-machine.js"),
    path.join(coreDir, "scheduler.js")
  ];
  const entryNames = declaredNames(entrySource || "");
  const parts = [];
  parts.push("    // ---- src/shared + src/strategy + src/game + src/core 内联(Phase 2/3/4,单一真相源) ----");
  for (const mod of modules) {
    for (const decl of extractDecls(mod)) {
      if (isConstCollision(decl, entryNames)) continue; // pageMain 已有同名常量
      parts.push("    " + decl.replace(/\n/g, "\n    "));
    }
  }
  return parts.join("\n");
}

// 把 entry 源文本中的共享内联区域替换为新的内联文本。
// 标记:entry 内 `// __SHARED_INLINE__` 到 `// __SHARED_INLINE_END__`(含)。
export function spliceSharedInline(entrySource, inlineText) {
  const startMarker = "// __SHARED_INLINE__";
  const endMarker = "// __SHARED_INLINE_END__";
  const startIdx = entrySource.indexOf(startMarker);
  const endIdx = entrySource.indexOf(endMarker);
  if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) {
    throw new Error("entry 缺少 __SHARED_INLINE__ 标记区域");
  }
  const before = entrySource.slice(0, startIdx);
  const after = entrySource.slice(endIdx + endMarker.length);
  return before + startMarker + "\n" + inlineText + "\n    " + endMarker + after;
}