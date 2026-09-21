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
  it("只输出已启用且已安装的提供者模型", () => {
    const options = buildCliOptionsFromProviders(
      [
        cliProvider({
          id: "opencode",
          displayName: "OpenCode",
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
      { opencode: ["opencode/big-pickle", "opencode-go/kimi-k3"] },
    );

    expect(options.map((o) => o.value)).toEqual([
      "cli:opencode::opencode/big-pickle",
      "cli:opencode::opencode-go/kimi-k3",
    ]);
    expect(options.every((o) => o.group === "cli")).toBe(true);
  });

  it("无模型缓存时回退 default", () => {
    const options = buildCliOptionsFromProviders(
      [cliProvider({ id: "opencode", displayName: "OpenCode" })],
      {},
    );
    expect(options).toEqual([
      expect.objectContaining({
        value: "cli:opencode::default",
        label: "OpenCode/default",
      }),
    ]);
  });

  it("跳过 disabledModelNames", () => {
    const options = buildCliOptionsFromProviders(
      [
        cliProvider({
          id: "opencode",
          displayName: "OpenCode",
          disabledModelNames: ["skip-me"],
        }),
      ],
      { opencode: ["keep-me", "skip-me"] },
    );
    expect(options.map((o) => o.value)).toEqual(["cli:opencode::keep-me"]);
  });
});

describe("buildBackendSelectOptions", () => {
  it("store 智能体优先，API 仅补缺", () => {
    const api: BackendInfo[] = [
      {
        id: "cli:opencode::from-api",
        label: "OpenCode/from-api",
        kind: "cli",
        installed: true,
      },
      {
        id: "cli:opencode::shared",
        label: "OpenCode/shared",
        kind: "cli",
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
        }),
      ],
      { opencode: ["shared", "from-store"] },
    );

    const cli = options.filter((o) => o.group === "cli");
    expect(cli.map((o) => o.value)).toEqual([
      "cli:opencode::shared",
      "cli:opencode::from-store",
      "cli:opencode::from-api",
    ]);
  });
});
