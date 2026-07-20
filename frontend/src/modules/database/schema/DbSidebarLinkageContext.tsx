import { createContext, useContext, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { useDbSidebarLinkageStore } from "../../../stores/dbSidebarLinkageStore";

/** 侧栏与右侧工作区 Tab 联动（不经 dock softRefresh 刷新整页）。 */
export interface DbSidebarLinkageValue {
  activeConnId: string | null;
  activeDatabaseKey: string | null;
  activeTableKey: string | null;
}

const DbSidebarLinkageContext = createContext<boolean>(false);

/** 兼容旧调用方；实际状态读自 dbSidebarLinkageStore，可脱离 DatabasePanel 独立重渲染 */
export function DbSidebarLinkageProvider({
  children,
}: {
  value?: DbSidebarLinkageValue;
  children: ReactNode;
}) {
  return (
    <DbSidebarLinkageContext.Provider value={true}>{children}</DbSidebarLinkageContext.Provider>
  );
}

export function useDbSidebarLinkage(): DbSidebarLinkageValue {
  const inProvider = useContext(DbSidebarLinkageContext);
  if (!inProvider) {
    throw new Error("useDbSidebarLinkage must be used within DbSidebarLinkageProvider");
  }
  return useDbSidebarLinkageStore(
    useShallow((s) => ({
      activeConnId: s.activeConnId,
      activeDatabaseKey: s.activeDatabaseKey,
      activeTableKey: s.activeTableKey,
    })),
  );
}
