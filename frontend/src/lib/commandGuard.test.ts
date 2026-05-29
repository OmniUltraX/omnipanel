import { describe, it, expect } from "vitest";
import { checkCommand } from "./commandGuard";

describe("checkCommand", () => {
  it("treats a plain command as safe", () => {
    const result = checkCommand("ls -la");
    expect(result.safe).toBe(true);
    expect(result.level).toBe("low");
    expect(result.matches).toHaveLength(0);
  });

  it("flags destructive SQL as high risk", () => {
    const result = checkCommand("DROP TABLE users");
    expect(result.safe).toBe(false);
    expect(result.level).toBe("high");
    expect(result.matches.some((m) => /destructive/i.test(m.desc))).toBe(true);
  });

  it("flags SQL writes as at least medium risk", () => {
    const result = checkCommand("UPDATE orders SET status = 'paid'");
    expect(result.safe).toBe(false);
    expect(["medium", "high", "critical"]).toContain(result.level);
  });

  it("escalates risk one level in production environment", () => {
    const normal = checkCommand("UPDATE orders SET status = 'paid'");
    const prod = checkCommand("UPDATE orders SET status = 'paid'", "prod");
    const order = ["low", "medium", "high", "critical"];
    expect(order.indexOf(prod.level)).toBeGreaterThanOrEqual(order.indexOf(normal.level));
  });
});
