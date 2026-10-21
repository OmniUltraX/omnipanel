import { describe, expect, it } from "vitest";
import {
  RELAY_FALLBACK_BASE_MS,
  RELAY_FALLBACK_MAX_MS,
  isRelayTransportError,
  nextRelayFallbackDelayMs,
} from "./syncKeyRelayDonorPolicy";

describe("nextRelayFallbackDelayMs", () => {
  it("前两次失败保持基础间隔", () => {
    expect(nextRelayFallbackDelayMs(0)).toBe(RELAY_FALLBACK_BASE_MS);
    expect(nextRelayFallbackDelayMs(1)).toBe(RELAY_FALLBACK_BASE_MS);
  });

  it("继续失败时翻倍并封顶", () => {
    expect(nextRelayFallbackDelayMs(2)).toBe(RELAY_FALLBACK_BASE_MS * 2);
    expect(nextRelayFallbackDelayMs(3)).toBe(RELAY_FALLBACK_MAX_MS);
    expect(nextRelayFallbackDelayMs(8)).toBe(RELAY_FALLBACK_MAX_MS);
  });
});

describe("isRelayTransportError", () => {
  it("把认证服务连不上当成传输失败", () => {
    expect(isRelayTransportError({ code: "connection", message: "请求认证服务失败" })).toBe(true);
    expect(isRelayTransportError(new Error("Failed to fetch"))).toBe(true);
  });

  it("业务错误仍然算失败", () => {
    expect(isRelayTransportError({ code: "auth", message: "未登录" })).toBe(false);
    expect(isRelayTransportError(new Error("服务端未返回 requestId"))).toBe(false);
  });
});
