# ask_user 助手端同步与答题闭环

## 目标

桌面 `omni_ask_user` 澄清表单同步到 OSS，小程序可渲染并提交/跳过；答案经 notify 回桌面续跑挂起工具。

## 下行（桌面 → OSS）

- 协议仍为 `omni-chat-sections.v1`，新增段标签 `ask_user____`（12 字符）。
- 正文：NDJSON，每行一份 `UserQuestionFormData`；同 `formId` 覆盖。
- 写入点：`askUserToolDispatcher` 在 `persistForm` 后 `appendChatOssEvent({ t: "ask_user", form })`。
- `omni_ask_user` 仍不写入 `tool_calling` / `tool___result`。

## 上行（小程序 → 桌面）

- 复用 `agent_chat_message/{userKey}/{messageId}.json` + `/api/notify`。
- 文档增加 `type: "ask_user_answer"` 与 `ask_user: { formId, toolCallId, status, answers? }`。
- 桌面解析后走快通道：直接 `submitAskUserAnswers` / `skipAskUserForm`，不进 `sendToAiDock`，不等 `!isGenerating`。
- 无 `type`/`ask_user` 时保持现有纯文本入站行为。

## 小程序

- 解析 `ask_user____` → part `type: "ask_user"`；渲染表单；提交写 notify。
- 终态（answered/skipped/superseded）只读；pending 可交互。

## 非目标

- 不 bump format 版本号；不把答案当普通用户气泡进 Dock。
