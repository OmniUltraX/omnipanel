import { createContext, useContext, type ReactNode } from "react";
import type { DockerConnectionInfo } from "@/ipc/bindings";
import type { DockerSidebarNavigate } from "./dockerSidebarNav";

/** 侧栏与右侧工作区联动。 */
export interface DockerSidebarLinkageValue {
  activeConnectionId: string | null;
  activeNavKey: string | null;
  onNavigate: DockerSidebarNavigate;
  /**
   * 最新连接快照。Dock 面板 props 可能因 softRev 未 bump 而滞后，
   * 订阅此 Map 可在连接状态变化时更新面板内容（无需 flushSync soft bump）。
   */
  connectionById: ReadonlyMap<string, DockerConnectionInfo>;
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

/** 优先使用联动上下文中的最新连接，避免 Dock 缓存 props 过期。 */
export function useDockerLiveConnection(fallback: DockerConnectionInfo): DockerConnectionInfo {
  const { connectionById } = useDockerSidebarLinkage();
  return connectionById.get(fallback.connectionId) ?? fallback;
}
