## 1. P0 类型与投影骨架

- [x] 1.1 新增统一类型 `TaskItem` / facet / 筛选类型（`frontend/src/modules/tasks/types.ts` 或 `projection/types.ts`）
- [x] 1.2 实现投影聚合：订阅 `backgroundTaskStore`、`loopStore.runs/findings`、`aiOrchestrationStore`，去重规则文档化（`frontend/src/modules/tasks/projection/`）
- [x] 1.3 审批仅作只读关联状态（读 `actionDraftStore`），不写入 inbox facet；验证：有 Draft 时待办列表为空或不变

## 2. P0 任务中心信息架构

- [x] 2.1 将一级 Tab 改为「运行中 / 待办 / 历史」（改 `TaskCenterPanel.tsx`、`taskCenterSelection.ts`、`TaskCenterSidebar.tsx`）
- [x] 2.2 运行中：被动 + 主动列表与详情；支持筛选；`panelContentKeysByTab` 保持选中同步
- [x] 2.3 待办：仅 Finding；处置动作复用 triage（done/dismiss/block）
- [x] 2.4 历史：先做多源时间倒序列表（终态 job + 既有 audit/session 入口）；i18n 更新 `zh-CN.ts` / `en-US.ts`
- [x] 2.5 手动验收：打开 `/tasks` 三类入口语义清晰；Draft 不出现在待办

## 3. P0 入口收敛

- [x] 3.1 `AiTaskAndDraftPanel`「打开面板」改为导航 `/tasks`（`frontend/src/components/ai/AiTaskAndDraftPanel.tsx`）
- [x] 3.2 `BackgroundTasksWindow` 增加「在任务中心查看」并弱化全量叙事（`frontend/src/components/shell/BackgroundTasksWindow.tsx`）
- [x] 3.3 手动验收：侧栏按钮进入任务中心，不再误开仅状态栏浮窗

## 4. P1 Finding 合并

- [x] 4.1 在 `loopSpec` / `loopStore` 增加 `fingerprint`、`occurrenceCount`；`addFindings` 合并逻辑（`frontend/src/stores/loopStore.ts`、`lib/ai/loopSpec.ts`）
- [x] 4.2 已关闭 Finding 再出现时复活为 open；补充单元测试（vitest，若项目已有 loop 测例则扩展）
- [x] 4.3 待办 UI 展示出现次数；验证：连续两次相同巡检建议仍为一条

## 5. P1 被动任务终态历史

- [x] 5.1 后端 WorkerPool 终态写入持久化（SQLite 表或扩展 store）（`crates/omnipanel-store/`、`src-tauri/src/background/`）
- [x] 5.2 新增 specta 命令如 `bg_task_history_list`（`Result<_, OmniError>`），注册双清单；bindings 已补 `bgTaskHistoryList` / `taskEventsList`（全量 `npm run gen:bindings` 受既有 BigInt/`serde_json::Value` 导出问题阻塞，已用手工增量 + resource_profile→Any 修复推进）
- [x] 5.3 前端停止「终态 8s 删除即不可查」；历史投影读取新 API（`bgTaskHistoryStore` + 任务中心历史）
- [x] 5.4 验证：投影单测覆盖 history 合并；手动可跑导出后在历史检索

## 6. P1 工作流运行接入

- [x] 6.1 修复工作流 UI「运行」调用 `commands.workflowRun`（`frontend/src/modules/workflow/WorkflowPanel.tsx`），移除假 `enqueueAction` 路径
- [x] 6.2 监听 workflow 执行事件并投影为 `passive_job`（module=`workflow`）
- [x] 6.3 手动验收：运行工作流 → 任务中心运行中可见 → 结束后进历史；定义编辑仍在 `/workflow`

## 7. P2 历史时间轴增强

- [x] 7.1 （可选）新增 `task_events` 索引表与 list 命令，带 module/workspaceId/resourceId（crate + commands + bindings）
- [x] 7.2 历史 UI：按功能/工作区/资源筛选或分组；AI Session 可展开加载 Trace（`LoopTriagePanels` 时间线能力迁入历史）
- [x] 7.3 prod/风险标签在历史条目上可见；手动验收筛选与 Session 展开

## 8. 收尾与回归

- [x] 8.1 清理旧五 Tab 死代码与过时 i18n key；确认无跨 module 非法 import
- [x] 8.2 回归：ToolGate 审批超时仍自动拒绝且不进待办；取消 WorkerPool 任务仍走后端 cancel
- [x] 8.3 对照 `openspec/changes/global-task-center/specs/**` 做一次清单式走查并勾选完成项

### 8.3 Specs 走查摘要

| Spec 要求 | 状态 |
|-----------|------|
| 三栏 IA（活动/待办/历史）；审批不进待办 | 满足（产品文案为「活动」，语义等同原「运行中」） |
| 运行中含被动+主动；待办仅 Finding | 满足 |
| 定义与运行分离（Workflow/Loop Spec） | 满足；活动区可进巡检计划 Spec |
| 入口收敛到 `/tasks` | 满足 |
| 统一投影 + 去重；Draft≠inbox | 满足 |
| 被动终态可检索（SQLite + 前端水合） | 满足 |
| Finding fingerprint 合并/复活 | 满足 |
| 审批超时收口不进待办；cancel→后端 | 满足 |
| 历史多源时间轴 + module 筛选 + Session Trace + prod 标签 | 满足 |
| `task_events` 索引 | 满足（bg 终态同步写入；list API 就绪） |
