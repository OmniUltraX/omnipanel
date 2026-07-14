import { describe, expect, it } from "vitest";
import { tryParseLsListing } from "./parseLsListing";

const POWERSHELL_CD_FAILURE = `cd : 找不到路径“C:\\Users\\chaoj\\Downloads\\10229_rev54.json”，因为该路径不存在。
所在位置 行:1 字符: 1
+ cd Downloads/10229_rev54.json
+ ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : ObjectNotFound: (C:\\Users\\chaoj\\Downloads\\10229_rev54.json:String) [Set-Location], ItemNotFoundException
    + FullyQualifiedErrorId : PathNotFound,Microsoft.PowerShell.Commands.SetLocationCommand`;

describe("tryParseLsListing shell errors", () => {
  it("不把 PowerShell cd 失败输出解析为 ls 列表", () => {
    const compound = "cd Downloads/10229_rev54.json; if ($?) { Get-ChildItem }";
    expect(tryParseLsListing(compound, POWERSHELL_CD_FAILURE)).toBeNull();
    expect(tryParseLsListing("cd Downloads/10229_rev54.json", POWERSHELL_CD_FAILURE)).toBeNull();
  });

  it("不把 bash 错误输出解析为 ls 列表", () => {
    const output = "bash: cd: no such file or directory: /missing/path";
    expect(tryParseLsListing("ls", output)).toBeNull();
    expect(tryParseLsListing("cd /missing/path && ls", output)).toBeNull();
  });
});
