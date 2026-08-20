import { describe, expect, it, vi } from "vitest";

vi.mock("../../stores/aiStore", () => ({
  useAiStore: { getState: () => ({ openDrawer: () => undefined }) },
}));
vi.mock("../../lib/ai/submitAiPrompt", () => ({
  submitAiPrompt: vi.fn(),
}));
vi.mock("../../ipc/bindings", () => ({
  commands: { workflowSave: vi.fn() },
}));

import { buildNaturalLanguagePrompt } from "./warpExperience";

describe("buildNaturalLanguagePrompt", () => {
  it("keeps the user query only, without exec orders", () => {
    const prompt = buildNaturalLanguagePrompt("当前的时间", "C:\\Users\\me");
    expect(prompt).toBe("当前的时间");
    expect(prompt).not.toContain("omni_terminal_exec");
    expect(prompt).not.toContain("必须调用");
    expect(prompt).not.toContain("当前目录");
  });

  it("prefixes optional blockContext", () => {
    const prompt = buildNaturalLanguagePrompt("解释", "/tmp", "```\nls\n```");
    expect(prompt.startsWith("```")).toBe(true);
    expect(prompt.endsWith("解释")).toBe(true);
    expect(prompt).not.toContain("必须调用");
  });
});
