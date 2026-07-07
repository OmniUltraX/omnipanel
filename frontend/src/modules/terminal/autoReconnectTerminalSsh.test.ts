import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listenMock = vi.fn(async () => () => undefined);
const setBackendSessionIdMock = vi.fn();
const setStatusMock = vi.fn();
const bumpReconnectMock = vi.fn();
const clearPaneBackendPendingMock = vi.fn();
const disposeSessionBackendMock = vi.fn();
const clearTerminalPaneSenderMock = vi.fn();
const settingGetMock = vi.fn(() => true);
const tabsRef: { current: Array<{ sessionId: string; status: string }> } = {
  current: [],
};
const useTerminalStoreSubscribeMock = vi.fn(() => () => undefined);

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
}));

vi.mock("../../stores/settingsStore", () => ({
  useSettingsStore: {
    getState: () => ({ terminalAutoReconnectSsh: settingGetMock() }),
  },
}));

vi.mock("../../stores/terminalStore", () => ({
  useTerminalStore: {
    getState: () => ({
      tabs: tabsRef.current,
      setBackendSessionId: setBackendSessionIdMock,
      setStatus: setStatusMock,
      bumpReconnect: bumpReconnectMock,
    }),
    subscribe: useTerminalStoreSubscribeMock,
  },
}));

vi.mock("../../hooks/useTerminal", () => ({
  clearPaneBackendPending: clearPaneBackendPendingMock,
  disposeSessionBackend: disposeSessionBackendMock,
}));

vi.mock("./terminalPaneSenders", () => ({
  clearTerminalPaneSender: clearTerminalPaneSenderMock,
}));

const importModule = async () => {
  vi.resetModules();
  return await import("./autoReconnectTerminalSsh");
};

