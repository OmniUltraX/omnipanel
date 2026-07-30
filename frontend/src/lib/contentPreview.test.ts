import { describe, expect, it } from "vitest";
import {
  normalizePreviewWebUrl,
  resolvePreferredPreviewTextMode,
  resolvePreviewWebTarget,
} from "./contentPreview";

describe("normalizePreviewWebUrl", () => {
  it("接受显式 http(s) 与常见域名", () => {
    expect(normalizePreviewWebUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(normalizePreviewWebUrl("example.com")).toBe("https://example.com/");
    expect(normalizePreviewWebUrl("www.example.org/path")).toBe("https://www.example.org/path");
  });

  it("拒绝单词与空串", () => {
    expect(normalizePreviewWebUrl("true")).toBeNull();
    expect(normalizePreviewWebUrl("")).toBeNull();
    expect(normalizePreviewWebUrl("hello world")).toBeNull();
  });

  it("拒绝看起来像文件名的 name.ext（避免误开网页预览）", () => {
    expect(normalizePreviewWebUrl("pig-auth-dev.yml")).toBeNull();
    expect(normalizePreviewWebUrl("application-dev.yml")).toBeNull();
    expect(normalizePreviewWebUrl("config.json")).toBeNull();
    expect(normalizePreviewWebUrl("readme.md")).toBeNull();
    expect(normalizePreviewWebUrl("schema.sql")).toBeNull();
  });
});

describe("resolvePreviewWebTarget / preferred mode", () => {
  it("文件名不触发网页模式", () => {
    expect(resolvePreviewWebTarget("pig-auth-dev.yml")).toBeNull();
    expect(
      resolvePreferredPreviewTextMode({ kind: "text", text: "pig-auth-dev.yml" }),
    ).toBe("plain");
  });

  it("真实 URL 仍推荐网页模式", () => {
    expect(resolvePreviewWebTarget("https://example.com")).toEqual({
      type: "url",
      url: "https://example.com/",
    });
    expect(
      resolvePreferredPreviewTextMode({ kind: "text", text: "https://example.com" }),
    ).toBe("web");
  });
});
