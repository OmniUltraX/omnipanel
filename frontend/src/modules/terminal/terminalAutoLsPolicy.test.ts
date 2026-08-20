import { describe, expect, it } from "vitest";
import { buildCdWithAutoLs, isCdOnlyCommand } from "./terminalAutoLsPolicy";
import { joinCdWithListCommand } from "./terminalAutoLsShell";

describe("buildCdWithAutoLs", () => {
  it("PowerShell 用 ; if ($?) 拼接 ls", () => {
    expect(buildCdWithAutoLs("cd 'C:\\Users\\chaoj\\dev'", "ls", "powershell")).toBe(
      "cd 'C:\\Users\\chaoj\\dev'; if ($?) { ls }",
    );
  });

  it("posix 用 && 拼接", () => {
    expect(buildCdWithAutoLs("cd /tmp", "ls", "posix")).toBe("cd /tmp && ls");
  });

  it("非纯 cd 不拼接", () => {
    expect(buildCdWithAutoLs("cd /tmp && echo x", "ls", "posix")).toBe("cd /tmp && echo x");
  });
});

describe("joinCdWithListCommand", () => {
  it("cmd 用 && dir", () => {
    expect(joinCdWithListCommand("cd C:\\Windows", "dir", "cmd")).toBe("cd C:\\Windows && dir");
  });
});

describe("isCdOnlyCommand", () => {
  it("识别单独 cd", () => {
    expect(isCdOnlyCommand("cd 'C:\\Users\\chaoj'")).toBe(true);
    expect(isCdOnlyCommand("ls")).toBe(false);
  });
});
