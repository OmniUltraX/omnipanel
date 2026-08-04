import { describe, expect, it } from "vitest";
import { tryParseLsListing } from "./parseLsListing";

describe("tryParseLsListing 空目录命令回显", () => {
  it("不把单独的 ls 回显解析成目录项", () => {
    expect(tryParseLsListing("ls", "ls")).toBeNull();
    expect(tryParseLsListing("ls", "ls/")).toBeNull();
    expect(tryParseLsListing("ls -F", "ls")).toBeNull();
  });

  it("cd && ls 空输出不产生伪目录", () => {
    expect(tryParseLsListing("cd ~ && ls -A --group-directories-first", "ls")).toBeNull();
    expect(tryParseLsListing("cd /tmp && ls", "ls/")).toBeNull();
  });

  it("真实单文件目录仍可解析", () => {
    const parsed = tryParseLsListing("ls", "README.md");
    expect(parsed?.entries).toHaveLength(1);
    expect(parsed?.entries[0]?.name).toBe("README.md");
  });
});
