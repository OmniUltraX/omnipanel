import { describe, expect, it } from "vitest";
import {
  mergeConnectionOrder,
  moveConnectionInOrder,
  sortConnectionGroups,
} from "../modules/terminal/terminalConnectionOrder";

describe("terminalConnectionOrder", () => {
  it("keeps saved order and appends new connections", () => {
    const merged = mergeConnectionOrder(["b", "a"], ["a", "b", "c"]);
    expect(merged).toEqual(["b", "a", "c"]);
  });

  it("moves connection before target", () => {
    const next = moveConnectionInOrder(["a", "b", "c"], "c", "a", "before");
    expect(next).toEqual(["c", "a", "b"]);
  });

  it("sorts groups by persisted order only", () => {
    const groups = [
      { resourceId: "local", name: "Local", sessions: [{}] },
      { resourceId: "ssh-1", name: "SSH", sessions: [{}] },
    ];
    const sorted = sortConnectionGroups(groups, ["ssh-1", "local"]);
    expect(sorted.map((g) => g.resourceId)).toEqual(["ssh-1", "local"]);
  });
});
