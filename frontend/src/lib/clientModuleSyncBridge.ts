/**
 * 打断 `stores/*` ↔ `modules/clientSync`（模块快照推送）的循环依赖。
 *
 * store 只发通知；`modules/clientSync/moduleSync` 在模块加载时注册真正的实现。
 */

type ModuleSyncHook = () => void;
type CancelHook = () => void;

let hook: ModuleSyncHook | null = null;
let cancelHook: CancelHook | null = null;
/** 注册完成前发生的变更，注册后补一次。 */
let pending = false;

/** 由 `modules/clientSync/moduleSync` 在模块加载时注册实现。 */
export function setClientModuleSyncHook(fn: ModuleSyncHook | null): void {
  hook = fn;
  if (fn && pending) {
    pending = false;
    invoke(fn);
  }
}

/** 由 `modules/clientSync/moduleSync` 注册取消实现（登出时调用）。 */
export function setClientModuleSyncCancelHook(fn: CancelHook | null): void {
  cancelHook = fn;
}

function invoke(fn: ModuleSyncHook): void {
  try {
    fn();
  } catch (err) {
    console.warn("[clientModuleSync] 模块同步失败：", err);
  }
}

/**
 * store 侧调用：通知 clientSync「模块数据已变更，可安排一次推送」。
 * 未注册时记下 pending，等注册完成再补一次。
 */
export function notifyClientModuleSync(): void {
  if (!hook) {
    pending = true;
    return;
  }
  pending = false;
  invoke(hook);
}

/** store 侧调用：取消尚未发出的客户端模块同步。 */
export function cancelClientModuleSyncViaBridge(): void {
  try {
    cancelHook?.();
  } catch (err) {
    console.warn("[clientModuleSync] 取消同步失败：", err);
  }
}
