import { create } from "zustand";

/** 数据库左侧连接树与右侧 Tab 的联动定位（独立于 DatabasePanel 重渲染） */
export type DbSidebarLinkageState = {
  activeConnId: string | null;
  activeDatabaseKey: string | null;
  activeTableKey: string | null;
  setLinkage: (next: {
    activeConnId: string | null;
    activeDatabaseKey: string | null;
    activeTableKey: string | null;
  }) => void;
};

export const useDbSidebarLinkageStore = create<DbSidebarLinkageState>((set, get) => ({
  activeConnId: null,
  activeDatabaseKey: null,
  activeTableKey: null,
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
}));
