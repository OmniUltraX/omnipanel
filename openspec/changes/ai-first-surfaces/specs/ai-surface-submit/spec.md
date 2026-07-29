## ADDED Requirements

### Requirement: 统一表面提交 API

系统 MUST 提供 `askAiFromSurface`（或等价命名），接受至少：`prompt`、`surface`（dashboard | module）、可选 `moduleKey`、`newConversation`、`contextChips`。实现 MUST 打开 Dock（可配置）、设置 Agent、调用既有 `sendToAiDock`/`submitAiPrompt`。

#### Scenario: Dashboard 表面

- **WHEN** `surface=dashboard` 且提供 prompt
- **THEN** 使用助手页 Run 类 Agent（`run`），默认新会话，打开 Dock 并提交

#### Scenario: Module 表面

- **WHEN** `surface=module` 且 `moduleKey=files`
- **THEN** 会话 Agent 为 `files`，打开 Dock 并提交

### Requirement: Composer 可复用

系统 SHOULD 提供可嵌入的 `AskAiComposer` 组件（输入 + 发送），首页 MUST 使用该组件；其它表面可复用。

#### Scenario: 回车发送

- **WHEN** 用户在 Composer 聚焦时按 Enter（未按 Shift）
- **THEN** 触发与点击发送相同的提交行为

### Requirement: 无新 IPC

本能力 MUST NOT 新增 Tauri 命令；会话与流式仍走既有 `ai_chat` 路径。

#### Scenario: 无 bindings 变更

- **WHEN** 完成本 change
- **THEN** 不要求 `npm run gen:bindings` 作为交付条件
