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

// 从 ES module 源码提取"函数声明文本"(去掉 export 前缀与模块级 import)。
// 返回数组,每个元素是一个完整函数声明(含函数体)。
function extractFunctionDecls(modulePath) {
  const src = fs.readFileSync(modulePath, "utf8");
  const decls = [];
  const re = /^export\s+function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
  let m;
  while ((m = re.exec(src))) {
    const name = m[1];
    const start = m.index;
    // 找到函数体的起始 { 与匹配的 }
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
    let decl = src.slice(start, end);
    // 去掉 "export " 前缀
    decl = decl.replace(/^export\s+/, "");
    decls.push(decl);
  }
  return decls;
}

// 内联文本:按依赖顺序拼接所有共享函数声明。
// desktop 与 mobile 共用同一套共享模块(纯逻辑),因此内联文本相同。
export function sharedInlineText() {
  const sharedDir = path.join(root, "src", "shared");
  const navDir = path.join(root, "src", "strategy", "navigation");
  const modules = [
    path.join(sharedDir, "ids.js"),
    path.join(sharedDir, "numbers.js"),
    path.join(sharedDir, "geometry.js"),
    path.join(sharedDir, "time.js"),
    path.join(navDir, "route-score.js")
  ];
  const parts = [];
  parts.push("    // ---- src/shared + src/strategy 内联(Phase 2,单一真相源) ----");
  for (const mod of modules) {
    for (const decl of extractFunctionDecls(mod)) {
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