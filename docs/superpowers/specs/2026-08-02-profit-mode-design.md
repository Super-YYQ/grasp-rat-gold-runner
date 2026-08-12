# 收益模式 (profit-mode) 设计

> 状态: **2.0.0 已交付，本文保留为历史设计输入**。实际交付名为 Raider（杀敌掠夺），
> 发布文件是 `dist/grasp-rat-raider-runner.user.js`。实现复用同一桌面入口的构建期 profile，
> 没有复制另一份大源码。实际阈值、止损与恢复规则以 `docs/behavior.md` 为准。

## Context

脚本现取向是"挂机吃金币、被打了就跑",不主动 PVP。用户反馈希望有一个**专注金币收益、含击杀挂机玩家掉落**的精简模式:

- 主动接近**长时间静止且有 Drop**的挂机玩家,击杀后拾取其掉落金币
- 非挂机活跃玩家进入危险距离 → 逃离,不主动攻击
- 击杀收益 vs 地上金币路线用统一评分比较

游戏硬数据(来自游戏内置新手教程 `/web/app.js?helpModal`):
- 玩家速度 10 m/s;移动 10m 消耗 1 点体力
- 射击:0.5 体力/发、3 伤害/发、0.1s/发上限、射程 150m
- HP 100;5s 体力满时每 5s 自动回 1 HP
- 传送 1500 体力(本模式不用)

所有量纲可精确折算,**不需要拍 "1 体力 = N 金币" 的玄学系数**。

## 交付形态

由 `src/entries/desktop.user.js` 生成独立发布 userscript `dist/grasp-rat-raider-runner.user.js`，与游走拾荒/手机脚本并列。沿用 `@grant unsafeWindow`、`pageMain()` 注入方式；两个 PC 构建互斥启用。

## 模块与复用

新建 `src/grasp-rat-profit-runner.user.js`,单文件,模块用注释区隔。

| 模块 | 职责 | 来源 |
|---|---|---|
| 注入/等待 | 等 `state/els/sendVelocity` 就绪 | 复用 `waitForGame`/`ready` |
| 移动 & 准星 | `setVelocity`/`moveToward`/`steerVector`/`setPointerFromClient`/`worldToScreen` | 原样复用 |
| 金币候选 & 路线 | `coinCandidates`/`buildRouteFromAnchor`/`bestDropRoute` | 原样复用(含 v1.8.0 长度软折扣) |
| 挂机识别 | 新增。`trackEnemyMotion` 基础上算"静止 N 秒 + Drop>0 + 存活 + 非无敌" | 复用 `enemyMotion` |
| 击杀候选评分 | 新增 `killCandidateScore(me, target)` | 复用子弹/伤害常量、`worldToScreen` |
| 统一评分池 | 新增 `bestProfitAction(me)` 比较金币路线 vs 击杀挂机 | 复用 `bestDropRoute` 输出 |
| 自动开火 | 精简版。锁定挂机目标、连发至死亡或脱战 | 复用 `shoot` 调用 |
| 拾取掉落 | 击杀后掉落进 `coinDrops` → 自动入路线候选池 | 无需新代码 |
| 安全逃离 | 富敌/移动敌 170m/220m 规避,非挂机进危险即逃 | 复用 `escapeEnemies`/`fleeFrom`(含两阶段锚点) |
| 巡航轻量躲弹 | v1.8.1 `handleCruiseProjectileDodge` | 原样复用 |
| HP/体力安全离开 | HP 下降离开、5s 体力耗尽停移、1h 体力限制离开 | 复用,延续"挨一下就跑" |

砍掉:临时交战模式、追杀模式、ATTACK BUFFER 手动锁定列表、DROP TOP 5→追杀联动。
保留:右键一键前往(赶路用)。

## 优先级(step 主循环顺序,严格从上到下,命中即 return)

1. 找不到当前玩家实体 → 停移等待
2. 记录收益、刷新 HUD
3. 左侧官方面板出现 `1h体力限制` → 点离开(复用现逻辑)
4. 非存活/死亡 → 停移
5. 5s 体力耗尽(剩余毫秒≤0) → 停移等待
6. **HP 下降 → 立即 `clickLeave`**(精简版延续"挨一下就跑";攻击挂机期间同样适用,因为挂机不还手,HP 一旦下降基本是被第三方活跃玩家打中,正是该跑的信号)
7. 170m 紧急逃离(含两阶段锚点)/ 220m 富敌拉开 → 逃离;**攻击挂机中亦中断攻击转入逃离**
8. 巡航轻量躲弹(v1.8.1) → 压迫高/近弹则横移,否则放行
9. 右键手动坐标目标 → 前往
10. **统一收益决策**(核心):
    - 计算"金币路线"与"击杀挂机候选"两类净收益/时间
    - 取最高者执行
    - 金币路线:前往首站
    - 击杀挂机:接近 150m 射程内 → 锁定 → 连续开火至死亡/脱战
