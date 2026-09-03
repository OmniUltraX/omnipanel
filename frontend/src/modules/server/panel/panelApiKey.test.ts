import { describe, expect, it } from "vitest";

import { isUsablePanelApiKey } from "./panelApiKey";

describe("isUsablePanelApiKey", () => {
  it("rejects BT md5 token and empty values", () => {
    expect(isUsablePanelApiKey("bt", "0123456789abcdef0123456789abcdef")).toBe(false);
    expect(isUsablePanelApiKey("bt", "")).toBe(false);
    expect(isUsablePanelApiKey("bt", "short")).toBe(false);
  });

  it("accepts BT plaintext key and 1Panel hex key", () => {
    expect(isUsablePanelApiKey("bt", "u6dS9qE1pyRZDnTp")).toBe(true);
    expect(isUsablePanelApiKey("1panel", "0123456789abcdef0123456789abcdef")).toBe(true);
  });
});
