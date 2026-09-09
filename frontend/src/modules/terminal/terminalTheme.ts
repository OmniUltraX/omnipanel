import type { ITheme, Terminal } from "@xterm/xterm";

import { useSettingsStore } from "../../stores/settingsStore";
import { getAppliedPluginTheme, subscribePluginTheme } from "../../lib/pluginTheme";

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

function extrasFor(resolved: "light" | "dark"): Partial<ITheme> {
  return resolved === "light"
    ? {
        scrollbarSliderBackground: "rgba(0, 0, 0, 0.18)",
        scrollbarSliderHoverBackground: "rgba(0, 0, 0, 0.32)",
        scrollbarSliderActiveBackground: "rgba(0, 0, 0, 0.45)",
      }
    : {
        scrollbarSliderBackground: "#f4f1ed33",
        scrollbarSliderHoverBackground: "#f4f1ed66",
        scrollbarSliderActiveBackground: "#f4f1ed80",
      };
}

/**
 * 根据应用 resolved 主题返回对应的终端主题（来自已应用的 theme 插件 tokens）。
 */
export function getTerminalTheme(resolved: "light" | "dark"): ITheme {
  const palette = getAppliedPluginTheme().terminal[resolved];
  return paletteToTheme(palette, extrasFor(resolved));
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

/** 浅色/深色切换或插件 theme tokens 变更时刷新终端色板。 */
export function subscribeTerminalPalette(
  onChange: (resolved: "light" | "dark") => void,
): () => void {
  const unsubSettings = useSettingsStore.subscribe((state, prev) => {
    if (state.resolved !== prev.resolved) {
      onChange(state.resolved === "light" ? "light" : "dark");
    }
  });
  const unsubPlugin = subscribePluginTheme(() => onChange(resolveActiveAppTheme()));
  return () => {
    unsubSettings();
    unsubPlugin();
  };
}
