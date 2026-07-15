import { describe, expect, it } from "vitest";
import {
  filterSchemaSyncExecutableTableNames,
  isSchemaSyncTableExecutable,
} from "./schemaSyncAlignedTables";
import type { SyncTableInfo } from "./types";

const targetTables: SyncTableInfo[] = [
  { name: "t_match", columns: [], indexes: [], rowCount: null },
  { name: "t_diff", columns: [], indexes: [], rowCount: null },
];

describe("isSchemaSyncTableExecutable", () => {
  it("skips structure-matched tables", () => {
    expect(
      isSchemaSyncTableExecutable(
        "t_match",
        { t_match: { status: "match" } },
        targetTables,
        true,
        true,
      ),
    ).toBe(false);
  });

  it("allows diff and new tables", () => {
    expect(
      isSchemaSyncTableExecutable(
        "t_diff",
        { t_diff: { status: "diff" } },
        targetTables,
        true,
        true,
      ),
    ).toBe(true);
    expect(
      isSchemaSyncTableExecutable(
        "t_new",
        { t_new: { status: "new" } },
        targetTables,
        true,
        true,
      ),
    ).toBe(true);
  });

  it("respects createMissingTables for absent targets", () => {
    expect(
      isSchemaSyncTableExecutable("t_absent", {}, targetTables, true, false),
    ).toBe(false);
    expect(
      isSchemaSyncTableExecutable("t_absent", {}, targetTables, true, true),
    ).toBe(true);
  });
});

describe("filterSchemaSyncExecutableTableNames", () => {
  it("filters out match tables from batch", () => {
    expect(
      filterSchemaSyncExecutableTableNames(
        ["t_match", "t_diff", "t_absent"],
        {
          t_match: { status: "match" },
          t_diff: { status: "diff" },
        },
        targetTables,
        true,
        false,
      ),
    ).toEqual(["t_diff"]);
  });
});
