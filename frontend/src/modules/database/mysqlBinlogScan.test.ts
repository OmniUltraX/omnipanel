import { describe, expect, it } from "vitest";
import {
  formatMy2sqlFailure,
  mergeTimelineEvents,
  parseMy2sqlExtraInfoOutput,
  parseMy2sqlProbe,
  summarizeMy2sqlLog,
} from "./mysqlBinlog";

describe("parseMy2sqlProbe", () => {
  it("reads the latest progress line while my2sql is still running", () => {
    const parsed = parseMy2sqlProbe(
      "OMNI_RUNNING\n[info] start\n[info] parsed 12000 events\n",
    );
    expect(parsed).toEqual({
      state: "running",
      detail: "[info] parsed 12000 events",
    });
  });

  it("reads sql already written while the scan is still running", () => {
    const parsed = parseMy2sqlProbe(
      "OMNI_RUNNING\nOMNI_PARTIAL\n# datetime=2026-09-17_18:19:26 database=teacher-chat table=reading_screen_link binlog=binlog.000213 startpos=337 stoppos=1041\nUPDATE t SET a=1;\n",
    );
    expect(parsed).toEqual({
      state: "partial",
      sql: "# datetime=2026-09-17_18:19:26 database=teacher-chat table=reading_screen_link binlog=binlog.000213 startpos=337 stoppos=1041\nUPDATE t SET a=1;\n",
    });
  });

  it("returns sql after the done marker and treats an empty window as no sql", () => {
    expect(parseMy2sqlProbe("OMNI_DONE 0\nOMNI_SQL\nINSERT INTO t VALUES (1);\n")).toEqual({
      state: "done",
      exitCode: 0,
      sql: "INSERT INTO t VALUES (1);\n",
      log: "",
    });
    expect(parseMy2sqlProbe("OMNI_DONE 0\nOMNI_EMPTY\n----- my2sql log -----\n")).toEqual({
      state: "done",
      exitCode: 0,
      sql: "",
      log: "OMNI_EMPTY\n----- my2sql log -----\n",
    });
  });

  it("shows the mysql connect error without probe markers", () => {
    const raw = [
      "OMNI_EMPTY",
      "----- my2sql log -----",
      "[2026/09/22 16:58:21] [fatal] context.go:565 Connect mysql failed Error 1045: Access denied for user 'root'@'172.18.0.1' (using password: NO)",
      "----- output dir -----",
      "total 18",
      "drwxr-xr-x 2 root root 7 Sep 22 16:58 .",
    ].join("\n");
    expect(formatMy2sqlFailure(raw)).toBe(
      "Connect mysql failed Error 1045: Access denied for user 'root'@'172.18.0.1' (using password: NO)",
    );
  });

  it("summarizes a log tail without the probe marker", () => {
    expect(summarizeMy2sqlLog("OMNI_RUNNING\n  line a  \nline b")).toBe("line b");
  });
});

describe("mergeTimelineEvents", () => {
  const sql = (time: string, start: number, stop: number) =>
    `# datetime=${time} database=english-study table=teacher binlog=binlog.000213 startpos=${start} stoppos=${stop}\nUPDATE teacher SET a=1;\n`;

  it("keeps earlier events when a later slice only has newer rows, and ids stay stable", () => {
    const older = parseMy2sqlExtraInfoOutput(sql("2026-09-17_18:19:26", 337, 1041));
    const newer = parseMy2sqlExtraInfoOutput(
      `${sql("2026-09-17_18:19:26", 337, 1041)}${sql("2026-09-22_16:01:02", 9000, 9400)}`,
    );
    const merged = mergeTimelineEvents(older, newer);

    expect(older[0]?.id).toBe(newer[0]?.id);
    expect(merged.map((ev) => ev.startPos)).toEqual([9000, 337]);
    expect(merged[1]?.id).toBe(older[0]?.id);
  });
});
