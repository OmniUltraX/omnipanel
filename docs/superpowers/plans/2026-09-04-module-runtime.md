# Module Runtime Implementation Plan

> **For agentic workers:** 按任务顺序实现；步骤用 checkbox 跟踪。REQUIRED：完成后跑 `cd frontend && npx tsc -b`。

**Goal:** Module Runtime P0–P4：注册表 + Host + Session/View；轻量模块判活与 `contentSuspended` 对齐。

**Architecture:** Descriptor 注册；ModuleHost 渲染；SessionService 与 View 解耦；判活只走 ModuleVisibility。

**Tech Stack:** React 18、TypeScript、现有 Overlay / keepAlive / Dock

## Global Constraints

- 中文回复；**不擅自 git commit**。
- 前端改完必须 `npx tsc -b` 零 error。

---

### Task 1–3: P0 Runtime 骨架 — [x]

### Task 4: P1 终端 Session — [x]

### Task 5: P2 SSH → DB → Docker + P3 插件判活 — [x]

- [x] `createTabSessionService` 通用门面
- [x] ssh / docker / database SessionService 注册 + `ensureSessionService`
- [x] SSH：`moduleLive` + `bindView`；`contentSuspended={!moduleLive}`
- [x] Docker：去掉 `useLocation` 判活/深链；改 `historyLocationState`；`bindView`
- [x] Database：`bindView`（Tab 仍 Panel 本地 state）
- [x] PluginModuleHost：`useModuleVisibility` 判活，去掉 `useLocation`
- [x] 单测 + `tsc -b`

### Task 6: P4 轻量模块 — [x]

- [x] FilesPanel：深链改 `peekHistoryStateRecord`；`contentSuspended={!moduleLive}`；去掉 `useLocation`
- [x] PluginsPanel：Escape 判活改 `useModuleVisibility`；去掉 `useLocation`
- [x] protocol / workflow / knowledge / tasks：`contentSuspended={!moduleLive}`
- [x] Terminal：`contentSuspended` 对齐 `moduleLive`
- [x] 确认 `modules/` 无业务 `useLocation` 判活
- [x] `tsc -b`

说明：plugins 列表页仍走 shell `Routes`（`isShellRoutePath`），只注册 View 语义由现有 `SuspendedModulePanel` 承担，不进 Overlay LRU；叠层侧栏入口已在 `builtinModules` registry。

---

## 验收

- [x] P0–P4 核心项
- [x] `npx tsc -b` 零 error
