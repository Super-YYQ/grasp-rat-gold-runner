# AGENTS.md

本项目是 `grasp-rat-game.h-e.top` 的篡改猴 userscript（用户脚本），用于自动吃金币和危险规避。

## 交流约定

- 默认用中文回复。
- 不要堆砌底层路径、函数名、行号，除非用户明确需要。
- 文件路径写成普通文本即可，不要做成可点击链接。
- 所有非中文术语建议写成 `English（中文解释）` 的形式。

## 项目入口

- PC 版主要编辑文件：`src/entries/desktop.user.js`
- PC 游走拾荒发布文件：`dist/grasp-rat-gold-runner.user.js`（由 esbuild 构建生成）
- PC 杀敌掠夺发布文件：`dist/grasp-rat-raider-runner.user.js`（同一桌面源码、构建期 profile）
- 手机端独立源码：`src/entries/mobile.user.js`
- 手机端发布文件：`dist/grasp-rat-gold-runner-mobile.user.js`（由 esbuild 构建生成）
- userscript 元数据（`@name`/`@version`/`@match` 等）单一来源：`scripts/userscript-meta.mjs`
- 改完源码后**必须**运行 `npm run build` 重新生成 `dist`（确定性构建，两次产物哈希一致）。
- 不要手工编辑 `dist/`，也不要继续改旧会话目录里的脚本，旧目录只作为历史备份。

## 核心运行方式

脚本是一个单文件 userscript。外层通过 `unsafeWindow.eval` 或插入 `<script>` 把 `pageMain()` 注入游戏页面上下文，因为游戏核心变量在页面闭包/页面环境里：

- `state`
- `els`
- `sendVelocity`

这些变量来自游戏页面自身，不是本项目定义的公共 API（接口）。改动时要假设它们可能变化，优先做容错。

## 逻辑优先级

不要随意打乱以下顺序：

1. `1h体力限制`、明确网络异常和运行看门狗恢复。
2. 找不到当前玩家实体时停移；持续缺失才进入限次恢复。
3. 死亡/非 Alive 与短时体力耗尽。
4. 游走拾荒版受伤立即离开；掠夺版只有正在交战时允许预算内受伤。
5. 170m 第三方近身威胁逃离，220m 富敌保距。
6. 右键手动坐标。
7. 掠夺版统一比较击杀与金币机会；选中击杀后追近、开火、止损、拾取。
8. 巡航弹道躲避。
9. 金币短路线移动。

重点：两个 PC userscript 互斥安装。旧的追杀、临时交战、独立自动攻击入口已移除，不能重新做成彼此割裂的开关。脚本不使用传送脱战；停止模式仍必须保留受击监控。

`1h体力限制` 自动离开只读取左侧官方 `.side` 面板文本，不读取聊天区，避免历史消息误触发。这个监控应独立于主循环定时生效。

PC 版右键手动坐标目标、手机端长按手动坐标目标都不能覆盖安全逻辑。掠夺版右键选点时要结束当前追击，不能一边跑手动目标一边开火。

掠夺候选必须是存活、有 Drop、未无敌、500m 内的目标。静止约 8 秒可作为挂机目标；活跃目标只有在 HP/Drop 明显占优时才允许收割。击杀与金币路线使用单位时间收益统一评分，并以约 15% 切换迟滞避免抖动。

掠夺火控沿用 5-8 发覆盖、每发约 0.5 体力、保留 2 发余量、目标持续可见/存活以及必须有 world canvas 的 fail-closed 规则。追击对象受保护，不能被普通威胁分支反向拉走；任何第三方近身威胁仍优先。自身 HP≤25、累计受伤达到 18、体力储备不足或目标优势反转时立即止损。

运行看门狗的恢复必须有限次：移动无进展先重规划，连续卡住或状态长期不新鲜再离开；离开按钮无效时最多刷新 2 次。不要引入无限刷新、无限 OAuth 点击或读取 token/localStorage 的旁路。

富敌识别只能看游戏黄色标签里的 `Drop` 值，对应页面实体字段 `death_reward_preview ?? death_drop_coins ?? 0`。不要使用 `coins` 字段做威胁判断，因为它可能是账户/总金币类字段，会导致误判。

170m 紧急逃离的“近身威胁”不是所有敌人，而是：

- 黄色 `Drop` 大于 10 的敌人。
- 黄色 `Drop` 不超过 10、但脚本在最近 10 秒内观察到坐标移动过的敌人。

250m 规划避让和 220m 保距仍然只使用黄色 `Drop` 大于 10 的富敌列表，不要把低 `Drop` 移动敌人混进去。

金币巡航使用短路线规划，不是单点最近优先。路线候选必须先经过富敌安全过滤，再在安全候选里比较单个高价值/近距离金币与金币团路线的单位时间收益。密集金币团可以规划更多连续点，稀疏区域只规划少量点或单点；路线评分要惩罚明显掉头，减少走回头路。

