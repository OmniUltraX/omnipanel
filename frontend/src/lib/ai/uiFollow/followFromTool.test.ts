import { describe, expect, it } from "vitest";
import { followIntentsForTool } from "./followFromTool";

describe("followIntentsForTool 终端", () => {
  it("本地命令跟随到刚执行的终端会话", () => {
    const intents = followIntentsForTool(
      "omni_terminal_exec",
      { command: "Get-Date" },
      JSON.stringify({ terminalSessionId: "tsess-1", output: "ok" }),
    );
    expect(intents).toEqual([{ type: "revealTerminal", sessionId: "tsess-1" }]);
  });

  it("SSH 命令在终端里执行后跟随该终端，而不是 SSH 管理页", () => {
    const intents = followIntentsForTool(
      "omni_ssh_exec",
      { resource_id: "host-1", command: "date" },
      JSON.stringify({ terminalSessionId: "tsess-ssh" }),
    );
    expect(intents).toEqual([{ type: "revealTerminal", sessionId: "tsess-ssh" }]);
  });

  it("SSH 命令没有终端会话时仍打开连接", () => {
    const intents = followIntentsForTool("omni_ssh_exec", {
      resource_id: "host-1",
      command: "date",
    });
    expect(intents[0]).toEqual({ type: "focusModule", module: "ssh" });
    expect(intents.some((intent) => intent.type === "openConnection")).toBe(true);
  });
});
