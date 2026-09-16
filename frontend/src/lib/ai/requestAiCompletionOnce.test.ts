import { describe, expect, it, vi, beforeEach } from "vitest";

const fetchMock = vi.fn();
const runInternalMock = vi.fn();

let canUseIpc = true;
let mockSelection = { baseUrl: "https://api.example.com", apiKey: "", name: "m1" };

vi.mock("../fetchHeaders", () => ({
  withOptionalBearerAuth: (headers: Record<string, string>) => headers,
  fetchWithNetworkHint: (...args: unknown[]) => fetchMock(...args),
}));

vi.mock("../../stores/aiModelsStore", () => ({
  useAiModelsStore: { getState: () => ({ providers: mockProviders }) },
  firstModelSelectionId: () => "p1::m1",
  resolveModelSelection: () => mockSelection,
}));

vi.mock("../terminalScenarioModels", () => ({
  resolveTerminalModelSelectionId: () => null,
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
    resolveBackendFromSelection: () => ({
      kind: "http",
      backendId: "http:p1::m1",
      httpProvider: {
        providerId: "p1",
        apiStandard: "openai",
        baseUrl: "https://api.example.com",
        apiKey: "",
      },
    }),
  };
});

let mockProviders = [{ id: "p1" }];

import { requestAiCompletionOnce } from "./requestAiCompletionOnce";

function okJson(content: string) {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  };
}

describe("requestAiCompletionOnce 优先内置编排", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    runInternalMock.mockReset();
    canUseIpc = true;
    mockSelection = { baseUrl: "https://api.example.com", apiKey: "memory-key", name: "m1" };
    runInternalMock.mockImplementation(
      async (opts: { onEvent: (event: { type: string; text?: string }) => void }) => {
        opts.onEvent({ type: "content_delta", text: "标题" });
      },
    );
  });

  it("有 IPC 时即使内存有 API key 也走 runInternalAiChat", async () => {
    const ret = await requestAiCompletionOnce({ system: "s", user: "hi" });
    expect(ret).toEqual({ ok: true, content: "标题" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(runInternalMock).toHaveBeenCalledTimes(1);
  });

  it("无 IPC 且有明文 key 时才前端直连 HTTP", async () => {
    canUseIpc = false;
    fetchMock.mockResolvedValue(okJson("译文"));
    const ret = await requestAiCompletionOnce({ system: "s", user: "hi" });
    expect(ret).toEqual({ ok: true, content: "译文" });
    expect(runInternalMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
