import { describe, expect, it } from "vitest";
import {
  FALLBACK_THEME_TOKENS,
  parseThemeTokens,
  pickActiveThemePluginId,
  themeTokensRel,
} from "./pluginTheme";

describe("pluginTheme", () => {
  it("解析非法 JSON 不抛", () => {
    expect(parseThemeTokens("{")).toBeNull();
    expect(parseThemeTokens("null")).toBeNull();
    expect(parseThemeTokens("[]")).toBeNull();
    expect(parseThemeTokens("not-json")).toBeNull();
  });

  it("js: true 的 tokens 视为非法", () => {
    expect(
      parseThemeTokens(
        JSON.stringify({
          js: true,
          terminal: {
            dark: { background: "#000", foreground: "#fff" },
            light: { background: "#fff", foreground: "#000" },
          },
        }),
      ),
    ).toBeNull();
  });

  it("忽略未白名单 CSS 变量与非法颜色", () => {
    const parsed = parseThemeTokens(
      JSON.stringify({
        css: {
          dark: {
            "--accent": "#ff6b00",
            "--unknown": "#ffffff",
            "--accent-hover": "javascript:alert(1)",
          },
        },
        terminal: {
          dark: { background: "#1a1717", foreground: "#f4f1ed" },
          light: { background: "#ffffff", foreground: "#1d1d1f" },
        },
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.css.dark).toEqual({ "--accent": "#ff6b00" });
    expect(parsed?.css.light).toEqual({});
  });

  it("内置 fallback 可解析且含终端色板", () => {
    expect(FALLBACK_THEME_TOKENS.terminal.dark.background).toBeTruthy();
    expect(FALLBACK_THEME_TOKENS.terminal.light.foreground).toBeTruthy();
    expect(FALLBACK_THEME_TOKENS.css.dark["--accent"]).toBe("#007aff");
  });

  it("多 theme 单活：优先最近启用", () => {
    const items = [
      { id: "theme-a", kind: "theme" as const, enabled: true },
      { id: "theme-b", kind: "theme" as const, enabled: true },
    ];
    expect(pickActiveThemePluginId(items, "theme-b")).toBe("theme-b");
    expect(pickActiveThemePluginId(items, "theme-a")).toBe("theme-a");
    expect(pickActiveThemePluginId(items.filter((i) => i.id !== "theme-b"), "theme-b")).toBe(
      "theme-a",
    );
    expect(pickActiveThemePluginId([], "theme-a")).toBeNull();
  });

  it("tokens 路径缺省为 tokens.json", () => {
    expect(themeTokensRel(null)).toBe("tokens.json");
    expect(themeTokensRel({ contributes: { themes: { tokens: "ui/skin.json" } } })).toBe(
      "ui/skin.json",
    );
  });
});
