import { beforeEach, describe, expect, it, vi } from "vitest";

const appConfirm = vi.fn();
const appPrompt = vi.fn();
const showToast = vi.fn();
const presenceStatus = vi.fn();
const presenceVerify = vi.fn();
const presenceIssueTyped = vi.fn();

vi.mock("./appConfirm", () => ({ appConfirm: (...args: unknown[]) => appConfirm(...args) }));
vi.mock("./appPrompt", () => ({ appPrompt: (...args: unknown[]) => appPrompt(...args) }));
vi.mock("../stores/toastStore", () => ({ showToast: (...args: unknown[]) => showToast(...args) }));
vi.mock("../stores/settingsStore", () => ({
  useSettingsStore: { getState: () => ({ osPresenceEnabled: true }) },
}));
vi.mock("../i18n", () => ({
  t: (key: string, params?: { token?: string }) =>
    params?.token ? `${key}:${params.token}` : key,
}));
vi.mock("../ipc/result", () => ({
  unwrapCommand: async <T>(p: Promise<T> | T) => p,
}));
vi.mock("../ipc/bindings", () => ({
  commands: {
    presenceStatus: () => presenceStatus(),
    presenceVerify: (...args: unknown[]) => presenceVerify(...args),
    presenceIssueTyped: (...args: unknown[]) => presenceIssueTyped(...args),
  },
}));

import { requireStepUp } from "./stepUp";

const base = {
  action: "db.service.restart",
  target: "ssh|mysql|host|a",
  title: "重启",
  message: "会断开连接",
  reason: "重启 MySQL",
};

describe("requireStepUp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("cancels on explain dialog", async () => {
    appConfirm.mockResolvedValue(false);
    await expect(requireStepUp(base)).resolves.toBeNull();
    expect(presenceVerify).not.toHaveBeenCalled();
  });

  it("uses OS verify when available", async () => {
    appConfirm.mockResolvedValue(true);
    presenceStatus.mockResolvedValue({ available: true, kind: "hello", osEnabled: true });
    presenceVerify.mockResolvedValue({ token: "tok", expiresAtMs: 1, action: base.action, target: base.target });
    await expect(requireStepUp(base)).resolves.toBe("tok");
    expect(presenceVerify).toHaveBeenCalled();
    expect(appPrompt).not.toHaveBeenCalled();
  });

  it("falls back to typed when OS unavailable", async () => {
    appConfirm.mockResolvedValue(true);
    presenceStatus.mockResolvedValue({ available: false, kind: "none", osEnabled: true });
    appPrompt.mockResolvedValue("RESTART");
    presenceIssueTyped.mockResolvedValue({
      token: "typed",
      expiresAtMs: 1,
      action: base.action,
      target: base.target,
    });
    await expect(requireStepUp(base)).resolves.toBe("typed");
    expect(presenceIssueTyped).toHaveBeenCalledWith(base.action, base.target, "RESTART");
  });

  it("toasts and returns null when typed mismatches", async () => {
    appConfirm.mockResolvedValue(true);
    presenceStatus.mockResolvedValue({ available: false, kind: "none", osEnabled: false });
    appPrompt.mockResolvedValue("nope");
    presenceIssueTyped.mockRejectedValue(new Error("mismatch"));
    await expect(requireStepUp(base)).resolves.toBeNull();
    expect(showToast).toHaveBeenCalled();
  });
});
