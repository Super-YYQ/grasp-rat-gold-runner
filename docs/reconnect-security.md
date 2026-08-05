# 自动重连安全模型（PC）

> 版本范围：1.9.5。本文描述 PC 版 `src/grasp-rat-gold-runner.user.js` 中自动重连的
> 安全设计、模式、终态与已知边界。手机端不包含自动重连。

## 默认与模式

自动重连**默认关闭**（`crgrAutoReconnect` 须显式开启）。开启后有两种授权模式：

| 模式 | 行为 |
| --- | --- |
| `NAVIGATE_ONLY`（默认） | 把用户带到 LinuxDO 授权页，**绝不自动点“允许”**，提示手动授权。 |
| `STRICT_AUTO_CONSENT` | 仅当授权页契约**精确匹配**时才自动点“允许”。 |

模式存于 GM 键 `crgrConsentMode`（`readConsentMode` / `setConsentMode`）。

## fail closed 规则

1. 授权逻辑只在 `https://connect.linux.do` 的精确 `/oauth2/authorize` 路径运行
   （`isOAuthAuthorizePage` + `@match .../oauth2/authorize*` + `@noframes`三层）。
2. “允许”按钮必须是精确白名单**整串**文本（`允许/授权/同意/确认/authorize/…`），命中范围限定在
   action 满足 `isExpectedOAuthUrl` 的确权表单，或精确 `btn-pill-primary`；诱饵如“继续阅读”“确认退出”不命中。
3. 登录目标链接必须解析为 `https://connect.linux.do/oauth2/authorize` 的 host/path（`isExpectedOAuthUrl`）；
   仅查询字符串含目标文本的伪装不再触发导航。
4. 找不到精确结构 → 返回「页面结构未知·需要手动授权」，**不点击任何元素**。

## 状态机与终态

流程记录 `crgrReconnectFlow` 为 v3，含 `flowId` / `ownerId` / `leaseUntil` / `deadline` / `lastError`。
进行中阶段 `leave → game-login → auth`，失败进入明确**终态**：

- `FAILED_RETRYABLE`：一次临时失败（可重试）。
- `FAILED_MANUAL`：结构未知 / 按钮超时 / 地址非法，需手动介入，不再自动动作。
- `CANCELLED`：用户手动允许 / 手动登录 / 关闭开关。
- `EXPIRED`：超过 expires。

各阶段有 deadline；到点未完成即写入 `lastError` 并停止，避免“永久卡在动作已占用”。

## 清理与重试

HUD 提供「清理重连」与「仅本次重试」：清理会清除 leave/ack/flow；仅本次重试按当前
离开记录重建 leave 阶段流程，让看护当作一轮全新流程重试一次。

## 游戏契约检查(fail closed,§4.5)

`classifyGameContract` 把必需字段（`state`/`state.entities`/`state.coinDrops`/
`state.keys`/`state.currentUserId`/`sendVelocity`）与关键可选字段
（`canvas`/`setPointerFromClient`/`screenCenter`）分级为 `READY / DEGRADED /
INCOMPATIBLE`。缺失必需字段 → 停用自动移动/攻击并提示导出诊断，但保留血量离开、
体力、非存活等安全逻辑；缺失画布/指针 → 只关自动攻击。`__crgrContract` 是纯只读
分类器（无 GM/无权限），`runner.exportDiagnostics()` 导出字段类型与重连摘要（不含
Cookie/token/localStorage）。

## 明确未做（Phase 2 迁移）

`reconnectBridge` 目前仍挂在 `unsafeWindow.__crgrReconnect`，因为 `pageMain` 运行在页面上下文，
必须在离开/重入时读写 GM 记录。完全解除「页面脚本可写 GM」需要把主逻辑迁回 userscript 沙盒
（审计文档 §4.1 / Phase 2）。本阶段已把“伪造/边界输入一律 fail closed + 默认关闭 + 显式终态
+ 契约分级”做到位，降低其影响。**尚未做**真实沙盒迁移。

## 采集与更新

授权/登录选择器契约由 `test/fixtures/*.html` 驱动（经 `scripts/test-reconnect-dom.mjs` 的 jsdom
测试）。真实页面结构改动前，先用 `npm run capture:baseline` 在用户本机 Chromium 采集未登录页，
再更新 fixture——不要只靠注释里的“真实结构”。

**已确认的真实契约（2026-08-05）**：游戏未登录页 `#joinBtn` 结构、以及游戏内登录走
`/auth/linuxdo/start` 返回的 OAuth `auth_url`：

```
https://connect.linux.do/oauth2/authorize?response_type=code
  &client_id=b5nIdDfLLwO4Ax3ZPVNYp66CTc8fu1LC
  &redirect_uri=https%3A%2F%2Fgrasp-rat-game.h-e.top%2Fauth%2Flinuxdo%2Fcallback&scope=read
```

这与 `isExpectedOAuthUrl`（只校验 `host=connect.linux.do` + `path=/oauth2/authorize`，查询参数可变）
完全一致，`oauth-consent.html` fixture 的 form action 已用该真实 URL，jsdom 测试证明其被接受。
确权页**按钮 DOM** 仍需已登录 LinuxDO 会话采集。