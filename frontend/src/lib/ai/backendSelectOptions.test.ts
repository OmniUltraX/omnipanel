import { describe, expect, it } from "vitest";

import type { BackendInfo, CliProviderRecord } from "../../ipc/bindings";
import {
  buildBackendSelectOptions,
  buildCliOptionsFromProviders,
} from "./backendSelectOptions";

function cliProvider(partial: Partial<CliProviderRecord> & Pick<CliProviderRecord, "id">): CliProviderRecord {
  return {
    id: partial.id,
    displayName: partial.displayName ?? partial.id,
    protocol: partial.protocol ?? "acp",
    binary: partial.binary ?? "opencode",
    args: partial.args ?? ["acp"],
    env: partial.env ?? {},
    cwd: partial.cwd ?? null,
    timeoutSecs: partial.timeoutSecs ?? 300,
    enabled: partial.enabled ?? true,
    builtin: partial.builtin ?? true,
    staticModels: partial.staticModels ?? [],
    manualModelNames: partial.manualModelNames ?? [],
    disabledModelNames: partial.disabledModelNames ?? [],
    modelDiscoveryCommand: partial.modelDiscoveryCommand ?? null,
    modelDiscoveryArgs: partial.modelDiscoveryArgs ?? [],
  };
}

describe("buildCliOptionsFromProviders", () => {
  it("OpenCode 显示友好名称，value 仍为 opencode:id", () => {
    const options = buildCliOptionsFromProviders(
      [
        cliProvider({
          id: "opencode",
          displayName: "OpenCode",
          protocol: "http",
          enabled: true,
          binary: "C:/nvm4w/nodejs/opencode.cmd",
        }),
        cliProvider({
          id: "cursor",
          displayName: "Cursor",
          enabled: false,
          binary: "agent.cmd",
        }),
      ],
      {
        opencode: [
          "opencode/big-pickle\u001fBig Pickle",
          "opencode-go/kimi-k3\u001fKimi K3",
        ],
      },
    );

    expect(options.map((o) => o.value)).toEqual([
      "opencode:opencode/big-pickle",
      "opencode:opencode-go/kimi-k3",
    ]);
    expect(options.map((o) => o.label)).toEqual(["Big Pickle", "Kimi K3"]);
    expect(options.every((o) => o.group === "opencode")).toBe(true);
  });

  it("无模型缓存时回退 default", () => {
    const options = buildCliOptionsFromProviders(
      [cliProvider({ id: "opencode", displayName: "OpenCode", protocol: "http" })],
      {},
    );
    expect(options).toEqual([
      expect.objectContaining({
        value: "opencode:opencode/default",
        label: "default",
      }),
    ]);
  });

  it("跳过 disabledModelNames", () => {
    const options = buildCliOptionsFromProviders(
      [
        cliProvider({
          id: "cursor",
          displayName: "Cursor",
          disabledModelNames: ["skip-me"],
        }),
      ],
      { cursor: ["keep-me", "skip-me"] },
    );
    expect(options.map((o) => o.value)).toEqual(["cli:cursor::keep-me"]);
  });
});

describe("buildBackendSelectOptions", () => {
  it("store 智能体优先，API 仅补缺", () => {
    const api: BackendInfo[] = [
      {
        id: "opencode:opencode/from-api",
        label: "From API",
        kind: "opencode",
        installed: true,
      },
      {
        id: "opencode:opencode/shared",
        label: "Shared",
        kind: "opencode",
        installed: true,
      },
    ];
    const options = buildBackendSelectOptions(
      [],
      api,
      [
        cliProvider({
          id: "opencode",
          displayName: "OpenCode",
          protocol: "http",
        }),
      ],
      {
        opencode: [
          "opencode/shared\u001fShared Name",
          "opencode/from-store\u001fFrom Store",
        ],
      },
    );

    expect(options.map((o) => o.value)).toEqual([
      "opencode:opencode/shared",
      "opencode:opencode/from-store",
      "opencode:opencode/from-api",
    ]);
    expect(options.map((o) => o.label)).toEqual(["Shared Name", "From Store", "From API"]);
  });
});
