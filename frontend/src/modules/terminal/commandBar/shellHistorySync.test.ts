import { describe, expect, it, beforeEach } from "vitest";
import { useTerminalStore } from "../../../stores/terminalStore";
import {
  isSilentHistorySyncCommand,
  resolveShellHistorySyncCommand,
  SHELL_HISTORY_SYNC_COMMAND,
  SHELL_HISTORY_SYNC_COMMAND_POWERSHELL,
} from "./shellHistorySync";

describe("resolveShellHistorySyncCommand", () => {
  beforeEach(() => {
    useTerminalStore.setState({
      tabs: [
        {
          id: "tab-local",
          sessionId: "tab-local",
          title: "本地",
          backendSessionId: "pty-1",
          session: {
            type: "local",
            resourceId: "local-terminal",
            shellLabel: "PowerShell",
            cwd: "C:\\Users\\chaoj",
            purpose: "Local",
            commandPack: [],
          },
          status: "connected",
          terminal: null,
          createdAt: Date.now(),
        },
        {
          id: "tab-ssh",
          sessionId: "tab-ssh",
          title: "SSH",
          backendSessionId: "ssh-1",
          session: {
            type: "remote",
            resourceId: "conn-1",
            shellLabel: "bash",
            cwd: "/root",
            purpose: "SSH",
            commandPack: [],
          },
          status: "connected",
          terminal: null,
          createdAt: Date.now(),
        },
      ],
      embeddedPanes: {},
      sessions: [],
      detachedRuntime: {},
    });
  });

  it("uses PowerShell sync on local Windows shell", () => {
    expect(resolveShellHistorySyncCommand("tab-local")).toBe(
      SHELL_HISTORY_SYNC_COMMAND_POWERSHELL,
    );
  });

  it("uses bash sync on remote posix shell", () => {
    expect(resolveShellHistorySyncCommand("tab-ssh")).toBe(SHELL_HISTORY_SYNC_COMMAND);
  });
});

describe("isSilentHistorySyncCommand", () => {
  it("detects PowerShell history sync one-liner", () => {
    expect(
      isSilentHistorySyncCommand(
        "Write-Output '__OMNIPANEL_HIST_BEGIN__'; Get-PSReadLineOption",
      ),
    ).toBe(true);
  });
});
