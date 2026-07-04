import { describe, expect, it } from "vitest";

import { markShellPromptReady, waitForShellPrompt } from "./terminalShellRecovery";

describe("terminalShellRecovery", () => {
  it("waitForShellPrompt resolves after markShellPromptReady", async () => {
    markShellPromptReady("test-session-prompt");
    await expect(waitForShellPrompt("test-session-prompt", 500)).resolves.toBe(true);
  });
});
