import { describe, expect, it } from "vitest";
import { tryParseLsListing } from "./parseLsListing";

describe("tryParseLsListing conda/venv prompt noise", () => {
  it("忽略混进 ls 网格输出的 (base) 环境提示符", () => {
    const output = [
      "TencentCloud",
      "logs",
      "miniconda3",
      "tmp",
      "(base)",
    ].join("  ");

    const parsed = tryParseLsListing("ls", output);
    expect(parsed).not.toBeNull();
    expect(parsed?.entries.some((e) => normalizeName(e.name) === "base")).toBe(false);
    expect(parsed?.entries.some((e) => e.name.includes("base"))).toBe(false);
    expect(parsed?.entries.some((e) => e.name === "tmp" && e.kind === "directory")).toBe(true);
  });

  it("忽略 (.venv) / (my-env) 等常见虚拟环境提示符", () => {
    const output = "src  package.json  (.venv)  (my-env)";
    const parsed = tryParseLsListing("ls", output);
    expect(parsed).not.toBeNull();
    const names = parsed!.entries.map((e) => e.name);
    expect(names).toContain("src");
    expect(names).toContain("package.json");
    expect(names.some((n) => n.includes("venv") || n.includes("my-env"))).toBe(false);
  });
});

function normalizeName(name: string): string {
  return name.replace(/^\(|\)$/g, "").replace(/\/+$/, "");
}
