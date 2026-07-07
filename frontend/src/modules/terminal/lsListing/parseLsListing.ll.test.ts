import { describe, expect, it } from "vitest";
import { extractCommandOutput } from "../terminalOutputText";
import { tryParseLsListing } from "./parseLsListing";

const SAMPLE = `total 8
drwxr-xr-x  2 user group 4096 Jan  1 12:00 .
drwxr-xr-x  3 user group 4096 Jan  1 11:00 ..
-rw-r--r--  1 user group  123 Jan  1 10:00 README.md
drwxr-xr-x  2 user group 4096 Jan  1 09:00 src`;

const SAMPLE_MAC = `total 8
drwxr-xr-x@ 2 user group 4096 Jan  1 12:00 Applications
-rw-r--r--@ 1 user group  123 Jan  1 10:00 README.md`;

const SAMPLE_ZH = `总用量 68
drwx------ 12 root root 4096 11月 30 16:32 .
drwxr-xr-x 25 root root 4096 3月 7日 15:21 ..
-rw-r--r-- 1 root root 2358 10月 28 17:25 .bashrc
drwxr-xr-x 2 root root 4096 12月 1日 2024 .agents
lrwxrwxrwx 1 root root 7 10月 28 17:25 bin -> usr/bin`;

describe("tryParseLsListing ll", () => {
  it("解析长格式 ll 输出", () => {
    const parsed = tryParseLsListing("ll", SAMPLE);
    expect(parsed?.layout).toBe("long");
    expect(parsed?.entries.length).toBeGreaterThan(2);
  });

  it("extractCommandOutput 后仍可解析", () => {
    const raw = `ll\n${SAMPLE}`;
    const cleaned = extractCommandOutput(raw, "ll");
    const parsed = tryParseLsListing("ll", cleaned);
    expect(parsed?.entries.length).toBeGreaterThan(2);
  });

  it("支持中文 locale 总用量与日期", () => {
    const parsed = tryParseLsListing("ll", SAMPLE_ZH);
    expect(parsed?.layout).toBe("long");
    expect(parsed?.entries.some((e) => e.name === ".bashrc")).toBe(true);
    expect(parsed?.entries.some((e) => e.name === "bin")).toBe(true);
  });

  it("尾部 shell 提示符不导致整段解析失败", () => {
    const raw = `${SAMPLE_ZH}\nroot@vm-0-16-ubuntu:/#`;
    const cleaned = extractCommandOutput(`ll\n${raw}`, "ll");
    const parsed = tryParseLsListing("ll", cleaned);
    expect(parsed?.entries.length).toBeGreaterThan(2);

    const parsedRaw = tryParseLsListing("ll", raw);
    expect(parsedRaw?.entries.length).toBeGreaterThan(2);
  });
});
