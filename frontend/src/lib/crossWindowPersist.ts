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
export function subscribePersistStoreCrossWindow(
  storageKey: string,
  store: PersistLikeStore,
): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.storageArea !== localStorage) return;
    if (event.key !== storageKey) return;
    // 删除 key 时也 rehydrate（重置场景）
    void Promise.resolve(store.persist.rehydrate()).catch((e) => {
      console.error(`[crossWindowPersist] rehydrate ${storageKey} 失败`, e);
    });
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}
