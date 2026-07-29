## ADDED Requirements

### Requirement: Single orchestration narrative

用户可感知的编排 MUST 遵循「计划 →（可并行）执行 → 确认闸 → 汇总」；Plan、子会话集群与 ToolGate MUST 共享同一编排状态面（`aiOrchestrationStore` + drafts），而非互不认识的产品线。

#### Scenario: Parallel work stays under parent

- **WHEN** 父会话通过 `omni_spawn_sub_conversations`（或同构舰队派发）创建集群
- **THEN** 子会话进度 MUST 可在父会话编排状态与任务中心投影中关联到该父会话

### Requirement: Write entry whitelist

创建/更新 plan 与 cluster 的生产路径 MUST 仅经白名单入口（internalToolBridge 分派的 plan/sub-conv runners 与 clusterCancellation、以及 ToolGate 确认路径）。

#### Scenario: Documented write entries

- **WHEN** 开发者查阅 harness 写入口清单
- **THEN** 清单 MUST 列出允许的模块路径，并声明测试以外禁止旁路 `createPlan`/`createCluster`

### Requirement: Parallel does not bypass gate

子会话执行危险工具时 MUST 仍受 ToolGate / 环境标签策略约束，MUST NOT 因并行而自动放行。

#### Scenario: Child inherits safety posture

- **WHEN** 子会话调用需确认的工具
- **THEN** 系统 MUST 走既有审批/确认路径（与父会话策略一致或显式继承规则）
