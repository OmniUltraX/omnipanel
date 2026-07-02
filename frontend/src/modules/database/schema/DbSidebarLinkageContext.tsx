import { createContext, useContext, type ReactNode } from "react";

/** 侧栏与右侧工作区 Tab 联动（不经 dock softRefresh 刷新整页）。 */
export interface DbSidebarLinkageValue {
  activeConnId: string | null;
  activeDatabaseKey: string | null;
  activeTableKey: string | null;
}

const DbSidebarLinkageContext = createContext<DbSidebarLinkageValue | null>(null);

export function DbSidebarLinkageProvider({
  value,
  children,
}: {
  value: DbSidebarLinkageValue;
  children: ReactNode;
}) {
  return (
    <DbSidebarLinkageContext.Provider value={value}>{children}</DbSidebarLinkageContext.Provider>
  );
}

export function useDbSidebarLinkage(): DbSidebarLinkageValue {
  const ctx = useContext(DbSidebarLinkageContext);
  if (!ctx) {
    throw new Error("useDbSidebarLinkage must be used within DbSidebarLinkageProvider");
  }
  return ctx;
}
