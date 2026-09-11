## ADDED Requirements

### Requirement: 生成走 Dock 而非 oneshot 主路径

工作台「按描述生成」SHALL 继续经 AI Dock + `omni_studio_*` 写文件。MUST NOT 把 `requestAiCompletionOnce` 当作脚手架主路径。

#### Scenario: 点生成打开侧栏会话

- **WHEN** 用户在工作台点击按描述生成并提交需求
- **THEN** 消息进入 AI Dock 会话，Agent 可调用 studio 写文件工具

### Requirement: 脚手架审计

用户发起脚手架生成时，系统 SHALL 记 audit `plugin.ai_scaffold`：提示词 sha256 与长度，MUST NOT 落提示词原文。写文件仍走既有 ToolGate。

#### Scenario: 审计无原文

- **WHEN** 用户确认生成
- **THEN** audit 可查到 `plugin.ai_scaffold` 且条目不含提示词明文

#### Scenario: 生产环境仍确认写盘

- **WHEN** Agent 调用 `omni_studio_write_file`
- **THEN** 必须经 ToolGate 审批后才落盘
