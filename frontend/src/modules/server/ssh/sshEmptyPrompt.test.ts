import { describe, expect, it } from "vitest";

import { sshEmptyPromptKey } from "./sshEmptyPrompt";

describe("sshEmptyPromptKey", () => {
  it("keeps the no-connection copy only when the list is empty", () => {
    expect(sshEmptyPromptKey(false)).toBe("ssh.empty.selectHost");
  });

  it("asks the user to pick a host when connections already exist", () => {
    expect(sshEmptyPromptKey(true)).toBe("ssh.empty.chooseHost");
  });
});
