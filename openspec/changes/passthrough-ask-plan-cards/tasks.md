## 1. Shell Agent 状态与几何扩展

- [x] 1.1 扩展 `ShellAgentCardKind` / phase：增加 `ask` 与 `awaiting_user_input`（`frontend/src/modules/terminal/shellAgent/shellAgentStore.ts`、`shellAgentGeometry.ts`）
- [x] 1.2 在 `loop.ts` 增加 `notifyShellAgentAskPending` / 提交后恢复路径；turn finish 在 pending ask 时 defer（对齐审批挂起）
- [x] 1.3 验证：相关 vitest（`shellAgent/loop.test.ts`、geometry tests）通过

## 2. Ask 流内卡 UI

- [x] 2.1 Overlay 渲染 `cardKind === "ask"`：接入 `UserQuestionForm` 或抽离字段组件（`ShellAgentOverlay.tsx`）；样式对齐 `.term-shell-agent-card`
- [x] 2.2 `askUserToolDispatcher`（或 AiRuntime 派发后）通知当前 session 的 Shell Agent；文案走 i18n（`zh-CN` / `en-US`）
- [ ] 2.3 提交/跳过后冻结摘要（`thinkingCache.ts` 同类）；验证：手动直通触发 ask → 提交 → 续跑

## 3. Plan 吸底 live strip

- [x] 3.1 新增 `PassthroughPlanStrip`（`frontend/src/modules/terminal/`）：订 `aiOrchestrationStore` + `resolvePlanCompactBadge`；点击展开 `PlanView` portal
- [x] 3.2 在 `TerminalPaneView` 直通模式挂载 strip（pane 底部 absolute）；CSS 入 `terminal.css`，用 tokens
- [x] 3.3 plan 终态更新 strip；可选终态冻结卡（MVP：至少 strip 终态）
- [x] 3.4 验证：手动 create/update_step 后长输出，条仍可见且进度刷新；`npx tsc -b` 通过

## 4. 联调与回归

- [ ] 4.1 回归：思考卡 → `omni_ssh_exec` 审批 → 结果卡路径不受影响
- [ ] 4.2 Ask 与审批同时到达时的互斥/排队行为符合 design（先完成当前挡流程卡）
- [x] 4.3 前端 `npx tsc -b`；相关 vitest 全绿
