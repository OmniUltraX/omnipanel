import type { ITheme, Terminal } from "@xterm/xterm";

import { useSettingsStore } from "../../stores/settingsStore";
import themeTokensJson from "../../../../plugins/theme-default/tokens.json";

const themeTokens = themeTokensJson as {
  terminal: { dark: Record<string, string>; light: Record<string, string> };
};

function paletteToTheme(
  palette: Record<string, string>,
  extras: Partial<ITheme>,
): ITheme {
  return {
    background: palette.background,
    foreground: palette.foreground,
    cursor: palette.cursor,
    selectionBackground: palette.selectionBackground,
    black: palette.black,
    red: palette.red,
    green: palette.green,
    yellow: palette.yellow,
    blue: palette.blue,
    magenta: palette.magenta,
    cyan: palette.cyan,
    white: palette.white,
    brightBlack: palette.brightBlack,
    brightRed: palette.brightRed,
    brightGreen: palette.brightGreen,
    brightYellow: palette.brightYellow,
    brightBlue: palette.brightBlue,
    brightMagenta: palette.brightMagenta,
    brightCyan: palette.brightCyan,
    brightWhite: palette.brightWhite,
    ...extras,
  };
}

/**
 * 终端主题（暗色）：来自主题包 `omni.theme.default`，禁止主题 JS。
 */
export const DARK_TERMINAL_THEME: ITheme = paletteToTheme(themeTokens.terminal.dark, {
  scrollbarSliderBackground: "#f4f1ed33",
  scrollbarSliderHoverBackground: "#f4f1ed66",
  scrollbarSliderActiveBackground: "#f4f1ed80",
});

/**
 * 终端主题（浅色）：来自主题包，ANSI 对比度按 WCAG AA 校准。
 */
export const LIGHT_TERMINAL_THEME: ITheme = paletteToTheme(themeTokens.terminal.light, {
  scrollbarSliderBackground: "rgba(0, 0, 0, 0.18)",
  scrollbarSliderHoverBackground: "rgba(0, 0, 0, 0.32)",
  scrollbarSliderActiveBackground: "rgba(0, 0, 0, 0.45)",
});

/**
 * 根据应用 resolved 主题返回对应的终端主题。
 * resolved 为 "light" 时使用浅色终端主题，否则使用暗色主题。
 */
export function getTerminalTheme(resolved: "light" | "dark"): ITheme {
  return resolved === "light" ? LIGHT_TERMINAL_THEME : DARK_TERMINAL_THEME;
}

/** 以 document data-theme 为准（避免 persist 水合前 store.resolved 过期） */
export function resolveActiveAppTheme(): "light" | "dark" {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "light" || attr === "dark") return attr;
  const resolved = useSettingsStore.getState().resolved;
  return resolved === "light" ? "light" : "dark";
}

/**
 * 写入 xterm 主题并强制重绘。
 * WebGL 下只改 options.theme 不够，需 clearTextureAtlas + refresh，否则会卡在旧底色（常见：暗色 UI + 白终端）。
 */
export function applyTerminalTheme(
  term: Terminal,
  resolved: "light" | "dark" = resolveActiveAppTheme(),
): void {
  term.options.theme = getTerminalTheme(resolved);
  try {
    term.clearTextureAtlas();
  } catch {
    // DOM renderer 无 atlas
  }
  try {
    term.refresh(0, Math.max(term.rows - 1, 0));
  } catch {
    // ignore
  }
}
