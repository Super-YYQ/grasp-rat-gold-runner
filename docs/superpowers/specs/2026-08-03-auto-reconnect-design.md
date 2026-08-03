# 自动重连 (auto-reconnect) 设计

## Context

现状:脚本在 HP 掉血、1h 体力耗尽时会点击游戏页"离开"按钮脱战。但离开后,浏览器跳转到 `https://connect.linux.do/oauth2/authorize?...`,需要人手点"允许"按钮才能重回游戏,无人值守挂机因此中断。

当前 `src/grasp-rat-gold-runner.user.js` 的 `@match` 只匹配 `https://grasp-rat-game.h-e.top/*`,`@grant` 只有 `unsafeWindow`。脚本是单文件、靠 `pageMain()` 注入页面上下文。

目标:让"掉血离开"后自动重连;1h 体力耗尽离开后等满 1 小时再重连;掉血但离开时 HP 已很低(≤25)的,等 30 分钟再重连;手动点"离开"不自动重连。

PC 优先,单文件实现,手机端本轮不动。

## 技术路线(方案 A)

`connect.linux.do` 是与游戏不同的域名,浏览器导航到达后,原游戏页脚本随导航销毁,内存态对象(`runner`)无法跨域存活。因此:

1. 给现有 userscript 增加 `@match https://connect.linux.do/*`,补 `@grant GM_setValue / GM_getValue / GM_deleteValue`,让脚本也能在 OAuth 授权页注入。
2. 在 IIFE 最外层(注入前)用 `location.hostname` 分流:
   - 游戏域 → 走现有 `pageMain()` 全套逻辑。
   - `connect.linux.do` → 走一个**独立的轻量入口 `oauthReconnectMain()`**,只做"读存储→算冷却→找允许按钮→静默轮询→点掉",不注入任何 HUD、不碰游戏变量。
3. 跨域共享的唯一通道是篡改猴的 `GM_setValue/GM_getValue`(按脚本 `@namespace` 共享,跨域名可读写)。localStorage 跨源不可用,排除。

## 冷却规则

| 离开类型 | 触发场景 | 冷却 |
|---|---|---|
| `damage` | 常态 HP 下降离开、停止模式血量下降离开、临时交战低血离开(HP>25) | 立即重连(0) |
| `lowhp` | 掉血离开且记录的离开时 HP ≤ 25 | 30 分钟 |
| `stamina` | 左侧边栏检测到 1h 体力限制离开 | 60 分钟 |
| `manual` | 用户手动点"离开"按钮 | 不重连 |
| 其它(未知/兜底) | — | 不重连,保留记录供排查 |

- 低血阈值复用现有 `COMBAT_CRITICAL_HP`(25),不引入新魔数。
- 冷却时长为脚本顶部常量 `RECONNECT_COOLDOWN_LOWHP_MS = 30*60*1000`、`RECONNECT_COOLDOWN_STAMINA_MS = 60*60*1000`。
- "离开时 HP"以 `clickLeave` 内 `getMe()` 拿到的 HP 为准(离开那一刻记录),不依赖重连后读血。

## 数据模型(GM 存储)

单一键 `crgrLeaveRecord`,值为对象:

```
{
  type: "damage" | "lowhp" | "stamina" | "manual" | "other",
  ts: <离开时刻 epoch ms>,
  hp: <离开时 HP 或 null>,
  reason: <原 reason 字符串,便于排查>,
  v: 1
}
```

- 游戏域 `clickLeave` 在记录 runner 状态后、点击离开按钮前写入此键。
- `connect.linux.do` 入口读此键计算冷却;`manual`/`other`/无记录 → 不重连。
- 重连成功(点了"允许")后不清除记录;授权页跳回游戏后,游戏域会在新一轮"首次识别到玩家实体 / 启动"时判定"已重回游戏",由游戏域用 `GM_deleteValue` 清掉过期记录,避免它一直影响后续判断。具体:游戏域 `start()` 或 `checkHourlyStaminaLimitLeave` 复位分支附近,加一个"若记录存在且距 ts 已过 X 秒且当前已在游戏中"则清除。

为避免重连后又立刻被同一原因离开、形成"离开→重连→又离开"空转,授权页在判 `manual` 之后再加一道:**同一 `ts` 的记录若已被本脚本实例处理过(在内存 `Set` 里),不重复点** —— 但跨导航内存会丢,所以更可靠的兜底是:点了"允许"后写一个 `crgrReconnectAck` 短期标志(同 ts)5 分钟,授权页若读到同 ts 的 ack 则不再点。这一层防"授权页被刷新导致重复点允许"。

## 游戏域改动

### 头部
- `@match` 增加 `https://connect.linux.do/*`。
- `@grant` 增加 `GM_setValue`、`GM_getValue`、`GM_deleteValue`。
- `@version` 升小版本(v1.8.x → v1.9.0)。

