import { describe, expect, it } from "vitest";
import { buildDbRefreshSchemaNodeInvokeArgs } from "./schemaTreeRefresh";
import type { DbConnectionConfig } from "../api";

const connection = {
  id: "gui-sqlite",
  name: "GUI sample SQLite",
  db_type: "sqlite",
} as DbConnectionConfig;

describe("buildDbRefreshSchemaNodeInvokeArgs", () => {
  it("sends connection at the top level for web IPC (official 0.8.58 does not unwrap args)", () => {
    const args = buildDbRefreshSchemaNodeInvokeArgs(
      connection,
      "connection",
      "conn:gui-sqlite",
      { web: true },
    );
    expect(args).toEqual({
      connection,
      nodeKind: "connection",
      nodeId: "conn:gui-sqlite",
    });
    expect(args).not.toHaveProperty("args");
  });

  it("keeps the Tauri { args } wrapper on desktop", () => {
    const args = buildDbRefreshSchemaNodeInvokeArgs(
      connection,
      "database",
      "db:gui-sqlite:/data/gui-sample/gui.sqlite",
      { web: false },
    );
    expect(args).toEqual({
      args: {
        connection,
        nodeKind: "database",
        nodeId: "db:gui-sqlite:/data/gui-sample/gui.sqlite",
      },
    });
  });
});
