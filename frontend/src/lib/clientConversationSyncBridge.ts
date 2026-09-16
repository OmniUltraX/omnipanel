/**
 * 打断 `stores/aiStore` ↔ `modules/clientSync`（会话同步）的循环依赖。
 *
 * store 只发通知；`modules/clientSync/autoSync` 在模块加载时注册真正的实现。
 */

type ConversationSyncHook = () => void;
type CancelHook = () => void;

let hook: ConversationSyncHook | null = null;
let cancelHook: CancelHook | null = null;
/** 注册完成前发生的变更，注册后补一次。 */
let pending = false;

/** 由 `modules/clientSync/autoSync` 在模块加载时注册实现。 */
export function setClientConversationSyncHook(fn: ConversationSyncHook | null): void {
  hook = fn;
  if (fn && pending) {
    pending = false;
    invoke(fn);
  }
}

/** 由 `modules/clientSync/autoSync` 注册取消实现（登出时调用）。 */
export function setClientConversationSyncCancelHook(fn: CancelHook | null): void {
  cancelHook = fn;
}

function invoke(fn: ConversationSyncHook): void {
  try {
    fn();
  } catch (err) {
    console.warn("[clientConversationSync] 会话同步失败：", err);
  }
}

/**
 * store 侧调用：通知 clientSync「会话已变更，可安排一次推送」。
 * 未注册时记下 pending，等注册完成再补一次。
 */
export function notifyClientConversationSync(): void {
  if (!hook) {
    pending = true;
    return;
  }
  pending = false;
  invoke(hook);
}

/** store 侧调用：取消尚未发出的客户端会话同步。 */
export function cancelClientConversationSyncViaBridge(): void {
  try {
    cancelHook?.();
  } catch (err) {
    console.warn("[clientConversationSync] 取消同步失败：", err);
  }
}