### IIFE 顶部分流
在 `(function(){ ... })()` 开头、注入逻辑之前:
```
if (location.hostname.endsWith("connect.linux.do")) {
  try { oauthReconnectMain(); } catch (_) {}
  return;            // 不注入 pageMain
}
```
注意 `oauthReconnectMain` 必须定义在 IIFE 作用域能访问的位置(顶层函数声明,或定义在分流之前)。

### 写离开记录
在 `clickLeave(reason)` 内,`getMe()` 之后、`button.click()` 之前:
- 判定 `type`:
  - `runner.hourlyLimitLeaveTriggered` 且 reason 含"1h体力限制" → `stamina`
  - `reason === "manual"` 或来自点击"离开"按钮的事件 → `manual`
  - 否则:HP ≤ `COMBAT_CRITICAL_HP` → `lowhp`,HP > 该值 → `damage`
- `runner.autoReconnect` 开关若为 `false` 则仍写记录(便于排查),但 `type` 上不改号;重连与否由授权页读"开关状态"决定(见下)。

### 自动重连总开关
- `runner.autoReconnect`(布尔,默认 `true`),持久化到 GM 键 `crgrAutoReconnect`(读不到默认 true)。
- HUD:在"离开"按钮左侧补一个 `data-crgr="reconnect"` 按钮,文本"重连 ON/OFF",沿用现有按钮样式;绑定 click 切换并存 GM。
- `clickLeave` 写离开记录时把开关状态一并写入记录的 `enabled` 字段,授权页据此决定是否点允许(开关关闭则不点,无论冷却)。
  - 注:开关是脚本级,授权页也可读 `GM_getValue("crgrAutoReconnect")` 直接取,二选一选"授权页直接读开关",更简洁,`enabled` 仅作冗余排查。

### 重回游戏后清理
在 `start()` 内、或 `renderDropLeaderboard` 首次识别玩家实体的分支,加:读取 `crgrLeaveRecord`,若其 `ts` 距今超过 10 秒且当前 `getMe()` 存在 → `GM_deleteValue`。避免旧记录长期残留。

## `connect.linux.do` 入口 `oauthReconnectMain()`

纯前端、不依赖游戏变量。流程:

1. 读 `GM_getValue("crgrAutoReconnect")`,默认 `true`;为 `false` → 直接 return(不重连)。
2. 读 `crgrLeaveRecord`;无记录 / `type==="manual"` / `type==="other"`/未知 → 设浏览器标题角标"不重连",return。
3. 按 `type` 算冷却截止 `ts + cooldown`:
   - `damage` → 0
   - `lowhp` → 30 min
   - `stamina` → 60 min
4. 读 `crgrReconnectAck`,若与当前 `crgrLeaveRecord.ts` 相同 → 已重连过/防重复,return。
5. 设一个 `setInterval`(600ms)轮询:
   - 计算剩余冷却。若未到冷却截止 → 更新页面标题显示倒计时(如 `还需 NN:NN 重连`),不操作按钮,继续轮询。
   - 冷却已到 → 在页面里找"允许"按钮:
     - 选择器优先:textContent 含"允许"或"Authorize"/"Accept"/"Continue" 的 `button` 或可点击元素;容错多种文案。
     - 找不到 → 不乱点、不报错,标题显示"等待授权页加载",继续轮询(最多轮询 N 分钟后停,避免无限占用)。
     - 找到 → `GM_setValue("crgrReconnectAck", record.ts)`,然后 `button.click()`,停轮询。
6. 全程不注入任何 DOM 面板,只改 `document.title` 做最小可见提示。

容错:全程 `try/catch`,任何异常只静默 return,绝不抛到页面。

## 边界与安全

- 手动离开不重连;手动重连进入游戏后旧记录清理。
- 不读取 cookie/localStorage 敏感信息;只用 GM 脚本存储(GM 值按 namespace 隔离,只存离开原因/时间/HP/开关开关态,不含令牌密码)。
- 不绕过任何 Chrome 限制,不操作 `chrome-extension://` 页面。
- 授权页脚本对未知页面结构保持静默,只在确认看到"允许"类按钮时点。
- 不删除旧文件。

## 验证

```
node --check .\src\grasp-rat-gold-runner.user.js
node --check .\dist\grasp-rat-gold-runner.user.js
```

人工(用户)验证项:
- 掉血离开 → 自动跳授权页 → 自动点允许 → 回到游戏、脚本恢复运行。
- 1h 体力离开 → 授权页标题显示倒计时 60 分钟,到期才点。
- 手动点离开 → 授权页不点允许。
- 重连开关关 → 授权页不点允许。
- 授权页未加载出按钮 → 标题显示等待,不乱点。

## 发布流程

1. 改 `src/grasp-rat-gold-runner.user.js`。
2. 升 `@version`,写 `docs/changelog.md` 一条。
3. `scripts\sync-dist.ps1` 同步到 `dist`。
4. 两个 `node --check`。
5. `scripts\release-check.ps1`。
6. 提交并推送。
