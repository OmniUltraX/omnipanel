/**
 * 打断 `stores/terminalStore` ↔ `modules/assistant` 的循环依赖。
 *
 * 背景：terminalStore 原本直接 import `scheduleAssistantSnapshotSync`，而 assistant 侧
 * （autoSync / chatInbox / terminalCmdInbox）又要 import terminalStore，形成环。
 * 环的后果是模块求值顺序被打乱——某些模块体执行时拿到的 store 仍是 undefined，
 * 表现为 `useTerminalStore.subscribe` 抛 "Cannot read properties of undefined"。
 *
 * 这里改为依赖注入：store 只发通知，assistant 在初始化时注册真正的实现。
 */

type SnapshotSyncHook = () => void;

let hook: SnapshotSyncHook | null = null;
/** 注册完成前发生的变更，注册后补一次，避免冷启动期的通知丢失。 */
let pending = false;

/** 由 `modules/assistant/autoSync` 在模块加载时注册实现。 */
export function setAssistantSnapshotSyncHook(fn: SnapshotSyncHook | null): void {
  hook = fn;
  if (fn && pending) {
    pending = false;
    invoke(fn);
  }
}

function invoke(fn: SnapshotSyncHook): void {
  try {
    fn();
  } catch (err) {
    console.warn("[assistantSnapshotSync] 快照同步失败：", err);
  }
}

/**
 * store 侧调用：通知 assistant「数据已变更，可安排一次快照同步」。
 * 未注册时记下 pending（例如只加载了 store、没有加载 assistant 的测试环境），
 * 等注册完成再补一次；注册前重复调用不会叠加。
 */
export function notifyAssistantSnapshotSync(): void {
  if (!hook) {
    pending = true;
    return;
  }
  pending = false;
  invoke(hook);
}
