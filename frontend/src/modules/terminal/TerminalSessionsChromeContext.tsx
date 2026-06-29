import { createContext, useContext } from "react";

export type TerminalSessionsChromeState = {
  /** 左侧会话侧栏是否已折叠（宽度趋近 0） */
  sidebarCollapsed: boolean;
};

const TerminalSessionsChromeContext = createContext<TerminalSessionsChromeState>({
  sidebarCollapsed: false,
});

export function useTerminalSessionsChrome(): TerminalSessionsChromeState {
  return useContext(TerminalSessionsChromeContext);
}

export const TerminalSessionsChromeProvider = TerminalSessionsChromeContext.Provider;
