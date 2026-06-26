import { createContext, useContext, type ReactNode } from "react";

/** 侧栏与右侧 Dock Tab 联动（不经 dock softRefresh 刷新整页）。 */
export interface SshSidebarLinkageValue {
  activeHostId: string | null;
}

const SshSidebarLinkageContext = createContext<SshSidebarLinkageValue | null>(null);

export function SshSidebarLinkageProvider({
  value,
  children,
}: {
  value: SshSidebarLinkageValue;
  children: ReactNode;
}) {
  return (
    <SshSidebarLinkageContext.Provider value={value}>{children}</SshSidebarLinkageContext.Provider>
  );
}

export function useSshSidebarLinkage(): SshSidebarLinkageValue {
  const ctx = useContext(SshSidebarLinkageContext);
  if (!ctx) {
    throw new Error("useSshSidebarLinkage must be used within SshSidebarLinkageProvider");
  }
  return ctx;
}