11. 无任何候选(安全但无金币无挂机) → 保距停移观察

注:攻击挂机期间 HP 下降会先命中第 6 优先级 `clickLeave`,所以无需为击杀单独设"HP 安阈值"。脱战是攻击阶段被第三方反袭的合格信号。

## 挂机判定

```
isAfkTarget(enemy) 当且仅当:
  - life === "Alive"
  - Drop = death_reward_preview ?? death_drop_coins > 0
  - 最近 AFK_STILL_MS(8s) 内坐标位移 < AFK_MOVE_EPSILON_CM(50cm)
  - 非无敌:读取 entity.invincible_until / invuln_remaining_ms / inv 等字段,
    任一存在且 > 当前时间/正数则跳过;字段缺失时默认非无敌
  - 非 self
```

数据来源:复用 `runner.enemyMotion`(`lastMovedAt`、坐标)。  
不满足挂机的敌人:进入 170m 逃离;**永不主动攻击**。

## 击杀评分

```
shotsNeeded = ceil(targetHp / FIRE_DAMAGE_PER_SHOT)        // 满血 34
fireSeconds = shotsNeeded * FIRE_RATE_MS / 1000              // 满血 3.4s
fireStamina = shotsNeeded * FIRE_STAMINA_PER_SHOT_MILLI / 1000  // 满血 17 点

approachDistCm = max(0, distToTarget - FIRE_RANGE_CM)        // 仅需跑到射程内
// approachPoint = 沿 me→target 方向、距 target 恰好 FIRE_RANGE_CM 的点
// 若已在射程内,approachDistCm=0,approachPoint=me
approachSeconds = travelSeconds(me, approachPoint)
approachStamina = approachDistCm / 1000                       // 10m=1体力

// 开火点≈approachPoint;挂机尸体≈当前 target 坐标(静止)
pickupDistCm = hypot(approachPoint - target)
pickupSeconds = travelSeconds(approachPoint, target)
pickupStamina = pickupDistCm / 1000

totalSeconds = approachSeconds + fireSeconds + pickupSeconds
totalStamina = approachStamina + fireStamina + pickupStamina

// 体力硬门槛:当前 5s 体力不足以打完一局 → 否决该候选
if (stamina_5s_remaining_milli / 1000 < totalStamina) → reject

// 体力机会成本:1 体力 ≈ 1 秒等效移动机会(10m/s)
staminaTimePenalty = totalStamina * STAMINA_TIME_EQUIV_SECONDS_PER_POINT

expectedCoins = Drop
killScore = expectedCoins / (totalSeconds + staminaTimePenalty + 1.4)
```

挂机目标死后掉落金币会出现在尸点并进 `state.coinDrops`,下一 tick 自入金币路线候选池自动拾取,无需专门"捡尸体"分支。

## 金币路线评分(沿用现逻辑)

`buildRouteFromAnchor` 的 score(含 v1.8.0 长度软折扣)。第一版不再单独加体力成本,因金币路线本只有移动成本、无射击成本,量纲已可与 killScore 对比。如实测量纲偏差,再加移动体力机会成本对齐。

## 统一决策

```
bestProfitAction(me):
  coinRoute = bestDropRoute(me, threats)            // 可能 null
  killCandidates = afkTargets(me)                  // 过滤 + 评分,体力不够的否决
  bestKill = max(killCandidates, by killScore)     // 可能 null

  if both null → idle
  if only coin → adopt coin route
  if only kill → adopt kill target
  if both → 取 score 更高者
```

切换迟滞 `PROFIT_SWITCH_FACTOR = 1.15`:当前动作为 kill 时,新 coin 须高 15% 才切走,反之亦然。避免"打到一半被一颗小金币抢走"。

## 击杀执行状态机

```
IDLE → (选中 kill) → APPROACH(跑到 150m 内)
     → FIRE(锁定 + 连发,按 FIRE_RATE_MS)
     → 任一发生时回到 IDLE:
        - 目标死亡 / 目标消失
        - 目标 movedRecently 翻转(不再挂机)→ 立即停火,下一 tick 由逃离判定接管
        - HP 下降(第 6 优先级先命中 clickLeave)
        - 170m 进来活跃威胁(第 7 优先级先命中逃离)
     → 回到 IDLE 后下一 tick 重跑 bestProfitAction
       (尸体金币已进 coinDrops,路线规划自然拾取)
```

