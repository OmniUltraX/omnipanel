import { describe, expect, it } from "vitest";
import { getHostSelection, setTerminalSelection } from "./hostSelection";

describe("hostSelection", () => {
  it("prefers terminal selection over empty DOM", () => {
    setTerminalSelection("ls -la");
    expect(getHostSelection()).toEqual({ text: "ls -la", source: "terminal" });
    setTerminalSelection("  ");
    const next = getHostSelection();
    expect(next == null || next.source === "dom").toBe(true);
  });
});
