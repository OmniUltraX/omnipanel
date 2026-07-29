import { describe, expect, it } from "vitest";
import { mergeConversations } from "./merge";
import type { AiConversation } from "../../stores/aiStore";

function conv(partial: Partial<AiConversation> & { id: string }): AiConversation {
  return {
    title: "t",
    messages: [],
    provider: "openai",
    model: "gpt",
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

describe("mergeConversations", () => {
  it("LWW by updatedAt", () => {
    const local = [conv({ id: "a", title: "local", updatedAt: 10 })];
    const remote = [conv({ id: "a", title: "remote", updatedAt: 20 })];
    const { conversations, changed } = mergeConversations({
      local,
      remote,
      tombstones: [],
    });
    expect(changed).toBe(true);
    expect(conversations[0]?.title).toBe("remote");
  });

  it("tombstone wins when newer than conversation", () => {
    const local = [conv({ id: "a", updatedAt: 10 })];
    const remote = [conv({ id: "a", updatedAt: 15 })];
    const { conversations } = mergeConversations({
      local,
      remote,
      tombstones: [{ id: "a", deletedAt: 20 }],
    });
    expect(conversations).toHaveLength(0);
  });

  it("resurrects when conversation newer than tombstone", () => {
    const remote = [conv({ id: "a", title: "back", updatedAt: 30 })];
    const { conversations } = mergeConversations({
      local: [],
      remote,
      tombstones: [{ id: "a", deletedAt: 20 }],
    });
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.title).toBe("back");
  });
});