开火中目标 `movedRecently` 翻转(不再挂机)→ 立即停火逃离,不硬刚。这是因为"挂机"一旦开始移动,可能是回到键盘的活跃玩家,持续攻击会变成主动 PVP,违背设计取向。

## runner 新增状态

```
profitAction: null          // { kind: "coin"|"kill", coinRoute|target, score, adoptedAt }
killTarget: null            // { userId, drop, hp, x, y, lastMovedAt }
killPhase: "idle"           // "idle"|"approach"|"fire"|"disengage"
fireStartedAt: 0
fireShots: 0
// 复用现有:fleeAnchor, cruiseDodgeUntil, lastHp, stoppedHpBaseline,
//          enemyMotion, projectileMotion, routeIds, targetId,
//          targetScore, navTarget, lastAction
```

清理点:`clickLeave`/`stop` 时清掉 `killTarget`/`profitAction`、`killPhase` 复位 `"idle"`、清开火定时器。

不引入 `combatMode`/`huntMode`/`autoFireMode` 这三个旧布尔,避免状态概念污染。开火指令直接绑定 `killPhase === "fire"` 单一状态。

## HUD(精简收益面板)

- 顶部 STANDBY/MOVE 行(沿用)
- 总开关 启动/停止(沿用)
- `PROFIT 行`:当前动作`金币4点>路线 / 击杀#1234 Drop8 阶段 FIRE 弹34/体剩23`
- `PROFIT TOP` 列表(左下角):本局单位净收益最高的 3 个挂机候选(用户名 / Drop / 净收益/秒),仅展示点击不动作

砍:DROP TOP 5→追杀联动、追杀输入框、ATTACK BUFFER 列表、临时交战按钮。

## 连线指示器(复用现画线层)

- **金色线**:当前 profitAction 目标(金币或挂机目标)
- **绿色线(新增)**:视野内挂机目标(区分金色=当前目标)
- **蓝色线**:500m 内有 Drop 的非挂机敌人(潜在威胁)
- **红色线**:170m 内危险敌人

## 可调常量(顶部队)

```js
// 挂机判定
const AFK_STILL_MS = 8000;
const AFK_MOVE_EPSILON_CM = 50;
const AFK_MIN_DROP = 1;

// 击杀评分
const FIRE_DAMAGE_PER_SHOT = 3;
const FIRE_STAMINA_PER_SHOT_MILLI = 500;
const FIRE_RATE_MS = 100;
const FIRE_RANGE_CM = 15000;
const STAMINA_MOVE_PER_10M = 1;
const PLAYER_SPEED_CMPS = 1000;
const STAMINA_TIME_EQUIV_SECONDS_PER_POINT = 1.0;

// 决策迟滞
const PROFIT_SWITCH_FACTOR = 1.15;
const PROFIT_REPLAN_MS = 1800;
```

## 工程配套

- `scripts/sync-dist.ps1` / `scripts/release-check.ps1` 增加 profit 脚本的 src↔dist 对
- `package.json` scripts.check 增加 profit 脚本的 `node --check`
- `README.md` / `docs/install.md` 补一条 profit 脚本安装说明(精简版,不替换主脚本)
- 版本号从 `1.0.0` 起步(独立脚本,不与主脚本版本号共享)

## 验证

- `node --check src/grasp-rat-profit-runner.user.js` 及对应 dist 通过
- `scripts/sync-dist.ps1` 同步成功(含 profit 对)
- 用户进游戏实测:
  - 视野内出现长时间静止有 Drop 的挂机玩家 → 脚本接近到 150m 内连发开火
  - 攻击中被第三方活跃玩家打掉 HP → 立即脱战(挨一下就跑)
  - 附近有更优金币团时 → 优先吃金币,击杀候选评分低于金币路线时不发起攻击
  - 挂机目标死后尸点生成掉落 → 自然被路线规划拾取
  - 击杀中目标开始移动(不再挂机) → 立即停火,逃离判定接管
- 实测后可调:挂机判定阈值、切换迟滞、PROFIT TOP 是否显示

## 范围外(本设计不做)

- 临时交战模式、追杀模式、ATTACK BUFFER 手动锁定(全部砍掉)
- 手机端 profit 模式(先做 PC,后续可仿照跟进)
- "受伤阈值 + 自动重连"(独立改动,与 profit 模式无关)
