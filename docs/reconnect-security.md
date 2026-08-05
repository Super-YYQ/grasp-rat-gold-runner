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

## 明确未做（Phase 2 迁移）

`reconnectBridge` 目前仍挂在 `unsafeWindow.__crgrReconnect`，因为 `pageMain` 运行在页面上下文，
必须在离开/重入时读写 GM 记录。完全解除「页面脚本可写 GM」需要把主逻辑迁回 userscript 沙盒
（审计文档 §4.1 / Phase 2）。本阶段已把“伪造/边界输入一律 fail closed + 默认关闭 + 显式终态”
做到位，降低其影响。**尚未做**真实沙盒迁移与 HUD 上的“清理重连状态 / 本次手动重试”按钮。

## 采集与更新

授权/登录选择器契约由 `test/fixtures/*.html` 驱动（经 `scripts/test-reconnect-dom.mjs` 的 jsdom
测试）。真实页面结构改动前，先用 `npm run capture:baseline` 在用户本机 Chromium 采集未登录页，
再更新 fixture——不要只靠注释里的“真实结构”。