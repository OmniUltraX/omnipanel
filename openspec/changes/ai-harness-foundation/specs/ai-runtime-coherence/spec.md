## ADDED Requirements

### Requirement: Unified submit pipeline

侧栏会话与终端 inline AI MUST 经同一套 agent 解析与工具门禁约定（`resolveAgentRuntime` + ToolGate）；表面宿主可以不同，编排语义 MUST 一致。

#### Scenario: Inline plan tools remain available to module agents

- **WHEN** 终端 inline 使用 terminal agent 执行多步骤任务
- **THEN** 跨模块会话计划工具（`omni_plan_*`）MUST 仍可按既有 cross-module 规则注入与调用

### Requirement: ContextBridge contract

各模块 ContextBridge MUST 遵循统一挂载/卸载契约（active 时提供上下文，离开时清理），子会话继承/覆盖规则 MUST 有文档或测试说明。

#### Scenario: Inactive module clears context

- **WHEN** 模块桥接组件变为非 active
- **THEN** 已注册的模块上下文 MUST 被清理，避免串台

### Requirement: Loop experimental clarity

Outer Loop 在 discover 未接通时 MUST 向用户或 finding 明确「实验/未配置」语义，MUST NOT 伪装为已完成 Skill 巡检。

#### Scenario: Missing pilotId

- **WHEN** LoopSpec 缺少可用 pilotId/discover 配置
- **THEN** 运行结果 MUST 产生明确的未配置/实验类 finding 或等价提示
