import { describe, expect, it } from "vitest";
import { resolveAgentId, resolveAgentRuntime } from "./resolveAgentRuntime";

describe("resolveAgentRuntime", () => {
  it("助手页默认 run 并注入 master 工具模块", () => {
    const runtime = resolveAgentRuntime({
      assistantPage: true,
      moduleKey: "terminal",
      conversationAgentId: "database",
    });
    expect(runtime.agentId).toBe("run");
    expect(runtime.toolsMode).toEqual({
      directInject: { moduleFilter: "master" },
    });
  });

  it("助手页会话绑定 plan 时保持规划模式", () => {
    const runtime = resolveAgentRuntime({
      assistantPage: true,
      conversationAgentId: "plan",
      moduleKey: "terminal",
    });
    expect(runtime.agentId).toBe("plan");
    expect(runtime.toolsMode).toEqual({
      directInject: { moduleFilter: "web" },
    });
  });

  it("助手页会话绑定 run 时使用全部工具", () => {
    const runtime = resolveAgentRuntime({
      assistantPage: true,
      conversationAgentId: "run",
      moduleKey: "terminal",
    });
    expect(runtime.agentId).toBe("run");
    expect(runtime.toolsMode).toEqual({
      directInject: { moduleFilter: "master" },
    });
  });

  it("历史 chat agentId 映射为 plan", () => {
    expect(
      resolveAgentId({
        assistantPage: false,
        conversationAgentId: "chat",
        moduleKey: "terminal",
      }),
    ).toBe("plan");
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
