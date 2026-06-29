import { beforeEach, describe, expect, it } from "vitest";
import { useTerminalStore } from "./terminalStore";
import { LOCAL_TERMINAL_RESOURCE_ID } from "../modules/terminal/paneResource";
import { migrateLegacyTabsToSessions } from "./terminalSessionModel";

function resetTerminalStore() {
  useTerminalStore.setState({
    sessions: [],
    tabs: [],
    activeTabId: null,
    activeSessionId: null,
    detachedRuntime: {},
    embeddedPanes: {},
  });
}

describe("terminalStore session lifecycle", () => {
  beforeEach(() => {
    resetTerminalStore();
  });

  it("creates independent sessions per connection", () => {
    const first = useTerminalStore.getState().addLocalTerminalTab("本地 1");
    const second = useTerminalStore.getState().addLocalTerminalTab("本地 2");
    expect(first).not.toBe(second);
    const sessions = useTerminalStore.getState().sessions.filter(
      (s) => s.session.resourceId === LOCAL_TERMINAL_RESOURCE_ID,
    );
    expect(sessions).toHaveLength(2);
  });

  it("close tab only suspends session and keeps detached runtime", () => {
    const tabId = useTerminalStore.getState().addLocalTerminalTab("测试");
    const sessionId = useTerminalStore.getState().tabs.find((t) => t.id === tabId)?.sessionId;
    expect(sessionId).toBeTruthy();

    useTerminalStore.getState().setBackendSessionId(sessionId!, "backend-1");
    useTerminalStore.getState().setStatus(sessionId!, "connected");
    useTerminalStore.getState().closeTabOnly(sessionId!);

    const state = useTerminalStore.getState();
    expect(state.tabs).toHaveLength(0);
    expect(state.sessions.find((s) => s.id === sessionId)?.lifecycle).toBe("suspended");
    expect(state.detachedRuntime[sessionId!]?.backendSessionId).toBe("backend-1");
  });

  it("reopens suspended session as tab and restores detached backend", () => {
    const tabId = useTerminalStore.getState().addLocalTerminalTab("恢复");
    const sessionId = useTerminalStore.getState().tabs.find((t) => t.id === tabId)?.sessionId!;
    useTerminalStore.getState().setBackendSessionId(sessionId, "backend-2");
    useTerminalStore.getState().closeTabOnly(sessionId);

    const reopenedTabId = useTerminalStore.getState().openSessionTab(sessionId);
    const tab = useTerminalStore.getState().tabs.find((t) => t.id === reopenedTabId);
    expect(tab?.backendSessionId).toBe("backend-2");
    expect(useTerminalStore.getState().detachedRuntime[sessionId]).toBeUndefined();
    expect(useTerminalStore.getState().sessions.find((s) => s.id === sessionId)?.lifecycle).toBe(
      "active",
    );
  });

  it("end session removes tab and detached runtime", () => {
    const tabId = useTerminalStore.getState().addLocalTerminalTab("结束");
    const sessionId = useTerminalStore.getState().tabs.find((t) => t.id === tabId)?.sessionId!;
    useTerminalStore.getState().setBackendSessionId(sessionId, "backend-3");
    useTerminalStore.getState().closeTabOnly(sessionId);

    useTerminalStore.getState().endSession(sessionId);
    const state = useTerminalStore.getState();
    expect(state.tabs).toHaveLength(0);
    expect(state.detachedRuntime[sessionId]).toBeUndefined();
    expect(state.sessions.find((s) => s.id === sessionId)?.lifecycle).toBe("ended");
  });

  it("lastActiveAt tracks command activity, not tab focus", () => {
    const firstTabId = useTerminalStore.getState().addLocalTerminalTab("会话 A");
    const secondTabId = useTerminalStore.getState().addLocalTerminalTab("会话 B");
    const firstSessionId = useTerminalStore.getState().tabs.find((t) => t.id === firstTabId)?.sessionId!;
    const secondSessionId = useTerminalStore.getState().tabs.find((t) => t.id === secondTabId)?.sessionId!;

    const initial =
      useTerminalStore.getState().sessions.find((s) => s.id === firstSessionId)?.lastActiveAt ?? 0;
    expect(initial).toBe(0);

    useTerminalStore.getState().setActiveTab(secondTabId);
    const afterFocus =
      useTerminalStore.getState().sessions.find((s) => s.id === firstSessionId)?.lastActiveAt ?? 0;
    expect(afterFocus).toBe(initial);

    useTerminalStore.getState().touchSession(firstSessionId);
    const afterActivity =
      useTerminalStore.getState().sessions.find((s) => s.id === firstSessionId)?.lastActiveAt ?? 0;
    expect(afterActivity).toBeGreaterThan(0);

    const beforeSecondTouch =
      useTerminalStore.getState().sessions.find((s) => s.id === secondSessionId)?.lastActiveAt ?? 0;
    useTerminalStore.getState().touchSession(secondSessionId);
    const secondActive =
      useTerminalStore.getState().sessions.find((s) => s.id === secondSessionId)?.lastActiveAt ?? 0;
    expect(secondActive).toBeGreaterThan(beforeSecondTouch);
  });

  it("migrates legacy tab rows into session entities", () => {
    const migrated = migrateLegacyTabsToSessions([
      {
        id: "tab-legacy-1",
        title: "旧会话",
        session: {
          type: "remote",
          resourceId: "host-1",
          shellLabel: "SSH",
          cwd: "~/",
          purpose: "SSH",
          commandPack: [],
        },
      },
    ]);
    expect(migrated.sessions).toHaveLength(1);
    expect(migrated.sessions[0].id).toBe("tab-legacy-1");
    expect(migrated.openSessionIds).toContain("tab-legacy-1");
  });
});
