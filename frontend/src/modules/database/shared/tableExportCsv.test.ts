import { describe, expect, it } from "vitest";
import { buildTableExportCsv, takeExportPreviewLines } from "./tableExportCsv";

const columns = ["id", "name"];
const rows = [
  { id: 1, name: "a" },
  { id: 2, name: "b" },
];

describe("buildTableExportCsv", () => {
  it("默认不带表头，仅输出数据行", () => {
    const csv = buildTableExportCsv(columns, rows, {
      includeColumnHeaders: false,
      bom: false,
      newline: "\n",
    });
    expect(csv).toBe("1,a\n2,b\n");
  });

  it("可添加列标题", () => {
    const csv = buildTableExportCsv(columns, rows, {
      includeColumnHeaders: true,
      bom: false,
      newline: "\n",
    });
    expect(csv).toBe("id,name\n1,a\n2,b\n");
  });

  it("可添加行标题", () => {
    const csv = buildTableExportCsv(columns, rows, {
      includeColumnHeaders: true,
      includeRowHeaders: true,
      bom: false,
      newline: "\n",
    });
    expect(csv).toBe(",id,name\n1,1,a\n2,2,b\n");
  });

  it("支持转置", () => {
    const csv = buildTableExportCsv(columns, rows, {
      transpose: true,
      includeColumnHeaders: false,
      includeRowHeaders: true,
      bom: false,
      newline: "\n",
    });
    expect(csv).toBe("id,1,2\nname,a,b\n");
  });
});

describe("takeExportPreviewLines", () => {
  it("截取前 N 行并去掉 BOM", () => {
    const text = "\uFEFF" + ["a", "b", "c", "d"].join("\n") + "\n";
    expect(takeExportPreviewLines(text, 2)).toBe("a\nb");
  });
});
