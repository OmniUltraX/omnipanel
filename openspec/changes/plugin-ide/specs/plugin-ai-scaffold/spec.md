## ADDED Requirements

### Requirement: AI 生成插件骨架

studio SHALL 提供"描述需求→生成骨架"：经宿主 AI oneshot 按定版模板生成 `plugin.json/ui/main.js/ui/index.html` 三件套并写入工程目录；生成后 SHALL 自动跑校验，失败把错误贴回日志；audit SHALL 记 `plugin.ai_scaffold`（提示词摘要，不落原文）。

#### Scenario: 一句话出骨架

- **WHEN** 用户输入"做个选中翻译插件"并确认
- **THEN** 三件套落盘且校验通过（或给出可修的错误）
