import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import type { DbConnectionConfig } from "../../api";
import { splitSqlStatements } from "../../sqlIntel/sqlLex";
import { sqlStatementFingerprint } from "../../sqlIntel/sqlStatementTargets";
import { createSqlExecTargetChips } from "./sqlExecTargetChips";

const connection = {
  id: "conn-a",
  name: "cs-dm",
  db_type: "mysql",
  host: "127.0.0.1",
  port: 3306,
  user: "root",
  password: "",
  database: "mkdept",
  ssl: false,
  group: "",
  status: "ok",
  enabled: true,
} satisfies DbConnectionConfig;

function mount(sql: string): EditorView {
  return new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: sql,
      extensions: [
        createSqlExecTargetChips({
          getInitial: () => [
            {
              fingerprint: sqlStatementFingerprint("SELECT 1"),
              targets: [{ connId: "conn-a", database: "mkdept" }],
            },
          ],
          onChange: () => {},
          getConnections: () => [connection],
          getDatabases: () => ["mkdept"],
          getFileTarget: () => ({ connId: "conn-a", database: "mkdept" }),
        }),
      ],
    }),
  });
}

const nestedSql = [
  "SELECT *",
  "FROM `sys_menu` m",
  "LEFT JOIN (",
  "    SELECT * FROM ca_school",
  ") t on 1=1",
  "LIMIT 10;",
].join("\n");

function mountNested(): EditorView {
  const part = splitSqlStatements(nestedSql)[0]!;
  return new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: nestedSql,
      selection: { anchor: nestedSql.indexOf("ca_school") },
      extensions: [
        createSqlExecTargetChips({
          getInitial: () => [
            {
              fingerprint: sqlStatementFingerprint(part.sql),
              targets: [
                { connId: "conn-a", database: "mkdept" },
                { connId: "conn-a", database: "mkdeptdvs" },
              ],
            },
          ],
          onChange: () => {},
          getConnections: () => [connection],
          getDatabases: () => ["mkdept", "mkdeptdvs"],
          getFileTarget: () => ({ connId: "conn-a", database: "mkdept" }),
        }),
      ],
    }),
  });
}

describe("sqlExecTargetChips", () => {
  it("光标从子查询移到外层语句后，芯片高亮并带加号", () => {
    const view = mountNested();
    const before = view.dom.querySelector(".cm-sql-exec-lens");
    expect(before?.className ?? "").not.toContain("is-active");
    expect(before?.querySelector(".cm-sql-exec-target-add")).toBeNull();
    view.dispatch({ selection: { anchor: nestedSql.indexOf("FROM") } });
    const lens = view.dom.querySelector(".cm-sql-exec-lens");
    expect(lens?.className).toContain("is-active");
    expect(lens?.querySelector(".cm-sql-exec-target-add")).not.toBeNull();
    view.destroy();
  });

  it("改过的语句用占行装饰挂在状态上，更新时不把编辑器打崩", () => {
    const view = mount("SELECT 1;\nSELECT 2;");
    expect(view.dom.querySelector(".cm-sql-exec-lens")).not.toBeNull();
    view.dispatch({
      selection: { anchor: view.state.doc.line(1).from },
    });
    view.dispatch({
      changes: { from: 0, to: 0, insert: " " },
    });
    expect(view.dom.querySelector(".cm-sql-exec-lens")).not.toBeNull();
    view.destroy();
  });
});
