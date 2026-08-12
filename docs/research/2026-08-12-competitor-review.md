# Grasp Rat 同类脚本调研（2026-08-12）

## 范围与证据等级

本次只把仓库 README 与源码当作可引用事实。游戏地址和 Linux.do 原始主帖在当前执行环境及现有 Chrome 会话中均连接超时；用户已说明需要代理节点，因此本文不对页面当前 UI、实际协议和论坛讨论内容作推测。

- 游戏：<https://grasp-rat-game.h-e.top/>（当前环境超时）
- 原始主帖：<https://linux.do/t/topic/2290514>（当前环境未成功读取）
- 当前仓库：<https://github.com/Super-YYQ/grasp-rat-gold-runner>

## 可确认的同类项目

### ZeroJehovah/grasp-rat-bot

来源：<https://github.com/ZeroJehovah/grasp-rat-bot>

这是本次发现的功能最完整竞品。README 与源码展示了以下值得借鉴的点：

- AFK Drop 与地面金币进入同一个机会评分池，并使用切换门槛减少频繁改目标。
- 追击/开火后有掉落拾取阶段，而不是把追杀、火控、拾取留成三个独立开关。
- 有页面 bot watchdog（看门狗）、WebSocket 在线状态、帧延迟/丢失和 transport health（传输健康）监测。
- bootstrap 会检查远程 manifest/hash 并热更新 bot；页面运行体缺失、停止或过旧时会重装。
- 使用游戏页面已有 WebSocket，不额外创建并行连接；连接长期离线时会离开或刷新。

相关源码：

- 机会切换：<https://github.com/ZeroJehovah/grasp-rat-bot/blob/main/src/strategy/opportunity-choice.js>
- 候选生成：<https://github.com/ZeroJehovah/grasp-rat-bot/blob/main/src/strategy/opportunity-candidates.js>
- 机会常量：<https://github.com/ZeroJehovah/grasp-rat-bot/blob/main/src/strategy/opportunity-constants.js>
- 传输健康：<https://github.com/ZeroJehovah/grasp-rat-bot/blob/main/src/node/browserless/transport-health.js>

取舍：统一评分、切换迟滞、击杀后拾取、连接健康是应吸收的产品能力；远程热加载不适合当前仓库的“单文件、自包含、可审计”发布边界，因此不采用。

### mj8724/grasp-rat-bot

来源：<https://github.com/mj8724/grasp-rat-bot>

README 描述了 collect/flee/rest 等模式、距离阈值、被追逐后离开及递增冷却，并使用金币簇评分。它还采用直连 WebSocket 与浏览器存储凭据的做法。

取舍：模式边界、追逐冷却和金币簇评分可作为行为参考；当前仓库不读取 token/localStorage，不新建自有 WebSocket，继续只使用页面已有状态与控制接口，以降低凭据暴露和协议漂移风险。

### WHYBBE/GraspRat

来源：<https://github.com/WHYBBE/GraspRat>

本次检索确认该同类仓库存在，但没有取得足够稳定、可交叉核对的源码事实，因此不以它作为阈值或实现决策依据。

## 2.0.0 吸收与差异化

| 维度 | 吸收的竞品优点 | 当前仓库的差异化 |
| --- | --- | --- |
| 机会选择 | 金币/击杀统一单位时间收益；15% 切换迟滞 | 继续使用多点短路线、路线全线段威胁距离和 `SpatialGrid`，不只比较单点 |
| 目标策略 | 静止时长、Drop、HP、体力预算 | 只攻击静止目标或明显优势活跃目标；第三方威胁优先，累计损伤 18/HP≤25/体力储备触发止损 |
| 击杀闭环 | 追近、火控、目标消失后捡掉落 | 复用已有速度预判、弹道躲避、100–150m 调距；尸点约 28m 内优先接管掉落 |
| 卡住/断线 | watchdog、离线后离开/刷新 | 首次卡住只重规划；重复卡住或状态不新鲜才离开；自动刷新最多 2 次并服从重连开关 |
| 发布安全 | 使用页面已有连接 | 不远程热加载、不读取 token、不创建自有 WebSocket；产物确定性构建、离线可审计 |
| 产品形态 | 将模式做成明确边界 | 两个互斥 PC userscript，移除追杀/交战/攻击三套相互抢状态的按钮；移动版不携带桌面新增模块 |

## “超过同类”的可验证目标

目前可以声称的是设计与测试层面的优势，不是未经对局数据支持的胜率保证：

1. **拾荒路径安全**：多点路线、整条路径（非仅端点）威胁距离、密集金币团评分、到达轻推与临时黑名单组合，在复杂地图/卡点场景比只选最近金币或单点簇评分更完整。
2. **恢复有上限**：卡住先自愈再离开，刷新次数硬封顶并尊重用户重连开关，目标是比无限 watchdog/reload 更稳、更可控。
3. **凭据与供应链边界**：不从浏览器存储取 token、不运行远程更新代码；安装时拿到的单文件就是运行代码。
4. **决策稳定性**：金币与击杀统一评分并有迟滞，避免旧版本中追杀、开火、金币三个状态各自决策造成的反复横跳。

要把这些从“设计优势”升级为“实战优势”，仍需代理可用后记录至少两种构建各一局的：每分钟收益、无效换目标次数、卡住恢复时间、受伤离开次数、击杀后掉落接管成功率，并与同场竞品做同条件对比。
