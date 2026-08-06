## 1. 几何层（方案 C 核心纪律）

- [x] 1.1 重写 `shellAgent/shellAgentGeometry.ts`：占位行 + marker + decoration 生命周期；单测覆盖占位行数、卡片高度
- [x] 1.2 卡片高度：thinking=3 / cmd=6 / final=4（approve 不改几何）
- [x] 1.3 降级：decoration 失败 / marker 失效 → dock

## 2. 入口时序

- [x] 2.1 `beginRouteAi`：清行 → `waitForTerminalOutputIdle` → 蓝字问题行 → 占位 → 入环
- [x] 2.2 **续轮纪律**：仅首轮 inline；续轮一律 dock（不写占位、不重锚）
- [x] 2.3 approve 序列：`prepareShellAgentExecution` → 灰字已同意 + prompt 前缀 → 注入

## 3. UI 宿主

- [x] 3.1 `ShellAgentOverlay`：decoration portal + blocksStore 数据源
- [x] 3.2 dock 降级 panel
- [x] 3.3 resize：`relayoutShellAgentCard`

## 4. 环状态机

- [x] 4.1 `loop.ts` phase 驱动几何；`turnFinished` 待审批时不撤卡
- [ ] 4.2 `terminalShellRecovery` 环内不 Ctrl+C 清场（待手工回归）

## 5. 回归与联调

- [ ] 5.1 端到端两轮续环（本地 + SSH）
- [ ] 5.2 门闩：vim / Ctrl+R / IME / 真命令
- [x] 5.3 vitest：几何 + loop 续轮 dock + shellAgentStore
- [ ] 5.4 命令栏 Block 模式回归
## 6. 后续（非 MVP）

- [ ] 6.1 用户手敲命令失败后的灯泡观察入环
- [ ] 6.2 非 shell 工具（搜索等）；远端 shell 钩子增强
