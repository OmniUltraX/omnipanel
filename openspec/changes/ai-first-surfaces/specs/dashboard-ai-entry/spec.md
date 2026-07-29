## ADDED Requirements

### Requirement: 首页提供 AI 主输入

系统 MUST 在 Dashboard 看板（`HomeBoardView`）顶部提供 AI 输入区，用户提交后 MUST 经 `askAiFromSurface` / `sendToAiDock` / `submitAiPrompt` 进入既有 AI 管线，且 MUST 打开 AI Dock。

#### Scenario: 从首页发送提示

- **WHEN** 用户在首页输入非空提示并提交
- **THEN** 打开 AI Dock，创建或使用约定会话，用户消息进入会话并可触发工具 / plan（取决于模型与 Agent）

#### Scenario: 空输入不发送

- **WHEN** 输入为空或仅空白
- **THEN** 不打开新请求、不产生用户消息

### Requirement: 首页建议与提醒芯片

系统 SHOULD 在输入区附近展示最多 5 个建议芯片，数据来自已有首页/任务投影（草稿、活动任务、待办 Finding 等），点击 MUST 将对应提示填入输入区或直接提交（实现选定一种并在 UI 一致）。

#### Scenario: 无建议时隐藏

- **WHEN** 无草稿、无活动任务、无开放 Finding
- **THEN** 不展示空的建议行

#### Scenario: 点击芯片预填

- **WHEN** 用户点击某建议芯片
- **THEN** 输入区填入与该条目相关的提示文案（或等价直发），不旁路提交管线
