import { describe, expect, it } from "vitest";
import {
  containsShellHistorySyncNoise,
  stripShellHistorySyncNoise,
} from "./shellHistoryOutputFilter";
import { SHELL_HISTORY_SYNC_COMMAND_POWERSHELL } from "./shellHistorySync";

describe("shellHistoryOutputFilter", () => {
  it("detects PowerShell history sync script", () => {
    expect(containsShellHistorySyncNoise(SHELL_HISTORY_SYNC_COMMAND_POWERSHELL)).toBe(true);
  });

  it("strips sync script and markers from multiline output", () => {
    const noisy = [
      "PS C:\\Users\\chaoj> " + SHELL_HISTORY_SYNC_COMMAND_POWERSHELL,
      "__OMNIPANEL_HIST_BEGIN__",
      "d2lsbA==",
      "__OMNIPANEL_HIST_END__",
      "PS C:\\Users\\chaoj> cd 'C:\\Users\\chaoj'",
    ].join("\r\n");

    const cleaned = stripShellHistorySyncNoise(noisy);
    expect(cleaned).toContain("cd 'C:\\Users\\chaoj'");
    expect(cleaned).not.toContain("__OMNIPANEL_HIST_BEGIN__");
    expect(cleaned).not.toContain("Get-PSReadLineOption");
  });
});
