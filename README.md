# Grasp Rat Gold Runner

给 Grasp Rat Game 写的篡改猴 userscript（用户脚本）。

PC 端从 2.0.0 起拆成两个互斥脚本：

- **游走拾荒版**：躲避危险玩家，规划安全金币短路线，适合低风险挂机。
- **杀敌掠夺版**：在金币路线和可控击杀之间统一比较收益，追击静止/明显劣势目标，击杀后优先捡掉落。

两个脚本共享安全路线、弹道躲避、断线重连与卡住恢复，但不会再把“追杀 / 临时交战 / 自动攻击”三个开关叠在一起。

游戏入口：`https://grasp-rat-game.h-e.top/`

原始玩法请见主帖：`https://linux.do/t/topic/2290514`


## 安装

搭配 Tampermonkey（篡改猴）使用：`https://www.tampermonkey.net/`

PC 游走拾荒版位于[dist/grasp-rat-gold-runner.user.js](https://github.com/Super-YYQ/grasp-rat-gold-runner/blob/optimize/dist/grasp-rat-gold-runner.user.js)。

PC 杀敌掠夺版位于[dist/grasp-rat-raider-runner.user.js](https://github.com/Super-YYQ/grasp-rat-gold-runner/blob/optimize/dist/grasp-rat-raider-runner.user.js)。

手机端脚本位于[dist/grasp-rat-gold-runner-mobile.user.js](https://github.com/Super-YYQ/grasp-rat-gold-runner/blob/optimize/dist/grasp-rat-gold-runner-mobile.user.js)。

> 两个 PC 脚本只能启用一个；同时启用会争抢同一组移动与鼠标控制。当前稳定版本发布在 `optimize` 分支（PC `2.0.0` / Mobile `0.1.7`）。

------

## 核心功能玩法（一定要看哦）

### 1. 游走拾荒版

脚本会持续扫描金币，并自动规划一小段效率最高的顺路路线。

规划时会同时考虑：

- 金币金额和距离。
- 附近有没有金币团。
- 连续吃多个金币是不是会少走回头路。
- 路线附近有没有高 Drop 敌人。
- 当前目标是否还值得继续追。

### 2. 杀敌掠夺版

掠夺版不是见人就打，而是把地面金币路线和击杀机会放进同一个“单位时间收益”评分池：

- 静止至少约 8 秒且有 Drop 的玩家可作为挂机目标。
- 活跃玩家只有在自身血量、目标血量和 Drop 明显占优时才会进入收割候选。
- 当前机会若没有被新机会高出约 15%，不会频繁换目标。
- 追到 140m 左右进入火控距离；目标移动时短时预判，开火时继续躲弹/调距。
- 自身 HP 低于安全线、累计受伤过多、体力储备不足或目标优势反转时立即止损离开。
- 目标消失后在最后位置等待掉落，并优先回收附近金币。

没有合格目标时，掠夺版会退回与拾荒版相同的安全金币路线。

### 3. 危险规避

游戏里黄色 `Drop` 数代表敌人死亡后可能掉落的金币。本脚本以此来分辨僵尸玩家（因为不活跃而被迫加入战场的佬友）和活跃玩家（可能有攻击性），并据此规避潜在危险玩家。

- 以 170m 作为危险缓冲区（略大于子弹射程范围）。
- Drop 大于 10 的~资产阶级~敌人会被当作高风险目标。
- Drop 不高但最近 10 秒曾移动过的敌人，进入 170m 也会触发紧急远离。

常态巡航下，如果被左右夹击实在躲不开挨打了，脚本会自动退出游戏当怯战蜥蜴。

另外，当触发游戏的 `1h体力限制` 时，也会自动离开。

### 4. 一键前往（右键选点）

- 你可以在游戏画布上右键单击，设置一个临时前往坐标（类似LOL）。右键目标优先于金币巡航，但低于受伤离开、死亡停止、体力检查和必要的安全规避。
- 手机端改为长按选点，并在右上角提供“取消目标”按钮。

## 连线指示器

- 灵感来自于吃鸡外挂，可以帮助玩家识别潜在危险玩家

- 金色线指示当前脚本的行进目标；
- 蓝色线标记视野范围内有潜在威胁的敌人（僵尸玩家不会被标记）；
- 红色线标记 170m 内（略大于射程范围）危险敌人。

------

## 项目结构

```text
grasp-rat-gold-runner/
  src/
    entries/
      desktop.user.js               # PC 版源码（IIFE 体，无 metadata 头）
      mobile.user.js                # 手机端独立源码（IIFE 体，无 metadata 头）
  dist/
    grasp-rat-gold-runner.user.js          # PC 版发布脚本（esbuild 构建）
    grasp-rat-raider-runner.user.js        # PC 掠夺版发布脚本（同源、构建时选择 profile）
    grasp-rat-gold-runner-mobile.user.js   # 手机端发布脚本（esbuild 构建）
  docs/
    behavior.md                     # 详细行为规则和优先级
    mobile.md                       # 手机端取舍和交互说明
    install.md                      # 安装说明
    development.md                  # 开发与发布流程
    changelog.md                    # 版本记录
  scripts/
    build.mjs                       # 确定性 esbuild 构建（src/entries → dist）
    userscript-meta.mjs             # userscript 元数据单一来源（@name/@version/@match 等）
    release-check.mjs               # 跨平台发布门禁（先 build 再校验）
    release-check.ps1               # Windows 包装
  AGENTS.md                         # 给后续 agent 的项目手册
```

## 开发

PC 功能改 `src/entries/desktop.user.js`；手机端功能改 `src/entries/mobile.user.js`。发布前用 esbuild 重新生成 `dist`：

```powershell
npm run build
```

语法检查：

```powershell
node --check .\src\entries\desktop.user.js
node --check .\dist\grasp-rat-gold-runner.user.js
node --check .\dist\grasp-rat-raider-runner.user.js
node --check .\src\entries\mobile.user.js
node --check .\dist\grasp-rat-gold-runner-mobile.user.js
```

完整发布检查：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\release-check.ps1
```

## 给下一位维护者

这个项目最容易踩坑的地方不是语法，而是各个自动化层的优先级：

- PC 与手机端是两个独立 userscript，不要为了适配手机去改桌面 HUD。
- 生命安全高于移动目标。
- 两个 PC 构建互斥安装，拾荒版永不主动攻击。
- 掠夺版只攻击策略筛选出的目标，第三方近身威胁仍高于追击。
- 击杀与金币必须统一评分，并保留切换迟滞，避免来回换目标。
- 卡住先重规划，重复卡住或网络状态长期不刷新再离开/重连。
- 连线和倒三角必须使用游戏原生坐标换算，不能按屏幕中心硬猜。
- Drop 判断只能看黄色 Drop 对应字段，不能用账户金币字段。

详细规则请先读 `AGENTS.md` 和 `docs/behavior.md`，再动源码。

---

## 🔗 LinuxDo 社区

<div align="center">
  <a href="https://linux.do" target="_blank">
    <img src="https://cdn3.ldstatic.com/original/4X/c/c/d/ccd8c210609d498cbeb3d5201d4c259348447562.png" alt="LinuxDo" height="60">
  </a>
  <p>
    <a href="https://linux.do" target="_blank"><strong>LinuxDo 社区</strong></a><br>
  </p>
    <p>@蕉灼の仓鼠</p>
    <p>本人长期活跃于L站;</p>
    <p>这里的人很好说话又好听;</p>
    <p>欢迎都来加入L站大家庭。 </p>

</div>
