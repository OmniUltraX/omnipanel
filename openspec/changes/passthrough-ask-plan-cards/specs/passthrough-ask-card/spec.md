## ADDED Requirements

### Requirement: 直通模式展示可交互询问卡

在终端直通（Shell Agent interactive）模式下，当会话调用 `omni_ask_user` 时，系统 MUST 在流内展示可交互询问卡片，且 MUST 在用户提交或跳过前挂起该工具结果回传。

#### Scenario: 收到询问工具后显示卡片

- **WHEN** 直通会话的 inline AI 调用 `omni_ask_user` 且 dispatcher 写入 pending `user-question` part
- **THEN** Shell Agent overlay MUST 在光标附近展示询问卡，包含问题与选项/文本输入，并阻止 turn 在未应答时正常归还为「可忽略表单」的空闲态

#### Scenario: 提交答案后续跑

- **WHEN** 用户在询问卡上填写必填项并提交
- **THEN** 系统 MUST 通过既有 ask-user 回传路径将答案发给模型，询问卡 MUST 变为已答摘要（可回看），且会话 MUST 继续

#### Scenario: 跳过询问

- **WHEN** 用户点击跳过
- **THEN** 系统 MUST 按既有 skip 语义回传，并更新卡片为已跳过状态

#### Scenario: 答案保留可回看

- **WHEN** 用户已提交选项或文字答案
- **THEN** 流内或冻结摘要 MUST 保留用户选择的选项标签与文字内容，供后续回看
