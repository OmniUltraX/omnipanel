## Decisions

- 现场用独立 zustand snapshot，不扩 `ModuleKey`。`buildAiContext` / `AiContextStrip` 在 snapshot.active 时合并文本。
- 进工作台且偏好未关时 `openDrawer`；在工作台内关掉侧栏则记住，再开侧栏则恢复自动打开。
- 工具进 `BUILTIN_TOOL_SPECS` + 前端 UiDelegated handler；写文件走 ToolGate 审批。
- 工作台「问 AI / 按描述生成 / 解释校验」走 `askAiFromSurface(dashboard)`，Agent 为 run（master 工具集含 studio）。
