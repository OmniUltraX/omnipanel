import { describe, expect, it } from "vitest";
import {
  pruneAskHistoryEntries,
  type QuickLauncherAskHistoryEntry,
} from "./quickLauncherAskHistoryStore";

function entry(
  partial: Partial<QuickLauncherAskHistoryEntry> & Pick<QuickLauncherAskHistoryEntry, "id">,
): QuickLauncherAskHistoryEntry {
  return {
    prompt: partial.prompt ?? partial.id,
    answer: partial.answer ?? "ok",
    createdAt: partial.createdAt ?? 0,
    favorited: partial.favorited ?? false,
    ...partial,
  };
}

describe("pruneAskHistoryEntries", () => {
  it("keeps all favorites and only latest N normals", () => {
    const rows = [
      entry({ id: "f1", favorited: true, createdAt: 1 }),
      entry({ id: "n1", createdAt: 10 }),
      entry({ id: "n2", createdAt: 20 }),
      entry({ id: "n3", createdAt: 30 }),
      entry({ id: "n4", createdAt: 40 }),
      entry({ id: "n5", createdAt: 50 }),
      entry({ id: "n6", createdAt: 60 }),
      entry({ id: "f2", favorited: true, createdAt: 2 }),
    ];
    const pruned = pruneAskHistoryEntries(rows, 5);
    expect(pruned.some((e) => e.id === "f1")).toBe(true);
    expect(pruned.some((e) => e.id === "f2")).toBe(true);
    expect(pruned.filter((e) => !e.favorited)).toHaveLength(5);
    expect(pruned.some((e) => e.id === "n1")).toBe(false);
    expect(pruned.map((e) => e.id).slice(0, 2)).toEqual(["f2", "f1"]);
  });
});
