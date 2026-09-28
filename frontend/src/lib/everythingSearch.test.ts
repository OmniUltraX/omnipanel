import { describe, expect, it } from "vitest";
import { everythingBrowsePath } from "./everythingSearch";

describe("everythingBrowsePath", () => {
  it("目录原样打开，文件打开所在目录", () => {
    expect(everythingBrowsePath("D:\\work\\notes", true)).toBe("D:\\work\\notes");
    expect(everythingBrowsePath("D:\\work\\a.txt", false)).toBe("D:\\work");
    expect(everythingBrowsePath("C:\\a.txt", false)).toBe("C:\\");
    expect(everythingBrowsePath("/home/me/a.txt", false)).toBe("/home/me");
  });
});
