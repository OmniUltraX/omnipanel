import { beforeEach, describe, expect, it, vi } from "vitest";

const endSessionMock = vi.fn();
const closeTabOnlyMock = vi.fn();
const getSessionMock = vi.fn();
const disposeSessionBackendMock = vi.fn();
const startLifecycleMock = vi.fn(() => () => undefined);

vi.mock("../../stores/terminalStore", () => ({
  useTerminalStore: {
    getState: () => ({
      sessions: [
        { id: "s1", lifecycle: "active" },
        { id: "s2", lifecycle: "ended" },
        { id: "s3", lifecycle: "suspended" },
      ],
      tabs: [{ id: "s1", sessionId: "s1", backendSessionId: "pty-1" }],
      detachedRuntime: {},
      getSession: getSessionMock,
      endSession: endSessionMock,
      closeTabOnly: closeTabOnlyMock,
    }),
  },
}));

vi.mock("../../hooks/useTerminal", () => ({
  clearPaneBackendPending: vi.fn(),
  disposeSessionBackend: disposeSessionBackendMock,
}));

vi.mock("./terminalPaneSenders", () => ({
  clearTerminalPaneSender: vi.fn(),
}));

vi.mock("./autoReconnectTerminalSsh", () => ({
  cancelAutoReconnectSsh: vi.fn(),
}));

vi.mock("../../stores/terminalHistoryStore", () => ({
  useTerminalHistoryStore: {
    getState: () => ({
      clearSession: vi.fn(() => Promise.resolve()),
    }),
  },
}));

vi.mock("./terminalBackendLifecycle", () => ({
  clearTerminalBackendSessionTouch: vi.fn(),
  touchTerminalBackendSession: vi.fn(),
  startTerminalBackendLifecycle: startLifecycleMock,
}));

vi.mock("./tmuxPaneSessionIndex", () => ({
  useTmuxPaneSessionIndex: {
    getState: () => ({
      removeBySessionId: vi.fn(),
    }),
  },
}));

describe("terminalSessionService", () => {
  beforeEach(async () => {
    vi.resetModules();
    endSessionMock.mockClear();
    closeTabOnlyMock.mockClear();
    disposeSessionBackendMock.mockClear();
    startLifecycleMock.mockClear();
    getSessionMock.mockImplementation((id: string) => {
      if (id === "s1") return { id: "s1", lifecycle: "active" };
      if (id === "s3") return { id: "s3", lifecycle: "suspended" };
      return undefined;
    });
  });

  it("list 排除已 ended 会话", async () => {
    const { createTerminalSessionService, resetTerminalSessionServiceForTests } =
      await import("./terminalSessionService");
    resetTerminalSessionServiceForTests();
    const svc = createTerminalSessionService();
    expect(svc.list().map((s) => s.id)).toEqual(["s1", "s3"]);
    expect(startLifecycleMock).toHaveBeenCalledTimes(1);
  });

  it("dispose 结束会话并释放后端，onModuleEvicted 不调用 dispose", async () => {
    const { createTerminalSessionService, resetTerminalSessionServiceForTests } =
      await import("./terminalSessionService");
    resetTerminalSessionServiceForTests();
    const svc = createTerminalSessionService();
    await svc.dispose("s1");
    expect(endSessionMock).toHaveBeenCalledWith("s1");
    expect(disposeSessionBackendMock).toHaveBeenCalledWith("s1", "pty-1");

    endSessionMock.mockClear();
    disposeSessionBackendMock.mockClear();
    svc.onModuleEvicted?.();
    expect(endSessionMock).not.toHaveBeenCalled();
    expect(disposeSessionBackendMock).not.toHaveBeenCalled();
  });

  it("detachView 只 closeTabOnly，不 dispose 后端", async () => {
    const { createTerminalSessionService, resetTerminalSessionServiceForTests } =
      await import("./terminalSessionService");
    resetTerminalSessionServiceForTests();
    const svc = createTerminalSessionService();
    svc.detachView("s1");
    expect(closeTabOnlyMock).toHaveBeenCalledWith("s1");
    expect(disposeSessionBackendMock).not.toHaveBeenCalled();
  });

  it("bindView 在无 sink 时缓冲，再 bind 时回放", async () => {
    const { createTerminalSessionService, resetTerminalSessionServiceForTests } =
      await import("./terminalSessionService");
    resetTerminalSessionServiceForTests();
    const svc = createTerminalSessionService();
    // detach 会往 ring 推 unbound
    svc.detachView("s3");

    const events: unknown[] = [];
    const unbind = svc.bindView("s3", {
      push: (e) => {
        events.push(e);
      },
    });
    expect(events.some((e) => (e as { type: string }).type === "unbound")).toBe(
      true,
    );
    expect(events.some((e) => (e as { type: string }).type === "bound")).toBe(
      true,
    );
    unbind();
  });
});
