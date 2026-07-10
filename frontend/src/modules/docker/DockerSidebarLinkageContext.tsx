import { createContext, useContext, type ReactNode } from "react";
import type { DockerSidebarNavigate } from "./dockerSidebarNav";

/** 侧栏与右侧工作区联动。 */
export interface DockerSidebarLinkageValue {
  activeConnectionId: string | null;
  activeNavKey: string | null;
  onNavigate: DockerSidebarNavigate;
}

const DockerSidebarLinkageContext = createContext<DockerSidebarLinkageValue | null>(null);

export function DockerSidebarLinkageProvider({
  value,
  children,
}: {
  value: DockerSidebarLinkageValue;
  children: ReactNode;
}) {
  return (
    <DockerSidebarLinkageContext.Provider value={value}>{children}</DockerSidebarLinkageContext.Provider>
  );
}

export function useDockerSidebarLinkage(): DockerSidebarLinkageValue {
  const ctx = useContext(DockerSidebarLinkageContext);
  if (!ctx) {
    throw new Error("useDockerSidebarLinkage must be used within DockerSidebarLinkageProvider");
  }
  return ctx;
}
