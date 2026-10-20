import { afterEach, describe, expect, it, vi } from "vitest";

const { panes, openSshTerminalSession, focusTerminalTab } = vi.hoisted(() => ({
  panes: new Map<string, { type: "remote" | "local"; resourceId: string }>(),
  openSshTerminalSession: vi.fn((_resourceId: string) => "tab-first"),
  focusTerminalTab: vi.fn((_tabId: string) => true),
}));

vi.mock("../../stores/terminalStore", () => ({
  findTerminalPane: (id: string) => panes.get(id),
  useTerminalStore: {
    getState: () => ({ activeTabId: "tab-a" }),
  },
}));

vi.mock("../../lib/terminalSession", () => ({
  focusTerminalTab: (tabId: string) => focusTerminalTab(tabId),
  openLocalTerminalSession: vi.fn(() => "local"),
  openSshTerminalSession: (resourceId: string) => openSshTerminalSession(resourceId),
}));

vi.mock("../../stores/connectionStore", () => ({
  resolveResourceById: () => null,
}));

import { ensureAiExecTerminal } from "./aiExecTerminal";
import { terminalPaneSenders } from "./terminalPaneSenders";

afterEach(() => {
  panes.clear();
  openSshTerminalSession.mockClear();
  focusTerminalTab.mockClear();
  for (const key of Object.keys(terminalPaneSenders)) {
    delete terminalPaneSenders[key];
  }
});

describe("ensureAiExecTerminal", () => {
  it("同主机已点名标签时写回该标签，不打开更早的那个", async () => {
    panes.set("tab-a", { type: "remote", resourceId: "host-3" });
    panes.set("tab-b", { type: "remote", resourceId: "host-3" });
    terminalPaneSenders["tab-a"] = () => {};
    terminalPaneSenders["tab-b"] = () => {};

    const tabId = await ensureAiExecTerminal({
      follow: true,
      sessionId: "tab-b",
      sshResourceId: "host-3",
    });

    expect(tabId).toBe("tab-b");
    expect(focusTerminalTab).toHaveBeenCalledWith("tab-b");
    expect(openSshTerminalSession).not.toHaveBeenCalled();
  });

  it("点名的标签是另一台主机时才去打开目标主机", async () => {
    panes.set("tab-b", { type: "remote", resourceId: "host-other" });
    terminalPaneSenders["tab-b"] = () => {};
    terminalPaneSenders["tab-first"] = () => {};

    const tabId = await ensureAiExecTerminal({
      follow: true,
      sessionId: "tab-b",
      sshResourceId: "host-3",
    });

    expect(tabId).toBe("tab-first");
    expect(openSshTerminalSession).toHaveBeenCalledWith("host-3");
  });
});
