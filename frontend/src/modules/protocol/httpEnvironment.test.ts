import { describe, expect, it } from "vitest";
import { resolveEffectiveAuth } from "./httpEnvironment";

describe("resolveEffectiveAuth", () => {
  it("prefers request auth when both are set", () => {
    expect(
      resolveEffectiveAuth("Bearer Token", "req-token", "API Key", "env-key"),
    ).toEqual({ authType: "Bearer Token", authValue: "req-token" });
  });

  it("falls back to environment auth when request value is empty", () => {
    expect(
      resolveEffectiveAuth("Bearer Token", "  ", "API Key", "env-key"),
    ).toEqual({ authType: "API Key", authValue: "env-key" });
  });

  it("returns null when neither is configured", () => {
    expect(resolveEffectiveAuth("Bearer Token", "", null, null)).toEqual({
      authType: null,
      authValue: null,
    });
  });
});
