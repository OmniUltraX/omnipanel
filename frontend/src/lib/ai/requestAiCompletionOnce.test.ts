import { describe, expect, it, vi, beforeEach } from "vitest";

const runInternalMock = vi.fn();

let canUseIpc = true;

vi.mock("../../stores/aiModelsStore", () => ({
  useAiModelsStore: { getState: () => ({ providers: mockProviders }) },
}));

vi.mock("../terminalScenarioModels", () => ({
  resolveTerminalModelSelectionId: () => "cli:opencode::default",
}));

vi.mock("../isTauriRuntime", () => ({
  canUseAiBackend: () => canUseIpc,
}));

vi.mock("./orchestrator", () => ({
  runInternalAiChat: (...args: unknown[]) => runInternalMock(...args),
}));

vi.mock("./inferenceBackend", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./inferenceBackend")>();
  return {
    ...mod,
    firstCliSelectionId: () => "cli:opencode::default",
    resolveBackendFromSelection: () => ({
      kind: "cli",
      backendId: "cli:opencode::default",
      providerId: "opencode",
      modelId: "default",
    }),
  };
});

let mockProviders = [{ id: "p1" }];

import { requestAiCompletionOnce } from "./requestAiCompletionOnce";

describe("requestAiCompletionOnce 仅走 CLI 内置编排", () => {
  beforeEach(() => {
    runInternalMock.mockReset();
    canUseIpc = true;
    runInternalMock.mockImplementation(
      async (opts: { onEvent: (event: { type: string; text?: string }) => void }) => {
        opts.onEvent({ type: "content_delta", text: "标题" });
      },
    );
  });

  it("有 IPC 时走 runInternalAiChat（CLI）", async () => {
    const ret = await requestAiCompletionOnce({ system: "s", user: "hi" });
    expect(ret).toEqual({ ok: true, content: "标题" });
    expect(runInternalMock).toHaveBeenCalledTimes(1);
    const call = runInternalMock.mock.calls[0]?.[0] as {
      request: { httpProvider: unknown; backendId: string; pureText?: boolean };
    };
    expect(call.request.httpProvider).toBeNull();
    expect(call.request.backendId).toBe("cli:opencode::default");
    expect(call.request.pureText).toBe(true);
  });

  it("无 IPC 时返回 no-provider（不再直连 HTTP）", async () => {
    canUseIpc = false;
    const ret = await requestAiCompletionOnce({ system: "s", user: "hi" });
    expect(ret).toEqual({ ok: false, reason: "no-provider" });
    expect(runInternalMock).not.toHaveBeenCalled();
  });
});
