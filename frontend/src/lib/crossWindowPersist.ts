/**
 * 跨窗口同步 zustand persist store（localStorage）。
 * 其他窗口写入同一 key 时，本窗口通过 storage 事件合并最新状态。
 */

type PersistLikeStore = {
  persist: {
    rehydrate: () => Promise<void> | void;
  };
};

/**
 * 监听 localStorage 变更并触发指定 persist store 的 rehydrate。
 * 仅在「其他文档」（其他 WebView 窗口）写入时触发；本窗口自己的写入不会冒泡 storage 事件。
 */
const REHYDRATE_DEBOUNCE_MS = 200;

export function subscribePersistStoreCrossWindow(
  storageKey: string,
  store: PersistLikeStore,
): () => void {
  let rehydrateTimer: ReturnType<typeof setTimeout> | null = null;

  const onStorage = (event: StorageEvent) => {
    if (event.storageArea !== localStorage) return;
    if (event.key !== storageKey) return;
    // 拖拽 layout 高频写入时合并 rehydrate，避免跨窗互相拖垮主线程
    if (rehydrateTimer) clearTimeout(rehydrateTimer);
    rehydrateTimer = setTimeout(() => {
      rehydrateTimer = null;
      void Promise.resolve(store.persist.rehydrate()).catch((e) => {
        console.error(`[crossWindowPersist] rehydrate ${storageKey} 失败`, e);
      });
    }, REHYDRATE_DEBOUNCE_MS);
  };
  window.addEventListener("storage", onStorage);
  return () => {
    if (rehydrateTimer) clearTimeout(rehydrateTimer);
    window.removeEventListener("storage", onStorage);
  };
}
