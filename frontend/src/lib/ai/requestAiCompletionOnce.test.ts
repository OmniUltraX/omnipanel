import { describe, expect, it, vi, beforeEach } from "vitest";

const fetchMock = vi.fn();
const runInternalMock = vi.fn();

vi.mock("../fetchHeaders", () => ({
  withOptionalBearerAuth: (headers: Record<string, string>) => headers,
  fetchWithNetworkHint: (...args: unknown[]) => fetchMock(...args),
}));

vi.mock("../../stores/aiModelsStore", () => ({
  useAiModelsStore: { getState: () => ({ providers: mockProviders }) },
  firstModelSelectionId: () => "p1::m1",
  resolveModelSelection: () => ({ baseUrl: "https://api.example.com", apiKey: "", name: "m1" }),
  resolveProviderApiKey: vi.fn(async () => "vault-key-123"),
}));

vi.mock("../terminalScenarioModels", () => ({
  resolveTerminalModelSelectionId: () => null,
}));

vi.mock("../isTauriRuntime", () => ({
  canUseAiBackend: () => true,
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

describe("requestAiCompletionOnce Vault key", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    runInternalMock.mockReset();
    fetchMock.mockResolvedValue(okJson("译文"));
  });

  it("内存无明文时经 Vault 取回 key 再前端直连", async () => {
    const ret = await requestAiCompletionOnce({ system: "s", user: "hi" });
    expect(ret).toEqual({ ok: true, content: "译文" });
    expect(runInternalMock).not.toHaveBeenCalled();
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(init.body).model).toBe("m1");
  });

  it("Vault 也取不到时降级走 Rust 内后端", async () => {
    const store = await import("../../stores/aiModelsStore");
    vi.mocked(store.resolveProviderApiKey).mockResolvedValueOnce("");
    await requestAiCompletionOnce({ system: "s", user: "hi" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(runInternalMock).toHaveBeenCalledTimes(1);
  });
});
