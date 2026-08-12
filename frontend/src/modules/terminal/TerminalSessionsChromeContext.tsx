import { createContext, useContext } from "react";

export type TerminalSessionsChromeState = {
  sidebarCollapsed: boolean;
};

const TerminalSessionsChromeContext = createContext<TerminalSessionsChromeState>({
  sidebarCollapsed: false,
});

export function useTerminalSessionsChrome(): TerminalSessionsChromeState {
  return useContext(TerminalSessionsChromeContext);
}

export const TerminalSessionsChromeProvider = TerminalSessionsChromeContext.Provider;
