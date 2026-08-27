import { describe, expect, it } from "vitest";
import { resolveApiBaseUrl } from "./resolveApiBaseUrl";

describe("resolveApiBaseUrl", () => {
  it("appends /v1 when enabled and missing", () => {
    expect(resolveApiBaseUrl("https://api.openai.com", true)).toBe(
      "https://api.openai.com/v1",
    );
    expect(resolveApiBaseUrl("http://127.0.0.1:11434/", true)).toBe(
      "http://127.0.0.1:11434/v1",
    );
  });

  it("does not double-append when the URL already ends with /v1", () => {
    expect(resolveApiBaseUrl("https://api.openai.com/v1", true)).toBe(
      "https://api.openai.com/v1",
    );
    expect(resolveApiBaseUrl("https://api.openai.com/v1/", true)).toBe(
      "https://api.openai.com/v1",
    );
  });

  it("leaves the URL unchanged when disabled", () => {
    expect(resolveApiBaseUrl("http://gateway.local/openai", false)).toBe(
      "http://gateway.local/openai",
    );
    expect(resolveApiBaseUrl("https://api.example.com/v1", false)).toBe(
      "https://api.example.com/v1",
    );
  });
});
