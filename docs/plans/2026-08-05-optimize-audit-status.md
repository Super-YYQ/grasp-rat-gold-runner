# Optimize 分支审计开发进度（2026-08-05 更新）

> 依据：`C:\Users\闫亚奇\Desktop\grasp-rat-optimize-audit-development-plan.md`
> 分支：`optimize`（本地 16 个 commit，未推送）
> 验证：`npm run release:check` 全绿（6 组测试：coin-nav / reconnect-safety / reconnect-dom / contract / spatial / property）

## 已完成并验证

| 计划项 | 状态 | 说明 |
| --- | --- | --- |
| §8 基线采集（游戏页） | ✅ | 真实页面确认 `#joinBtn` 契约 + 诱饵按钮；`capture-game-baseline.mjs` 支持 `CRGR_HEADLESS` |
| §8 OAuth URL 契约 | ✅ | 经游戏页 `/auth/linuxdo/start` 确认真实 `auth_url`；`isExpectedOAuthUrl` 校验成立 |
| §4.1 重连安全（Phase 1） | ✅ | 默认关 / `NAVIGATE_ONLY` / fail-closed / v3 终态 / 严格 URL / `@noframes` / `@match` 收窄 |
| §4.4 超时清理 / HUD 清理重试 | ✅ | `clearReconnectState` / `retryReconnectOnce` / HUD 按钮 / FAILED_MANUAL 等终态 |
| §4.5 契约检查 | ✅ | `classifyGameContract` → READY/DEGRADED/INCOMPATIBLE，fail closed |
| §5.1 SpatialGrid 模块 | ✅(模块) | `scripts/spatial-grid.mjs` + P95<8ms 预算；接线待 Phase 2 |
| §5.2 整条线段路径安全 | ✅ | `pointToSegmentDistance` / `minSegmentThreatDistance` |
| §5.3 Math.min(...map) 循环化 | ✅ | `minDistanceToEntities` |
| §5.6 金额缺失不追无效目标 | ✅ | `readDropAmount` + 候选过滤 |
| §5.7 到达确认/轻推/黑名单 | ✅ | 避免永久停住 |
| §5.9 规避按事件计数 | ✅ | 不再按 tick 累加 |
| §5.10 不删除用户真实按键 | ✅ | `setVelocity` 只清 scriptMoveKeys |
| §6.1–§6.4 自动攻击安全化 | ✅ | 整组体能预算 / fresh-target / 无画布 fail-closed / plannedShots |
| §11.2 属性测试 | ✅ | `test-nav-property.mjs`（并修复 travelTicks / pointToSegmentDistance NaN） |
| §11.5 / §13.2 发布门禁 + CI | ✅ | 跨平台 `release-check.mjs` + GitHub Actions（Win+Ubuntu+Node LTS） |
| §13.1 版本一致 | ✅ | `check-userscript-version.mjs`；PC 1.9.12 / package 1.9.12 / mobile 0.1.6 |
| §13.3 README owner | ✅ | `jzcangshu` → `Super-YYQ` |
| §13.4 收益模式标记 | ✅ | 标记为 proposal（未交付） |
| Phase 5 文档 | ✅ | behavior / AGENTS / development / reconnect-security / changelog |

## 剩余卡点（外部 / 计划顺序）

| 计划项 | 卡点 | 需要什么 |
| --- | --- | --- |
| §8 OAuth 确权页按钮 DOM | `connect.linux.do` 本机 http/https 均不可达 + 无 LinuxDO 会话 | 已登录测试会话，或确权页脱敏 HTML |
| §4.1 沙盒迁移（解除 unsafeWindow 桥） | 计划 §1 要求先完成基线采集再动；盲改 4000 行 + 无真机验证风险高 | 模块化（Phase 2）+ 真机验证 |
| §5.8 路线从当前位置重评 | 需与路线构建器单一公式来源一致，单文件双份维护会漂移 | Phase 2 模块化后接线 |
| §5.1 SpatialGrid 接线 | 需穿透评分管线（coinCandidates/scoreDrop/routeLegSafetyFactor） | Phase 2 模块化后接线 |

## 下一步

- 提供 OAuth 脱敏产物 → 解锁 Phase 2（模块化构建 → §5.8 / SpatialGrid 接线 → §4.1 迁移）。
- 或授权盲做 Phase 2（接受可能回归）。
- 或确认推送当前 16 个 commit。