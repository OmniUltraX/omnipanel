/**
 * 打断 `stores/authStore` ↔ `modules/assistant`（ChatInbox / TerminalCmdInbox）的循环依赖。
 *
 * authStore 只经 bridge 启停收件箱；assistant 侧在模块加载时注册真正的实现。
 */

type InboxHook = () => void | Promise<void>;

let startChatHook: InboxHook | null = null;
let stopChatHook: InboxHook | null = null;
let startTerminalCmdHook: InboxHook | null = null;
let stopTerminalCmdHook: InboxHook | null = null;

/** 由 `modules/assistant/chatInbox` 在模块加载时注册。 */
export function setAssistantChatInboxHooks(
  start: InboxHook | null,
  stop: InboxHook | null,
): void {
  startChatHook = start;
  stopChatHook = stop;
}

/** 由 `modules/assistant/terminalCmdInbox` 在模块加载时注册。 */
export function setAssistantTerminalCmdInboxHooks(
  start: InboxHook | null,
  stop: InboxHook | null,
): void {
  startTerminalCmdHook = start;
  stopTerminalCmdHook = stop;
}

async function safeRun(fn: InboxHook | null, label: string): Promise<void> {
  if (!fn) return;
  try {
    await fn();
  } catch (err) {
    console.warn(`[assistantInbox] ${label} 失败：`, err);
  }
}

/** store 侧：启动助手 Chat 收件箱。 */
export function startAssistantChatInboxViaBridge(): Promise<void> {
  return safeRun(startChatHook, "startChatInbox");
}

/** store 侧：停止助手 Chat 收件箱。 */
export function stopAssistantChatInboxViaBridge(): Promise<void> {
  return safeRun(stopChatHook, "stopChatInbox");
}

/** store 侧：启动助手终端命令收件箱。 */
export function startAssistantTerminalCmdInboxViaBridge(): Promise<void> {
  return safeRun(startTerminalCmdHook, "startTerminalCmdInbox");
}

/** store 侧：停止助手终端命令收件箱。 */
export function stopAssistantTerminalCmdInboxViaBridge(): Promise<void> {
  return safeRun(stopTerminalCmdHook, "stopTerminalCmdInbox");
}
