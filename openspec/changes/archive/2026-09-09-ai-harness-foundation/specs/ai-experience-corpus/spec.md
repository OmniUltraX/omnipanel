## ADDED Requirements

### Requirement: Experience digest covers parent and parallel

系统 MUST 能为会话生成经验 digest，至少包含：plan 摘要（若有）、cluster 子会话列表与状态（若有）、可获得的工具失败/错误线索（来自 traces 或已知状态）。

#### Scenario: Digest after parallel run

- **WHEN** 父会话曾 spawn 多个子会话且至少部分已结束
- **THEN** digest MUST 列出各子会话 title/status，并标注父 conversationId

#### Scenario: Digest with plan only

- **WHEN** 会话仅有 plan 无 cluster
- **THEN** digest MUST 含 plan 标题、状态与步骤完成计数

### Requirement: Digest is read-only

生成 digest MUST NOT 修改 harness 组件或触发新的工具执行。

#### Scenario: Building digest is side-effect free

- **WHEN** 调用 buildExperienceDigest
- **THEN** plans/clusters/traces 持久状态 MUST 保持不变
