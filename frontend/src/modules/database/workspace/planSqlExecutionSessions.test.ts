import { describe, expect, it } from "vitest";
import { planSqlExecutionSessions, type SqlResultSession } from "./dbWorkspaceState";

function session(partial: Partial<SqlResultSession> & Pick<SqlResultSession, "id" | "sql">): SqlResultSession {
  return {
    result: null,
    error: null,
    elapsed: null,
    running: false,
    resultPage: 0,
    resultHasMore: false,
    ...partial,
  };
}

describe("planSqlExecutionSessions", () => {
  it("多条语句各建一个结果会话，并保留已固定的结果", () => {
    const pinned = session({ id: "pinned", sql: "SELECT 0", pinned: true });
    const temp = session({ id: "temp", sql: "SELECT old" });
    const planned = planSqlExecutionSessions(
      [pinned, temp],
      ["SELECT 1", "SELECT 2"],
      false,
    );

    expect(planned.sessions.map((item) => item.sql)).toEqual(["SELECT 0", "SELECT 1", "SELECT 2"]);
    expect(planned.sessions[0]?.pinned).toBe(true);
    expect(planned.sessions[1]?.pinned).toBeFalsy();
    expect(planned.sessions[1]?.id).not.toBe("temp");
    expect(planned.activeSessionId).toBe(planned.sessions[1]?.id);
  });

  it("单条语句复用临时会话，并丢掉其余未固定结果", () => {
    const pinned = session({ id: "pinned", sql: "SELECT 0", pinned: true });
    const first = session({ id: "a", sql: "SELECT 1" });
    const second = session({ id: "b", sql: "SELECT 2" });
    const planned = planSqlExecutionSessions([pinned, first, second], ["SELECT 3"], false);

    expect(planned.sessions.map((item) => item.id)).toEqual(["pinned", "a"]);
    expect(planned.sessions[1]?.sql).toBe("SELECT 3");
    expect(planned.sessions[1]?.running).toBe(true);
    expect(planned.activeSessionId).toBe("a");
  });

  it("新结果标签把每条语句追加为固定会话", () => {
    const existing = [session({ id: "old", sql: "SELECT 0" })];
    const planned = planSqlExecutionSessions(existing, ["SELECT 1", "SELECT 2"], true);

    expect(planned.sessions).toHaveLength(3);
    expect(planned.sessions[0]?.id).toBe("old");
    expect(planned.sessions.slice(1).every((item) => item.pinned)).toBe(true);
    expect(planned.activeSessionId).toBe(planned.sessions[1]?.id);
  });
});
