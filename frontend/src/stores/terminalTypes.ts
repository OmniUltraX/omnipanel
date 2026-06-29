import type { Terminal } from "@xterm/xterm";

export type TerminalSessionType = "local" | "remote";

export type TerminalSessionInfo = {
  type: TerminalSessionType;
  resourceId: string;
  shellLabel: string;
  cwd: string;
  purpose: string;
  commandPack: string[];
};

export type TerminalConnectionStatus = "connecting" | "connected" | "disconnected";

export interface TerminalTab {
  id: string;
  sessionId: string;
  title: string;
  session: TerminalSessionInfo;
  workspaceId?: string;
  workspaceOnly?: boolean;
  backendSessionId: string | null;
  status: TerminalConnectionStatus;
  terminal: Terminal | null;
  createdAt: number;
}

export interface TerminalPane {
  id: string;
  backendSessionId: string | null;
  title: string;
  type: TerminalSessionType;
  resourceId: string;
  shellLabel: string;
  cwd: string;
  purpose: string;
  commandPack: string[];
  terminal: Terminal | null;
  status: TerminalConnectionStatus;
}

export type TerminalTabInput = Omit<
  TerminalTab,
  "backendSessionId" | "status" | "terminal" | "createdAt" | "sessionId"
> & { sessionId?: string };
