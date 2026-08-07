## Context

直通 Shell Agent（方案 C）已用 xterm decoration + portal 承载思考 / 命令审批 / 结果卡。`omni_ask_user` 与 `omni_plan_*` 由前端 dispatcher 写 `blocksStore` parts / orchestration store，侧栏与 Warp Block Feed 有 UI，但 `interactive` 直通 overlay 未接入。

约束：不新增 Rust IPC；逻辑全在 frontend module + 既有 orchestration；复用 design tokens 与 `components/ui`；思考卡禁止 sticky 的纪律保持不变，Plan live 用 **pane 级吸底条**（非 buffer decoration sticky）。

联动：Terminal ↔ AI（inline conversation `term-inline:*`）↔ SSH 真执行（`omni_ssh_exec` 审批卡可与 Plan strip 并存）。

## Goals / Non-Goals

**Goals:**

- Ask：流内可交互卡 + 提交后冻结摘要 + 挂起 turn finish
- Plan：吸底 live strip 原地刷新 + 创建/终态可选冻结卡 + 点击展开 `PlanView`
- 前后端边界清晰：无新 crate / commands；仅前端

**Non-Goals:**

- 任务中心 todolist 工具
- 每步 `update_step` 盖新 decoration 卡
- 改造侧栏 Ask / Block Feed Plan 徽章

## Decisions

### 1. Ask = 流内 decoration 卡（扩 `cardKind: "ask"`）

- **选择**：与命令审批同槽几何（marker + decoration），阶段 `awaiting_user_input`
- **替代**：侧栏弹出 → 直通用户看不到；吸底表单 → 长表单挤状态栏且与「挡流程」心智不符
- **实现**：`askUserToolDispatcher` 成功后 `notifyShellAgentAskPending` → `reanchorShellAgentCard(..., "ask")`；UI 复用/抽离 `UserQuestionForm` 字段；提交走既有 `submitAskUserAnswers`

### 2. Plan live = pane 吸底 strip（不进 xterm buffer）

- **选择**：挂在 `.term-pane` / `.term-terminal-shell` 底部，`position: absolute`，订 `aiOrchestrationStore.plans[planId]`
- **替代**：decoration 原地刷新 → 长输出卷走；每步 reanchor 新卡 → 刷屏
- **实现**：`ShellAgentPlanStrip`（或 `PassthroughPlanStrip`）由 `TerminalPaneView` 在 `interactive` 时渲染；文案复用 `resolvePlanCompactBadge`

### 3. Plan 冻结卡仅创建 / 终态

- **选择**：`omni_plan_create` 与 plan 进入 completed/failed/cancelled 时各归档一帧矮卡（可选，MVP 可先做终态）
- **替代**：每步归档 → 否决

### 4. 前后端边界

| 层 | 职责 |
|----|------|
| crates / commands | **无变更** |
| frontend `lib/ai/orchestration/*` | 已有 dispatcher；最多加「通知 Shell Agent」钩子 |
| frontend `modules/terminal/shellAgent/*` | 阶段、几何 `ask`、overlay Ask UI、冻结 HTML |
| frontend `modules/terminal/*` | Plan strip 组件、挂到 PaneView |
| IPC / specta | **无新命令** |

### 5. UI / tokens

- Ask 卡样式对齐现有 `.term-shell-agent-card--cmd`
- Plan strip：矮条、`--surface` / `--accent`，进度数字 + 当前步骤；详情 portal 复用 float 锚点或 `PlanView`（同 `TerminalAiPlanHoverBadge`）
- 按钮复用 `components/ui/primitives/Button`

## 数据流

```
  AI stream
      │
      ├─ omni_ask_user ──► askUserToolDispatcher ──► user-question part
      │                         │
      │                         └─► notifyAskPending ──► cardKind=ask (decoration)
      │                                 │
      │                                 └─ user submit ──► reportToolResult ──► 续跑
      │                                 └─ archive ask summary card
      │
      └─ omni_plan_* ──► planToolDispatcher ──► plans store + plan part
                            │
                            └─► PlanStrip 订阅刷新（吸底）
                            └─► create/terminal：可选冻结卡
```

```
┌─ term-pane ──────────────────────────────┐
│ xterm + ShellAgentOverlay (ask/cmd/…)    │
│ … PTY 输出可滚动 …                         │
├─ PlanStrip (absolute bottom) ────────────┤
│ 3/7 · 当前：配置 nginx          [详情]    │
└──────────────────────────────────────────┘
```

## Risks / Trade-offs

- [Ask 与 cmd 卡争槽] → Mitigation：同时只有一个「挡流程」卡；pending tool 与 ask 互斥排队（后到 supersede / 或 ask 优先完成）
- [Strip 挡最后一行输出] → Mitigation：条高固定 ~32–40px；可选为 xterm 底部留 padding，或半透明
- [会话恢复后 strip 丢失] → Mitigation：从 block 的 latest plan + orchestration store 重绑；与方案 C「不重建流内卡」一致时，仅恢复 strip 状态即可
- [双 Plan] → Mitigation：strip 绑定当前 inline block 的 active planId（最近一条 running）

## Migration Plan

- 纯前端；无数据迁移
- 回滚：隐藏 Ask cardKind 与 PlanStrip 挂载即可

## Open Questions

- MVP 是否必须做「创建时冻结卡」，还是仅终态 + live strip？（默认：**先 live strip + 终态**，创建冻结可第二迭代）
- Ask 与 `omni_ssh_exec` 审批同时到达时的严格优先级（默认：先完成当前可见挡流程卡）
