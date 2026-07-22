import { describe, expect, it } from "vitest";
import { canAutoAllowAcp, decideToolInvocation } from "./toolGate";

describe("decideToolInvocation", () => {
  it("allows read-only sql", () => {
    const r = decideToolInvocation({
      toolName: "omni_database_execute_sql",
      args: { sql: "SELECT 1", connection_name: "local", database_name: "db" },
    });
    expect(r.decision).toBe("allow");
  });

  it("approves write sql", () => {
    const r = decideToolInvocation({
      toolName: "omni_database_execute_sql",
      args: { sql: "DELETE FROM t", connection_name: "local", database_name: "db" },
    });
    expect(r.decision).toBe("approve");
  });

  it("approves kill_query", () => {
    const r = decideToolInvocation({
      toolName: "omni_database_kill_query",
      args: { connection_name: "local", query_id: "1" },
    });
    expect(r.decision).toBe("approve");
  });

  it("approves docker_exec", () => {
    const r = decideToolInvocation({
      toolName: "omni_docker_exec",
      args: { connection_id: "docker-local", container_id: "c1", command: "rm -rf /" },
    });
    expect(r.decision).toBe("approve");
  });

  it("allows metadata tools", () => {
    expect(
      decideToolInvocation({
        toolName: "omni_database_get_tables_from_database",
        args: { connection_name: "x", database_name: "y" },
      }).decision,
    ).toBe("allow");
  });
});

describe("canAutoAllowAcp", () => {
  it("auto-allows select", () => {
    expect(
      canAutoAllowAcp(
        "omni_database_execute_sql",
        JSON.stringify({ sql: "-- q\nSELECT 1" }),
      ),
    ).toBe(true);
  });

  it("does not auto-allow delete", () => {
    expect(
      canAutoAllowAcp(
        "omni_database_execute_sql",
        JSON.stringify({ sql: "DELETE FROM t" }),
      ),
    ).toBe(false);
  });
});
