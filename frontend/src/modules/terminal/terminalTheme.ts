import type { ITheme } from "@xterm/xterm";

/**
 * 终端主题（暗色）：保留原有的深色终端配色，作为暗色主题默认外观。
 */
export const DARK_TERMINAL_THEME: ITheme = {
  background: "#1a1717",
  foreground: "#f4f1ed",
  cursor: "#f4f1ed",
  selectionBackground: "#5b504a",
  black: "#1a1717",
  red: "#ff6b6b",
  green: "#51cf66",
  yellow: "#ffd43b",
  blue: "#74c0fc",
  magenta: "#da77f2",
  cyan: "#66d9e8",
  white: "#f4f1ed",
  brightBlack: "#7c6f66",
  brightRed: "#ff8787",
  brightGreen: "#69db7c",
  brightYellow: "#ffe066",
  brightBlue: "#91a7ff",
  brightMagenta: "#e599f7",
  brightCyan: "#99e9f2",
  brightWhite: "#fff9f0",
};

/**
 * 终端主题（浅色）：浅色背景下使用深色前景，保证浅色主题下终端可读性。
 * ANSI 颜色选取 Apple System Color 浅色变体，在浅色背景下有良好对比度。
 */
export const LIGHT_TERMINAL_THEME: ITheme = {
  background: "#ffffff",
  foreground: "#1d1d1f",
  cursor: "#1d1d1f",
  selectionBackground: "rgba(0, 122, 255, 0.18)",
  black: "#1d1d1f",
  red: "#d70015",
  green: "#248a3d",
  yellow: "#c93400",
  blue: "#0040dd",
  magenta: "#af52de",
  cyan: "#039be5",
  white: "#8e8e93",
  brightBlack: "#3a3a3c",
  brightRed: "#ff453a",
  brightGreen: "#32d74b",
  brightYellow: "#ffd60a",
  brightBlue: "#0a84ff",
  brightMagenta: "#bf5af2",
  brightCyan: "#40c8e0",
  brightWhite: "#000000",
};

/**
 * 根据应用 resolved 主题返回对应的终端主题。
 * resolved 为 "light" 时使用浅色终端主题，否则使用暗色主题。
 */
export function getTerminalTheme(resolved: "light" | "dark"): ITheme {
  return resolved === "light" ? LIGHT_TERMINAL_THEME : DARK_TERMINAL_THEME;
}
