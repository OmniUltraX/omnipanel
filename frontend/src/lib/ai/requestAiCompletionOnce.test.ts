import { describe, expect, it, vi, beforeEach } from "vitest";

const runInternalMock = vi.fn();

const { canUseIpc } = vi.hoisted(() => ({
  canUseIpc: { value: true },
}));

vi.mock("../../stores/aiModelsStore", () => ({
  useAiModelsStore: { getState: () => ({ providers: [{ id: "p1" }] }) },
}));

vi.mock("../terminalScenarioModels", () => ({
  resolveTerminalModelSelectionId: () => "opencode:opencode/default",
}));

vi.mock("../isTauriRuntime", () => ({
  canUseAiBackend: () => canUseIpc.value,
}));

vi.mock("./orchestrator", () => ({
  runInternalAiChat: (...args: unknown[]) => runInternalMock(...args),
}));

vi.mock("./inferenceBackend", () => ({
  firstCliSelectionId: () => "opencode:opencode/default",
  resolveBackendFromSelection: () => ({
    kind: "opencode",
    backendId: "opencode:opencode/default",
    providerId: "opencode",
    modelId: "default",
  }),
}));

import { requestAiCompletionOnce } from "./requestAiCompletionOnce";

describe("requestAiCompletionOnce 仅走内置编排", () => {
  beforeEach(() => {
    runInternalMock.mockReset();
    canUseIpc.value = true;
    runInternalMock.mockImplementation(
      async (opts: { onEvent: (event: { type: string; text?: string }) => void }) => {
        opts.onEvent({ type: "content_delta", text: "标题" });
      },
    );
  });

  it("有 IPC 时走 runInternalAiChat", async () => {
    const ret = await requestAiCompletionOnce({ system: "s", user: "hi" });
    expect(ret).toEqual({ ok: true, content: "标题" });
    expect(runInternalMock).toHaveBeenCalledTimes(1);
    const call = runInternalMock.mock.calls[0]?.[0] as {
      request: { httpProvider: unknown; backendId: string; pureText?: boolean };
    };
    expect(call.request.httpProvider).toBeNull();
    expect(call.request.backendId).toBe("opencode:opencode/default");
    expect(call.request.pureText).toBe(true);
  });

  it("无 IPC 时返回 no-provider（不再直连 HTTP）", async () => {
    canUseIpc.value = false;
    const ret = await requestAiCompletionOnce({ system: "s", user: "hi" });
    expect(ret).toEqual({ ok: false, reason: "no-provider" });
    expect(runInternalMock).not.toHaveBeenCalled();
  });
});
