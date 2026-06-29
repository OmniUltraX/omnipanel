import { createContext, useContext, type ReactNode } from "react";

export interface TerminalSidebarLinkageValue {
  activeSessionId: string | null;
  activeResourceId: string | null;
}

const TerminalSidebarLinkageContext = createContext<TerminalSidebarLinkageValue | null>(null);

export function TerminalSidebarLinkageProvider({
  value,
  children,
}: {
  value: TerminalSidebarLinkageValue;
  children: ReactNode;
}) {
  return (
    <TerminalSidebarLinkageContext.Provider value={value}>
      {children}
    </TerminalSidebarLinkageContext.Provider>
  );
}

export function useTerminalSidebarLinkage(): TerminalSidebarLinkageValue {
  const ctx = useContext(TerminalSidebarLinkageContext);
  if (!ctx) {
    throw new Error("useTerminalSidebarLinkage must be used within TerminalSidebarLinkageProvider");
  }
  return ctx;
}