describe("autoReconnectTerminalSsh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    listenMock.mockClear();
    setBackendSessionIdMock.mockClear();
    setStatusMock.mockClear();
    bumpReconnectMock.mockClear();
    clearPaneBackendPendingMock.mockClear();
    disposeSessionBackendMock.mockClear();
    clearTerminalPaneSenderMock.mockClear();
    useTerminalStoreSubscribeMock.mockClear();
    settingGetMock.mockReturnValue(true);
    tabsRef.current = [{ sessionId: "live-session", status: "disconnected" }];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers Tauri listener and store subscription on module load", async () => {
    await importModule();
    expect(listenMock).toHaveBeenCalledWith("terminal-event", expect.any(Function));
    expect(useTerminalStoreSubscribeMock).toHaveBeenCalled();
  });

  it("schedules reconnect when terminal-event exited arrives", async () => {
    const mod = await importModule();
    tabsRef.current = [{ sessionId: "s1", status: "disconnected" }];
    expect(mod.scheduleAutoReconnectSsh("s1")).toBe(true);
    expect(mod.getAutoReconnectAttempt("s1")).toBe(1);
  });

  it("is idempotent — second schedule during pending is a no-op", async () => {
    const mod = await importModule();
    tabsRef.current = [{ sessionId: "s1", status: "disconnected" }];
    expect(mod.scheduleAutoReconnectSsh("s1")).toBe(true);
    expect(mod.scheduleAutoReconnectSsh("s1")).toBe(false);
  });

  it("returns false when setting disabled", async () => {
    settingGetMock.mockReturnValue(false);
    const mod = await importModule();
    tabsRef.current = [{ sessionId: "s1", status: "disconnected" }];
    expect(mod.scheduleAutoReconnectSsh("s1")).toBe(false);
    expect(mod.getAutoReconnectAttempt("s1")).toBe(0);
  });

  it("returns false when tab is no longer in store (user closed)", async () => {
    const mod = await importModule();
    tabsRef.current = [];
    expect(mod.scheduleAutoReconnectSsh("s1")).toBe(false);
    expect(mod.getAutoReconnectAttempt("s1")).toBe(0);
  });

  it("runs reconnect sequence (cleanup + bumpReconnect) after backoff", async () => {
    const mod = await importModule();
    tabsRef.current = [{ sessionId: "s1", status: "disconnected" }];
    mod.scheduleAutoReconnectSsh("s1");
    expect(bumpReconnectMock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(clearTerminalPaneSenderMock).toHaveBeenCalledWith("s1");
    expect(clearPaneBackendPendingMock).toHaveBeenCalledWith("s1");
    expect(disposeSessionBackendMock).toHaveBeenCalledWith("s1");
    expect(setBackendSessionIdMock).toHaveBeenCalledWith("s1", null);
    expect(setStatusMock).toHaveBeenCalledWith("s1", "connecting");
    expect(bumpReconnectMock).toHaveBeenCalledWith("s1");
  });

  it("uses exponential backoff for successive attempts", async () => {
    const mod = await importModule();
    tabsRef.current = [{ sessionId: "s1", status: "disconnected" }];
    mod.scheduleAutoReconnectSsh("s1");
    expect(mod.getAutoReconnectAttempt("s1")).toBe(1);

    vi.advanceTimersByTime(1000);
    // Re-arm as if the next exited event came in (reconnect attempt N failed)
    mod.scheduleAutoReconnectSsh("s1");
    expect(mod.getAutoReconnectAttempt("s1")).toBe(2);
    vi.advanceTimersByTime(2000);
    mod.scheduleAutoReconnectSsh("s1");
    expect(mod.getAutoReconnectAttempt("s1")).toBe(3);
    vi.advanceTimersByTime(4000);
    mod.scheduleAutoReconnectSsh("s1");
    expect(mod.getAutoReconnectAttempt("s1")).toBe(4);
    vi.advanceTimersByTime(8000);
    mod.scheduleAutoReconnectSsh("s1");
    expect(mod.getAutoReconnectAttempt("s1")).toBe(5);
  });

  it("gives up and sets status disconnected after 5 failed attempts", async () => {
    const onGiveUp = vi.fn();
    const mod = await importModule();
    tabsRef.current = [{ sessionId: "s1", status: "disconnected" }];

    mod.scheduleAutoReconnectSsh("s1", { onGiveUp });
    // attempt 1
    vi.advanceTimersByTime(1000);
    mod.scheduleAutoReconnectSsh("s1", { onGiveUp });
    // attempt 2
    vi.advanceTimersByTime(2000);
    mod.scheduleAutoReconnectSsh("s1", { onGiveUp });
    // attempt 3
    vi.advanceTimersByTime(4000);
    mod.scheduleAutoReconnectSsh("s1", { onGiveUp });
    // attempt 4
    vi.advanceTimersByTime(8000);
    mod.scheduleAutoReconnectSsh("s1", { onGiveUp });
    // attempt 5
    vi.advanceTimersByTime(16000);
    mod.scheduleAutoReconnectSsh("s1", { onGiveUp });
    // attempt 6 → exceeds MAX
    vi.advanceTimersByTime(1);

    expect(onGiveUp).toHaveBeenCalledWith(5);
    expect(setStatusMock).toHaveBeenLastCalledWith("s1", "disconnected");
    expect(mod.getAutoReconnectAttempt("s1")).toBe(0);
  });

  it("cancels pending timer without running reconnect", async () => {
    const mod = await importModule();
    tabsRef.current = [{ sessionId: "s1", status: "disconnected" }];
    mod.scheduleAutoReconnectSsh("s1");
    expect(mod.getAutoReconnectAttempt("s1")).toBe(1);

    mod.cancelAutoReconnectSsh("s1");
    expect(mod.getAutoReconnectAttempt("s1")).toBe(0);

    vi.advanceTimersByTime(5000);
    expect(bumpReconnectMock).not.toHaveBeenCalled();
  });

  it("does not run reconnect when session disappears during backoff (user closed tab)", async () => {
    const mod = await importModule();
    tabsRef.current = [{ sessionId: "s1", status: "disconnected" }];
    mod.scheduleAutoReconnectSsh("s1");
    // 用户在 backoff 期间关闭了 tab
    tabsRef.current = [];
    vi.advanceTimersByTime(1000);

    expect(bumpReconnectMock).not.toHaveBeenCalled();
    expect(mod.getAutoReconnectAttempt("s1")).toBe(0);
  });

  it("invokes onScheduled / onAttempt callbacks with attempt number", async () => {
    const onScheduled = vi.fn();
    const onAttempt = vi.fn();
    const mod = await importModule();
    tabsRef.current = [{ sessionId: "s1", status: "disconnected" }];
    mod.scheduleAutoReconnectSsh("s1", { onScheduled, onAttempt });
    expect(onScheduled).toHaveBeenCalledWith(1, 1000, 5);
    vi.advanceTimersByTime(1000);
    expect(onAttempt).toHaveBeenCalledWith(1, 5);
  });
});
