## ADDED Requirements

### Requirement: Harness inventory exposes runtime components

系统 MUST 能提供只读 Harness 清单，至少包含：agentId、toolsMode 摘要、skills 引用、active plan（若有）、active clusters（若有）、gate 策略摘要来源说明。

#### Scenario: Conversation with plan and cluster

- **WHEN** 会话存在执行中的 plan 与未完成的子会话集群
- **THEN** inventory MUST 同时返回二者的 id、status 与步骤/子会话计数

#### Scenario: Conversation without orchestration

- **WHEN** 会话无 plan 且无 cluster
- **THEN** inventory MUST 仍返回 agent/tools 静态面，activePlan/activeClusters 为空

### Requirement: Components map to existing assets

Harness 组件命名 MUST 映射到现有资产（prompt 文件、builtin tools、skills、ToolGate、plan、sub-conversation cluster、RAG/knowledge），MUST NOT 引入第二套并行运行时。

#### Scenario: Inventory does not spawn runtimes

- **WHEN** 调用方仅请求 inventory
- **THEN** 系统 MUST NOT 创建 plan、cluster 或发起工具调用
