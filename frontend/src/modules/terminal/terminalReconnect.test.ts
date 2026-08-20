import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  clearPaneBackendPendingMock,
  disposeSessionBackendMock,
  clearTerminalPaneSenderMock,
  setBackendSessionIdMock,
  setStatusMock,
  bumpReconnectMock,
} = vi.hoisted(() => ({
  clearPaneBackendPendingMock: vi.fn(),
  disposeSessionBackendMock: vi.fn(),
  clearTerminalPaneSenderMock: vi.fn(),
  setBackendSessionIdMock: vi.fn(),
  setStatusMock: vi.fn(),
  bumpReconnectMock: vi.fn(),
}));

vi.mock("../../hooks/useTerminal", () => ({
  clearPaneBackendPending: clearPaneBackendPendingMock,
  disposeSessionBackend: disposeSessionBackendMock,
}));

vi.mock("../../stores/terminalStore", () => ({
  useTerminalStore: {
    getState: () => ({
      setBackendSessionId: setBackendSessionIdMock,
      setStatus: setStatusMock,
      bumpReconnect: bumpReconnectMock,
    }),
  },
}));

vi.mock("./terminalPaneSenders", () => ({
  clearTerminalPaneSender: clearTerminalPaneSenderMock,
}));

import { reconnectTerminalSession } from "./terminalReconnect";

describe("reconnectTerminalSession", () => {
  beforeEach(() => {
    clearPaneBackendPendingMock.mockClear();
    disposeSessionBackendMock.mockClear();
    clearTerminalPaneSenderMock.mockClear();
    setBackendSessionIdMock.mockClear();
    setStatusMock.mockClear();
    bumpReconnectMock.mockClear();
  });

  it("重建后端会话并保留当前输入模式", () => {
    reconnectTerminalSession("sess-1");

    expect(clearTerminalPaneSenderMock).toHaveBeenCalledWith("sess-1");
    expect(clearPaneBackendPendingMock).toHaveBeenCalledWith("sess-1");
    expect(disposeSessionBackendMock).toHaveBeenCalledWith("sess-1", undefined, {
      preserveInputMode: true,
    });
    expect(setBackendSessionIdMock).toHaveBeenCalledWith("sess-1", null);
    expect(setStatusMock).toHaveBeenCalledWith("sess-1", "connecting");
    expect(bumpReconnectMock).toHaveBeenCalledWith("sess-1");
  });
});
