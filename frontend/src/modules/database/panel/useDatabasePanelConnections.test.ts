import { describe, expect, it } from "vitest";
import { mergeLogAvailability } from "./useDatabasePanelConnections";

describe("mergeLogAvailability", () => {
  it("keeps a finished probe when the sync result is still checking", () => {
    const merged = mergeLogAvailability(
      { a: { enabled: false, reason: "checking" } },
      { a: { enabled: false, reason: "binlog_off" } },
    );
    expect(merged.a.reason).toBe("binlog_off");
  });

  it("drops a stale closed-connection result after the connection is opened", () => {
    const merged = mergeLogAvailability(
      { a: { enabled: false, reason: "checking" } },
      { a: { enabled: false, reason: "connection_disabled" } },
    );
    expect(merged.a.reason).toBe("checking");
  });
});
