import { create } from "zustand";

/** 数据库左侧连接树与右侧 Tab 的联动定位（独立于 DatabasePanel 重渲染） */
export type DbSidebarLinkageState = {
  activeConnId: string | null;
  activeDatabaseKey: string | null;
  activeTableKey: string | null;
  /** 所有已在工作区打开 Tab 的树节点 id 集合（用于标记"已打开"状态） */
  openTabNodeIds: Set<string>;
  setLinkage: (next: {
    activeConnId: string | null;
    activeDatabaseKey: string | null;
    activeTableKey: string | null;
  }) => void;
  setOpenTabNodeIds: (next: Set<string>) => void;
};

export const useDbSidebarLinkageStore = create<DbSidebarLinkageState>((set, get) => ({
  activeConnId: null,
  activeDatabaseKey: null,
  activeTableKey: null,
  openTabNodeIds: new Set<string>(),
  setLinkage: (next) => {
    const prev = get();
    if (
      prev.activeConnId === next.activeConnId &&
      prev.activeDatabaseKey === next.activeDatabaseKey &&
      prev.activeTableKey === next.activeTableKey
    ) {
      return;
    }
    set(next);
  },
  setOpenTabNodeIds: (next) => {
    const prev = get();
    if (prev.openTabNodeIds === next || prev.openTabNodeIds.size === next.size) {
      // 浅比较 Set：同引用或同大小则跳过（大小不同必然变化）
      if (prev.openTabNodeIds === next) return;
      // 大小相同则逐个比较
      let same = true;
      for (const id of next) {
        if (!prev.openTabNodeIds.has(id)) {
          same = false;
          break;
        }
      }
      if (same) return;
    }
    set({ openTabNodeIds: next });
  },
}));
