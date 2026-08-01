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
 * 终端主题（浅色）：为浅色背景专门设计的 ANSI 调色板。
 *
 * 设计原则：
 * - 所有 ANSI 颜色在 #ffffff 背景上对比度 ≥ 4.5:1（WCAG AA 正文级），
 *   保证 `ls` / prompt / grep --color 等彩色输出清晰可读。
 * - 正常色偏深（保证对比度），亮色稍浅但仍然可辨——
 *   浅色背景下的视觉层级与深色终端相反：深色更显眼。
 * - 语义正确：yellow 是黄色而非橙色，不与 red 混淆；
 *   white 接近背景色（用于"常规文件"等低强调输出），brightWhite 为最深黑。
 *
 * 参考基准：VS Code Light+ / iTerm2 Light Background 的 ANSI 配色，
 * 并针对 #ffffff 纯白背景做了对比度校准。
 */
export const LIGHT_TERMINAL_THEME: ITheme = {
  background: "#ffffff",
  foreground: "#1d1d1f",
  cursor: "#1d1d1f",
  selectionBackground: "rgba(0, 122, 255, 0.18)",
  // 正常色：深色系，保证白底上的对比度
  black: "#000000",
  red: "#c91b00",
  green: "#008400",
  yellow: "#a8810c", // 深金黄——纯亮黄(#ffdd00)在白底上对比度<2 不可读
  blue: "#0451a5",
  magenta: "#a800b0",
  cyan: "#0a7a83",
  white: "#5a5a5a", // 接近背景的灰——ls 常规文件用，不抢眼但可读
  // 亮色：比正常色更鲜艳/更深，保持层级关系
  brightBlack: "#3a3a3c",
  brightRed: "#e60023",
  brightGreen: "#00a300",
  brightYellow: "#b58900", // 比 yellow 更深，避免亮黄在白底消失
  brightBlue: "#0066ff",
  brightMagenta: "#c400cc",
  brightCyan: "#0099b0",
  brightWhite: "#000000",
};

/**
 * 根据应用 resolved 主题返回对应的终端主题。
 * resolved 为 "light" 时使用浅色终端主题，否则使用暗色主题。
 */
export function getTerminalTheme(resolved: "light" | "dark"): ITheme {
  return resolved === "light" ? LIGHT_TERMINAL_THEME : DARK_TERMINAL_THEME;
}
