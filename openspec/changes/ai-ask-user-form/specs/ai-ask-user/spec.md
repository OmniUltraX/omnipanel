## ADDED Requirements

### Requirement: AI 可通过工具发起结构化澄清表单

系统 MUST 提供内置工具 `omni_ask_user`（`UiDelegated`），供任意模块 Agent 在信息不足时向用户发起结构化问题；MUST NOT 将该工具路由到 ToolGate / ActionDraft 审批队列。

#### Scenario: 工具挂起并展示表单

- **WHEN** 模型调用 `omni_ask_user` 且入参通过校验
- **THEN** 后端挂起该 tool call，前端在对应 assistant 消息中写入 `user-question` part，并渲染可交互表单

#### Scenario: 跨模块可见

- **WHEN** 终端 / SSH / 数据库 / Docker 等模块 Agent 发起会话
- **THEN** 工具列表中 MUST 包含 `omni_ask_user`（与 `omni_plan_*` 同属跨模块能力）

#### Scenario: 非法入参立即失败

- **WHEN** 入参缺少 questions、题型与 options 不匹配、或题目数超出 1～5
- **THEN** 系统 MUST 以失败 tool result 回传错误说明，且 MUST NOT 展示可交互表单

### Requirement: 表单支持单选、多选与填空

`omni_ask_user` MUST 支持题型 `single_choice`、`multi_choice`、`text`；选择题 MUST 提供至少两个选项；填空题 MUST 提供文本输入。

#### Scenario: 用户完成必填并提交

- **WHEN** 用户填写所有 `required` 题目并点击提交
- **THEN** 系统 MUST 将 `status=answered` 与结构化 `answers` 经 `ai_chat_tool_result` 回传，更新 part 为已答只读态，并继续会话

#### Scenario: 用户跳过

- **WHEN** 用户点击跳过
- **THEN** 系统 MUST 回传 `status=skipped`（会话继续），并将 part 标为已跳过只读态

#### Scenario: 必填未完成不可提交

- **WHEN** 任一 `required` 题目未作答
- **THEN** 提交按钮 MUST 不可用或提交被拒绝，且 MUST NOT 回传 tool result

### Requirement: 与执行确认语义隔离

澄清表单 MUST 仅用于收集用户意图；后续真正执行运维操作仍 MUST 走既有 ToolGate / 环境标签确认。

#### Scenario: 澄清本身不触发执行确认

- **WHEN** 用户提交或跳过澄清表单
- **THEN** 系统 MUST NOT 因此自动执行 SSH/终端/数据库/Docker 写操作，也 MUST NOT 因澄清本身弹出危险命令审批条

#### Scenario: 生产环境后续操作仍需确认

- **GIVEN** 用户通过澄清表单选择了 prod 相关选项
- **WHEN** AI 随后发起高风险或 prod 环境写操作
- **THEN** 系统 MUST 仍按既有环境标签与 ToolGate 策略要求确认
