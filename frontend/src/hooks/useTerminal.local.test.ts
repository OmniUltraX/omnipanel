import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...await original<typeof import("@tauri-apps/api/core")>(),
  invoke: invokeMock,
}));

import { useTerminalStore } from "../stores/terminalStore";
import { createBackendSession } from "./useTerminal";
import { defaultSessionInfo } from "../stores/terminalSessionModel";
import { resolveLocalTerminalShell } from "../lib/localTerminalShell";
import { teamStorageKey } from "../lib/teamPersist";

describe("real local terminal UI creation path on Linux", () => {
  beforeEach(() => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    useTerminalStore.setState({ sessions: [], tabs: [], activeTabId: null, detachedRuntime: {}, embeddedPanes: {} });
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string) => command === "create_terminal" ? "term-native-default" : null);
  });

  it("new local tab through addLocalTerminalTab and actual backend entry delegates shell detection", async () => {
    const id = useTerminalStore.getState().addLocalTerminalTab();
    expect(useTerminalStore.getState().getSession(id)?.session.shellLabel).toBe("Shell");
    await expect(createBackendSession(id, 100, 30)).resolves.toBe("term-native-default");
    expect(invokeMock).toHaveBeenCalledWith("create_terminal", { cols: 100, rows: 30, shell: null });
  });

  it("restored legacy PowerShell display-only label does not request Windows PowerShell", async () => {
    const legacy = { id: "legacy", title: "本地终端", session: { ...defaultSessionInfo("local-terminal", "local"), shellLabel: "PowerShell", shellSpec: null } };
    // The actual current-version persisted merge normalizes session entities
    // and open tabs through separate paths: cover both, not just a model helper.
    localStorage.setItem(teamStorageKey("omnipanel.terminalTabs.v2"), JSON.stringify({
      version: 3,
      state: { sessions: [legacy], tabs: [{ ...legacy, sessionId: legacy.id }], activeTabId: legacy.id },
    }));
    await useTerminalStore.persist.rehydrate();
    expect(useTerminalStore.getState().getSession(legacy.id)?.session.shellLabel).toBe("Shell");
    expect(useTerminalStore.getState().tabs[0]?.session.shellLabel).toBe("Shell");
    await createBackendSession(legacy.id, 80, 24);
    expect(invokeMock).toHaveBeenCalledWith("create_terminal", { cols: 80, rows: 24, shell: null });
  });

  it("preserves explicit Linux bash or cross-platform pwsh selections", () => {
    for (const kind of ["bash", "powershell"] as const) {
      const spec = { kind, path: "/explicit/path", wslDistro: null };
      expect(resolveLocalTerminalShell(spec, "label", "Linux")).toBe(spec);
    }
  });

  it("retains Windows legacy migration and excludes Windows-only migrated specs on Linux", () => {
    expect(resolveLocalTerminalShell(null, "PowerShell", "Win32")?.kind).toBe("powershell5");
    expect(resolveLocalTerminalShell(null, "Ubuntu (WSL)", "Win32")?.wslDistro).toBe("Ubuntu");
    expect(resolveLocalTerminalShell({ kind: "powershell5", path: null, wslDistro: null }, "Windows PowerShell 5", "Linux")).toBeNull();
  });
});
