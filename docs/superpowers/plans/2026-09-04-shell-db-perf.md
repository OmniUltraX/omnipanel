# Shell + DB 性能结构优化 Implementation Plan

> **For agentic workers:** 按任务顺序实现；完成后跑 `cd frontend && npx tsc -b`。

**Goal:** 收拢 keepAlive 到 Runtime、隔离 AppShell 重渲、收敛 DB Tab Session（不拆 Grid/Toolbox）。

**Architecture:** `ModuleRuntimeOutlet` 拥有保活；DB Tab 真相源进 Session/store；Panel 只编排 View。

**Tech Stack:** React 18、现有 overlayKeepAlive / ModuleHost / db workspace stores

## Global Constraints

- 中文回复；**不擅自 git commit**
- 前端改完必须 `npx tsc -b` 零 error
- 不拆 TableDataGrid / Toolbox / SchemaBrowser

---

### Task 1: S1+S2 ModuleRuntimeOutlet — [x]

- [x] 新增 `modules/runtime/ModuleRuntimeOutlet.tsx`：keepAlive + ModuleHost + shell Routes
- [x] `App.tsx` 用稳定 `<ModuleRuntimeOutlet />` / topbarActions；删除 keepAlive 样板
- [x] 导出更新；`tsc -b`

### Task 2: S3 DB Session 拥有 Tab 列表 — [x]

- [x] `dbWorkspaceDockTabsStore` + Session list/dispose
- [x] Panel 改读 store；registerDatabaseTabCloser
- [x] 单测 + `tsc -b`

### Task 3: S4 编排外移瘦身 — [x]

- [x] `dbWorkspaceTabHelpers.ts` 抽出匹配/恢复/解析辅助函数
- [x] `tsc -b`
