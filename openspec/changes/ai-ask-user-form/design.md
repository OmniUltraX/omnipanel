## Context

AI 澄清目前只有文本气泡；执行侧已有成熟的 `UiDelegated` 挂起 → 前端 `dispatchPendingTool` → `ai_chat_tool_result` 回传（`omni_plan_*` / spawn / 终端）。本设计沿同一通道增加「等人填表」路径，与 ToolGate / ACP permission 审批语义分离。

前后端边界：

| 层 | 职责 |
|----|------|
| `crates/omnipanel-store` | 注册 `omni_ask_user` schema、`UiDelegated`、跨模块可见；agent 提示词引导澄清优先用本工具 |
| `src-tauri/commands` | 无新 IPC；沿用 `ai_chat_tool_result` |
| `frontend/src/lib/ai` | dispatcher：解析入参、写 `user-question` part、等提交、序列化答案回传 |
| `frontend/src/components/ai` | `UserQuestionForm` 卡片 UI |
| `assistant-ui/thread` | 渲染 `user-question` part |

## Goals / Non-Goals

**Goals:**

- 一轮工具调用可带 1～5 道题（单选 / 多选 / 填空）。
- 聊天内嵌表单；提交或跳过即解除挂起并继续会话。
- 跨模块 Agent 可用；不进审批队列。

**Non-Goals:**

- 条件跳题、文件上传、富文本编辑、问卷模板库。
- 终端 inline block 首期不强制支持（侧栏主路径优先；inline 可降级为只读提示或同 part）。

## Decisions

### 1. 工具名与执行模式：`omni_ask_user` + UiDelegated

- **选**：与 `omni_plan_*` 同模式，后端挂起、前端交互后回传。
- **弃**：纯文本约定解析（脆弱）；复用 ACP permission（语义是批工具不是收集意图）；新 IPC 命令（无必要）。

### 2. 消息 part：`user-question`

```
type: "user-question"
formId, toolCallId, title?, questions[], status, answers?
```

- **选**：独立 part（像 plan），便于 UI 与 tool-call 状态解耦；tool-call part 仍标记 pending→completed。
- **弃**：只改 tool-call UI（历史消息难复现表单）、塞进 ApprovalDraft（与危险确认混淆）。

### 3. 入参 schema（MVP）

```json
{
  "title": "可选总标题",
  "questions": [
    {
      "id": "env",
      "prompt": "部署到哪个环境？",
      "type": "single_choice" | "multi_choice" | "text",
      "options": [{ "id": "prod", "label": "生产" }],
      "required": true,
      "placeholder": "填空提示"
    }
  ]
}
```

约束：`questions` 1～5；`single_choice`/`multi_choice` 必须有 ≥2 options；`text` 无 options。

### 4. 答案回传格式

```json
{
  "ok": true,
  "status": "answered" | "skipped",
  "answers": { "env": "prod", "tags": ["a","b"], "note": "..." }
}
```

跳过：`status=skipped`，`approved=true`（会话继续，模型自行假设或再问）。

### 5. 等待模型

dispatcher **不**阻塞事件循环：写入 part 后 return；表单提交时再调 `aiChatToolResult`。用 `toolCallId` 防重复提交。同会话同时只允许一个 pending `user-question`（新调用若旧未答：旧表单标 superseded，旧 tool 以 skipped 回传）。

### 6. UI

- 复用 `Button`、现有 AI 卡片风格（对齐 PlanView 密度，tokens.css）。
- 非 sticky 顶栏；渲染在 assistant 消息流内（靠近提问点）。
- 已答/已跳：只读摘要，不可再改。

### 7. 跨模块与提示词

- `builtin_tool_is_cross_module` 加入 `omni_ask_user`。
- `plan.md` / `run.md` 等：澄清优先 `omni_ask_user`，少用纯文本连问。

## 数据流

```
AI 调用 omni_ask_user
        │
        ▼
后端挂起 UiDelegated tool_call
        │
        ▼
dispatchPendingTool → askUserToolDispatcher
        │
        ├─► 写入 user-question part (status=pending)
        └─► (等待用户)
                │
        用户提交 / 跳过
                │
                ▼
        更新 part + aiChatToolResult
                │
                ▼
        会话续跑，模型读结构化答案
```

## Risks / Trade-offs

- [模型滥问] → 提示词限制 1～5 题、关键必问；schema maxItems=5  
- [用户迟迟不答导致会话挂起] → 跳过按钮；可选后续超时（本变更不做）  
- [与审批条并存干扰] → 澄清不进 ActionDraft  
- [终端 inline 首期体验弱] → 侧栏完整；inline 后续迭代  
- [答案含敏感信息进历史] → 与普通聊天同级本地存储；不额外上传  

## Migration Plan

- 纯增量；无数据迁移。回滚：移除工具注册与 dispatcher 分支即可，旧 part 只读忽略。

## Open Questions

- 终端 inline 是否要在二期做完整表单（本变更默认不做）。
- 是否允许「其他」自由文本挂在选择题下（MVP：用独立 text 题代替）。
