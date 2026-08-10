# ask_user OSS 同步与答题闭环 Implementation Plan

> **For agentic workers:** 按任务顺序实现；步骤用 checkbox 跟踪。

**Goal:** 澄清表单同步到助手端并可在小程序答题回传桌面续跑。

**Architecture:** 下行仿 Plan 专用段 `ask_user____`；上行复用 notify JSON 扩展 `type=ask_user_answer`，桌面快通道调用现有 submit/skip。

**Tech Stack:** TypeScript (omnipanel frontend)、Rust (omnipanel-assistant)、Vue/JS (omniminiapp)

## Global Constraints

- 中文回复；不擅自 git commit。
- 不删除原有注释；不写无关文档。
- 临时测试文件用完删除。

---

### Task 1: 桌面 chatOssRecorder 增加 ask_user 段

**Files:**
- Modify: `frontend/src/lib/ai/chatOssRecorder.ts`
- Modify: `frontend/src/lib/ai/chatOssRecorder.test.ts`

- [x] 增加 tag / event / 聚合 / 编码
- [x] 单测：同 formId 覆盖、编码含 `|[ask_user____]|`

### Task 2: dispatcher 写入 OSS

**Files:**
- Modify: `frontend/src/lib/ai/orchestration/askUserToolDispatcher.ts`

- [x] `persistForm` 后 `appendChatOssEvent({ t: "ask_user", form })`

### Task 3: 入站解析 ask_user_answer

**Files:**
- Modify: `crates/omnipanel-assistant/src/chat.rs`
- Modify: `src-tauri/src/commands/assistant_chat.rs`
- Modify: `frontend/src/modules/assistant/chatInbox.ts`（及 bindings 若需 gen）

- [x] 解析 `type`/`ask_user`；空 text 也可 emit
- [x] chatInbox 快通道 submit/skip
- [x] extract_section 忽略 `ask_user____`

### Task 4: 小程序解析与 UI

**Files:**
- Modify: `D:/omniminiapp/src/common/chat-oss.js`
- Create: `D:/omniminiapp/src/components/chat/AskUserForm.vue`
- Modify: `D:/omniminiapp/src/components/main/AiAssistantPanel.vue`
- Modify: i18n zh/en 如需

- [x] SECTION_TAG_MAP + upsertAskUser + submitAskUserAnswer
- [x] AskUserForm 组件挂载
- [x] group 逻辑保留 ask_user part

### Task 5: 验证

- [x] `frontend` vitest：chatOssRecorder
- [x] `cargo test -p omnipanel-assistant` 相关测例
