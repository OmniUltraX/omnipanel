## 1. 共享 surfaces API 与 Composer

- [x] 1.1 新增 `frontend/src/lib/ai/surfaces/askAiFromSurface.ts`（绑 Agent、开 Dock、调 sendToAiDock）
- [x] 1.2 新增 `buildDashboardSuggestionChips` 纯函数 + 单测
- [x] 1.3 新增 `components/ai/AskAiComposer.tsx`（输入、发送、Enter）
- [x] 1.4 新增 `components/ai/ModuleAskAiButton.tsx`
- [x] 1.5 i18n：`ai.surfaces.*`（zh-CN / en-US）

## 2. 首页 Dashboard

- [x] 2.1 `HomeBoardView` 顶部嵌入 AskAiComposer + 建议芯片
- [x] 2.2 接 `useDashboardData` / loop findings 生成芯片
- [x] 2.3 首页样式（克制、贴合现有 home-board）

## 3. 模块「问 AI」

- [x] 3.1 `ModuleWorkspaceLayout` / `ModuleLeftColumn` 增加 `leftHeaderActions`
- [x] 3.2 database / docker / files / server 传入 ModuleAskAiButton
- [x] 3.3 确认各模块 ContextBridge 在路由激活时仍挂载（既有 bridge 未改挂载条件）

## 4. 收尾

- [x] 4.1 单测：chips + askAiFromSurface 选项归一（mock sendToAiDock）
- [ ] 4.2 手动走查：首页发送、芯片预填、四模块问 AI、ToolGate 不跳过
- [x] 4.3 更新 harness README 标明表面层已开做
