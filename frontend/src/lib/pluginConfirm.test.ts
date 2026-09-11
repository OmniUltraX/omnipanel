import { beforeEach, describe, expect, it, vi } from "vitest";

const requireStepUp = vi.fn();
const pluginConfirmResolve = vi.fn();

vi.mock("./stepUp", () => ({
  requireStepUp: (...args: unknown[]) => requireStepUp(...args),
}));
vi.mock("../i18n", () => ({
  t: (key: string) => key,
}));
vi.mock("../ipc/result", () => ({
  unwrapCommand: async <T>(p: Promise<T> | T) => p,
}));
vi.mock("../ipc/bindings", () => ({
  commands: {
    pluginConfirmResolve: (...args: unknown[]) => pluginConfirmResolve(...args),
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

import { handlePluginConfirmRequest } from "./pluginConfirm";

const payload = {
  requestId: "r1",
  pluginId: "omni.sample.overlay",
  action: "net/fetch",
  target: "https://prod.example.com",
};

describe("handlePluginConfirmRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pluginConfirmResolve.mockResolvedValue(null);
  });

  it("取消时 resolve false", async () => {
    requireStepUp.mockResolvedValue(null);
    await handlePluginConfirmRequest(payload);
    expect(pluginConfirmResolve).toHaveBeenCalledWith("r1", false, null);
  });

  it("stepUp 抛错仍 resolve false", async () => {
    requireStepUp.mockRejectedValue(new Error("boom"));
    await handlePluginConfirmRequest(payload);
    expect(pluginConfirmResolve).toHaveBeenCalledWith("r1", false, null);
  });

  it("同意时带 token", async () => {
    requireStepUp.mockResolvedValue("tok");
    await handlePluginConfirmRequest(payload);
    expect(pluginConfirmResolve).toHaveBeenCalledWith("r1", true, "tok");
  });
});
