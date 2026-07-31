## 1. 工具注册与跨模块可见

- [x] 1.1 在 `crates/omnipanel-store/src/builtin_tool_spec.rs` 新增 `omni_ask_user` schema（title / questions / 题型 / options），`UiDelegated`，`module_key=web`；加入 `builtin_tool_is_cross_module`
- [x] 1.2 更新 `crates/omnipanel-store/resources/prompts/agents/*.md`（至少 plan / run）与相关默认提示：澄清优先调用 `omni_ask_user`；`cargo test -p omnipanel-store` 相关断言通过

## 2. 消息模型与分派

- [x] 2.1 在 `frontend/src/lib/ai/aiMessageParts.ts` 增加 `user-question` part 类型与 upsert/更新辅助函数
- [x] 2.2 新增 `frontend/src/lib/ai/orchestration/askUserToolDispatcher.ts`：校验入参、写 part、supersede 旧 pending、提交/跳过时 `aiChatToolResult`；`internalToolBridge.dispatchPendingTool` 拦截该工具
- [x] 2.3 `frontend/src/lib/ai/context/moduleBuiltinCatalog.ts` 增加占位注册（与 plan 工具一致）

## 3. UI 与 i18n

- [x] 3.1 实现 `frontend/src/components/ai/UserQuestionForm.tsx`（单选/多选/填空 + 提交/跳过 + 只读态）；样式对齐 AI 卡片 tokens
- [x] 3.2 在 `frontend/src/components/assistant-ui/thread.tsx`（及必要 messageBridge）渲染 `user-question` part
- [x] 3.3 补充 `zh-CN` / `en-US` 文案键

## 4. 测试与验收

- [x] 4.1 前端单测：入参校验、答案序列化、必填校验（vitest）
- [ ] 4.2 手动验收：侧栏让 AI 澄清时出现表单；提交后会话继续；跳过可继续；不弹出 ToolGate 审批条
