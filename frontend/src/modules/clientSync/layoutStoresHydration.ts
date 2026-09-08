/**
 * 侧栏文件夹相关 persist store 的水合门禁。
 *
 * SSH / Docker 树走 IndexedDB（异步），auth 走 localStorage（同步）。
 * 若在水合完成前拉取云端或回推快照，内存里仍是空 folders，会：
 * 1) 把空布局写进 OSS；2) 或被迟到的 rehydrate 盖掉刚 apply 的云端布局。
 */

type PersistApi = {
  hasHydrated: () => boolean;
  onFinishHydration: (fn: () => void) => () => void;
};

type PersistStore = {
  persist: PersistApi;
};

function waitOne(store: PersistStore, timeoutMs: number): Promise<void> {
  if (store.persist.hasHydrated()) return Promise.resolve();
  return new Promise((resolve) => {
    const unsub = store.persist.onFinishHydration(() => {
      window.clearTimeout(timer);
      unsub();
      resolve();
    });
    const timer = window.setTimeout(() => {
      unsub();
      resolve();
    }, timeoutMs);
  });
}

/** 等待各模块侧栏文件夹 store 完成 persist 水合（带超时兜底）。 */
export async function waitLayoutStoresHydrated(timeoutMs = 4000): Promise<void> {
  const [
    { useSshSidebarTreeStore },
    { useDockerSidebarTreeStore },
    { useDbSchemaConnectionLayoutStore },
    { useProtocolHttpLayoutStore },
  ] = await Promise.all([
    import("../../stores/sshSidebarTreeStore"),
    import("../../stores/dockerSidebarTreeStore"),
    import("../../stores/dbSchemaConnectionLayoutStore"),
    import("../../stores/protocolHttpLayoutStore"),
  ]);

  await Promise.all([
    waitOne(useSshSidebarTreeStore, timeoutMs),
    waitOne(useDockerSidebarTreeStore, timeoutMs),
    waitOne(useDbSchemaConnectionLayoutStore, timeoutMs),
    waitOne(useProtocolHttpLayoutStore, timeoutMs),
  ]);
}
