import { createContext, useContext, type ReactNode } from "react";

/** 侧栏与右侧 Dock Tab 联动。 */
export interface ServerSidebarLinkageValue {
  activeServerId: string | null;
}

const ServerSidebarLinkageContext = createContext<ServerSidebarLinkageValue | null>(null);

export function ServerSidebarLinkageProvider({
  value,
  children,
}: {
  value: ServerSidebarLinkageValue;
  children: ReactNode;
}) {
  return (
    <ServerSidebarLinkageContext.Provider value={value}>{children}</ServerSidebarLinkageContext.Provider>
  );
}

export function useServerSidebarLinkage(): ServerSidebarLinkageValue {
  const ctx = useContext(ServerSidebarLinkageContext);
  if (!ctx) {
    throw new Error("useServerSidebarLinkage must be used within ServerSidebarLinkageProvider");
  }
  return ctx;
}
