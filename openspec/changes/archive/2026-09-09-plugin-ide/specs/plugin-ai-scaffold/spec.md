## ADDED Requirements

### Requirement: AI 生成插件骨架

studio SHALL 提供「描述需求→生成骨架」：经宿主 AI Dock + `omni_studio_*` 工具写入 `plugin.json` / 逻辑 / UI；生成后 Agent SHALL 再跑校验。oneshot `requestAiCompletionOnce` MUST NOT 作为脚手架主路径。audit SHALL 记 `plugin.ai_scaffold`（提示词 sha256+len，不落原文）。

#### Scenario: 一句话出骨架

- **WHEN** 用户输入「做个选中翻译插件」并确认
- **THEN** 消息进入 AI Dock，Agent 可用 studio 写文件工具落盘并校验（或给出可修的错误）
