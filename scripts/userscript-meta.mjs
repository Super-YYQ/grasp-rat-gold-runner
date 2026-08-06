// userscript 元数据的单一来源(Phase 1 §任务4)。
// build.mjs 用它在打包后拼接 banner;版本检查与发布门禁也从这里读取,
// 避免 src/entries 与 package.json 各自维护版本号导致漂移。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

export const desktopMeta = {
  name: "Grasp Rat Gold Runner",
  namespace: "https://grasp-rat-game.h-e.top/",
  version: pkg.version,
  description: "Auto collect coin drops with HP-drop leave safety and combat dodge support.",
  match: ["https://grasp-rat-game.h-e.top/*", "https://connect.linux.do/oauth2/authorize*"],
  noframes: true,
  runAt: "document-end",
  grant: ["unsafeWindow", "GM_setValue", "GM_getValue", "GM_deleteValue"]
};

export const mobileMeta = {
  name: "Grasp Rat Gold Runner Mobile",
  namespace: "https://grasp-rat-game.h-e.top/",
  version: "0.1.7",
  description: "Mobile-focused Grasp Rat helper with long-press target, compact controls, hunt drawer, and fire lock drawer.",
  match: ["https://grasp-rat-game.h-e.top/*"],
  noframes: true,
  runAt: "document-end",
  grant: ["unsafeWindow"]
};

// 把 meta 对象渲染成 userscript 头部注释块(含前后分隔)。
// @grant/@match 等由数组渲染;@run-at 等 kebab 键名在这里映射。
export function renderMetadata(meta) {
  const boolKeys = ["noframes"];
  const listKeys = ["match", "grant"];
  const keyMap = { runAt: "run-at" };
  const lines = ["// ==UserScript=="];
  for (const [rawKey, value] of Object.entries(meta)) {
    if (value == null || value === false) continue;
    const key = keyMap[rawKey] || rawKey;
    if (boolKeys.includes(rawKey)) {
      if (value === true) lines.push(`// @${key}`);
      continue;
    }
    if (listKeys.includes(rawKey)) {
      for (const item of value) lines.push(`// @${key}${item ? " " + item : ""}`);
      continue;
    }
    lines.push(`// @${key}${value ? " " + value : ""}`);
  }
  lines.push("// ==/UserScript==");
  return lines.join("\n") + "\n";
}