## UI/HUD 规则

- 手机端是独立 userscript，不要把手机端长按选点、侧边抽屉、紧凑按钮栏塞回 PC 脚本。
- 手机端删除桌面版正下方、左上角、右上角的纯展示数据框；保留顶部四按钮、右上角取消手动目标、火控/追杀顶部浮窗。
- 手机端追杀列表点击用户名只填入追杀输入框，不自动开启追杀。
- 手机端不能恢复桌面版蓝色全屏 HUD 风格层。
- HUD 必须避开游戏左侧官方 `.side` 面板。
- HUD 左边界由 `.side.getBoundingClientRect().right + 28px` 动态计算。
- 不要用固定 `50vw` 这种粗暴边界。
- 中心视野不要被大面板覆盖。
- PC 控制区保持紧凑，只显示启动、停止、重连、仅本次重试和离开；不要恢复旧的攻击/追杀按钮。
- HUD 不能使用 `backdrop-filter` 或 `-webkit-backdrop-filter` 毛玻璃；所有信息块使用普通半透明背景，减少游戏画面上的渲染开销。
- PC 端 Drop 雷达位于现有 HUD 控制区内，常态每 10 秒刷新一次；刚进入游戏、首次识别到当前玩家实体后，还要在 3 秒后额外刷新一次。它要合并 `state.entities` 和 `state.minimap.points`，其中 minimap 点的 `d` 字段是全场黄色 `Drop` 数；不要用 `coins` 字段。点击用户名只复制，不再联动追杀。
- 连线指示使用透明 canvas 覆盖层和 `requestAnimationFrame` 帧同步绘制：目标线金色，500m 内 Drop 大于 0 的敌人线蓝色，170m 内 Drop 大于 0 的敌人线红色。覆盖层不能接管鼠标事件。
- 不要把连线改回用 `innerHTML` 反复重建 SVG DOM；那会造成卡顿和视觉跳动。
- 连线器和倒三角标记必须优先复用游戏原生 `worldToScreen` / `viewParams` 做世界坐标到全屏 canvas 的换算，再减去 HUD 右侧场景区 root 的左上角。不要用全屏中心、HUD 中心或固定比例自己估算；左侧官方面板、相机中心和当前缩放都会造成系统性偏移。
- 连线/标记渲染循环不能调用 `setPointerFromClient`，否则会改变游戏指针状态，导致鼠标/准星闪到固定位置。这个函数只允许在真实右键点击取坐标或掠夺版实际开火时调用。
- 掠夺版只允许在真正开火时调用 `setPointerFromClient` 或派发鼠标事件，不允许放进渲染循环或状态刷新循环。

## PC 掠夺模式

- 状态闭环是 `scavenge → pursuit → fire → loot-wait/loot → scavenge`，任何异常结束都必须释放鼠标、方向键和攻击锁。
- 移动目标用短时速度预判追近；进入约 140m 后开火，弹道规避与 100-150m 调距仍由现有 combat 模块负责。
- 目标消失后只在最后位置附近短暂找掉落，不能永久守尸或追旧坐标。
- 没有合格击杀机会时必须退回金币路线，拾荒版不得进入任何主动火控分支。

## 安全与副作用

- 不要读取浏览器 cookie、localStorage 里的敏感信息、密码、扩展内部数据。
- 不要绕过 Chrome 对 `chrome-extension://` 页面操作的限制。
- 不要删除旧文件；如有临时文件或缓存，完成后提醒用户。
- 不要提交 `.env`、令牌、API Key。

## 验证

至少运行：

```powershell
node --check .\src\entries\desktop.user.js
node --check .\dist\grasp-rat-gold-runner.user.js
node --check .\dist\grasp-rat-raider-runner.user.js
node --check .\src\entries\mobile.user.js
node --check .\dist\grasp-rat-gold-runner-mobile.user.js
```

如改 HUD，建议在游戏页临时注入验证布局：

- 左侧官方面板不能被覆盖。
- 中心主要游戏视野不能被遮挡。
- 字号在 2K/大屏下可读。
- 170m 规避危险态仍显示暗红呼吸效果。

## 发布流程

1. 按目标平台改 `src/entries/desktop.user.js` 或 `src/entries/mobile.user.js`。
2. 更新版本：PC 改 `package.json` 的 `version`（`scripts/userscript-meta.mjs` 自动读取）；Mobile 改 `scripts/userscript-meta.mjs` 的 `mobileMeta.version`。
3. 运行 `npm run build` 重新生成 `dist`（esbuild 确定性构建）。
4. 跑 `npm run test` 与 `npm run release:check`（release check 内部会先 build，再校验版本/语法/clean tree/测试/禁用 CSS/fixture）。
5. 在 `docs/changelog.md` 写一条变更。
