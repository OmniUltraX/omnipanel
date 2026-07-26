import { describe, expect, it } from "vitest";
import { resolveAgentId, resolveAgentRuntime } from "./resolveAgentRuntime";

describe("resolveAgentRuntime", () => {
  it("助手页强制 chat 且无工具", () => {
    const runtime = resolveAgentRuntime({
      assistantPage: true,
      moduleKey: "terminal",
      conversationAgentId: "database",
    });
    expect(runtime.agentId).toBe("chat");
    expect(runtime.toolsMode).toBe("none");
  });

  it("模块场景绑定对应 Agent 与 moduleFilter", () => {
    const runtime = resolveAgentRuntime({
      assistantPage: false,
      moduleKey: "docker",
    });
    expect(runtime.agentId).toBe("docker");
    expect(runtime.toolsMode).toEqual({
      directInject: { moduleFilter: "docker" },
    });
  });

  it("SSH 模块路由映射到终端 Agent", () => {
    const runtime = resolveAgentRuntime({
      assistantPage: false,
      moduleKey: "ssh",
    });
    expect(runtime.agentId).toBe("terminal");
    expect(runtime.toolsMode).toEqual({
      directInject: { moduleFilter: "terminal" },
    });
  });

  it("会话已绑定 agentId 时保持一致", () => {
    expect(
      resolveAgentId({
        assistantPage: false,
        conversationAgentId: "knowledge",
        moduleKey: "terminal",
      }),
    ).toBe("knowledge");
  });
});
