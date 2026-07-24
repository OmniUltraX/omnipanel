import { describe, expect, it } from "vitest";
import { isDefaultSessionTitle } from "./sessionAutoNameGuards";
import type { TerminalSession } from "../../stores/terminalStore";

function session(
  title: string,
  opts?: { resourceId?: string; shellLabel?: string; type?: "local" | "remote" },
): Pick<TerminalSession, "title" | "session"> {
  return {
    title,
    session: {
      type: opts?.type ?? "local",
      resourceId: opts?.resourceId ?? "local-terminal",
      shellLabel: opts?.shellLabel ?? "PowerShell",
      cwd: "~",
      purpose: "test",
      commandPack: [],
    },
  };
}

describe("isDefaultSessionTitle", () => {
  it("recognizes builtin local titles", () => {
    expect(isDefaultSessionTitle(session("本地终端"))).toBe(true);
    expect(isDefaultSessionTitle(session("Local Terminal"))).toBe(true);
    expect(isDefaultSessionTitle(session(""))).toBe(true);
  });

  it("recognizes shell labels as default titles", () => {
    expect(isDefaultSessionTitle(session("PowerShell"))).toBe(true);
    expect(isDefaultSessionTitle(session("bash"))).toBe(true);
    expect(isDefaultSessionTitle(session("SSH", { type: "remote", shellLabel: "SSH" }))).toBe(
      true,
    );
  });

  it("recognizes user@host SSH defaults", () => {
    expect(
      isDefaultSessionTitle(
        session("deploy@192.168.1.1", {
          type: "remote",
          resourceId: "host-1",
          shellLabel: "SSH",
        }),
      ),
    ).toBe(true);
  });

  it("rejects clearly custom titles", () => {
    expect(isDefaultSessionTitle(session("排查代理端口"))).toBe(false);
    expect(isDefaultSessionTitle(session("deploy docker"))).toBe(false);
  });
});
