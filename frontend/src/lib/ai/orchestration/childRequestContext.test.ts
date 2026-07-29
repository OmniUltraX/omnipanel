import { describe, expect, it } from "vitest";
import { resolveChildContextIds } from "./childContextIds";

describe("resolveChildContextIds", () => {
  it("子会话优先使用自身 workspace / terminal，并继承父 env", () => {
    const ids = resolveChildContextIds({
      parentWorkspaceId: "ws-parent",
      childWorkspaceId: "ws-child",
      childTerminalSessionId: "term-1",
      childAgentId: "run",
      spawnResourceId: null,
      parentResourceId: "res-parent",
      parentEnvTag: "prod",
    });
    expect(ids).toEqual({
      workspaceId: "ws-child",
      terminalSessionId: "term-1",
      resourceId: "res-parent",
      envTag: "prod",
      moduleKeyForAppend: null,
    });
  });

  it("子会话无 workspace 时回落父会话", () => {
    const ids = resolveChildContextIds({
      parentWorkspaceId: "ws-parent",
      childWorkspaceId: null,
      childTerminalSessionId: null,
      childAgentId: "chat",
      spawnResourceId: undefined,
      parentResourceId: null,
      parentEnvTag: "dev",
    });
    expect(ids.workspaceId).toBe("ws-parent");
    expect(ids.terminalSessionId).toBeNull();
    expect(ids.resourceId).toBeNull();
  });

  it("spawn resourceId 优先于父资源", () => {
    const ids = resolveChildContextIds({
      parentWorkspaceId: null,
      childWorkspaceId: null,
      childTerminalSessionId: "t1",
      childAgentId: "terminal",
      spawnResourceId: "ssh-host-2",
      parentResourceId: "ssh-host-1",
      parentEnvTag: null,
    });
    expect(ids.resourceId).toBe("ssh-host-2");
    expect(ids.moduleKeyForAppend).toBeNull();
  });

  it("模块 Agent 需要 module append；terminal Agent 不走 module 通道", () => {
    expect(
      resolveChildContextIds({
        parentWorkspaceId: null,
        childWorkspaceId: null,
        childTerminalSessionId: null,
        childAgentId: "database",
        spawnResourceId: null,
        parentResourceId: null,
        parentEnvTag: null,
      }).moduleKeyForAppend,
    ).toBe("database");

    expect(
      resolveChildContextIds({
        parentWorkspaceId: null,
        childWorkspaceId: null,
        childTerminalSessionId: "t",
        childAgentId: "terminal",
        spawnResourceId: null,
        parentResourceId: null,
        parentEnvTag: null,
      }).moduleKeyForAppend,
    ).toBeNull();
  });
});
