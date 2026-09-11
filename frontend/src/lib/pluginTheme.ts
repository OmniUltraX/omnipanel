/**
 * 已启用 theme 插件的 tokens 应用点：CSS 变量 + 终端色板。
 * 内置 default 的 JSON 仅作解析失败 / 全关时的 fallback 资源，不按插件 ID 特判。
 */

import type { PluginKind } from "../ipc/bindings";
import { getPluginManifest } from "./pluginManifests";
import fallbackTokensJson from "../../../plugins/theme-default/tokens.json";

export type TerminalPalette = Record<string, string>;

export type AppliedPluginTheme = {
  css: { dark: Record<string, string>; light: Record<string, string> };
  terminal: { dark: TerminalPalette; light: TerminalPalette };
};

type ThemePluginItem = {
  id: string;
  kind: PluginKind | string;
  enabled: boolean;
};

const CSS_VAR_ALLOW = new Set([
  "--accent",
  "--accent-hover",
  "--accent-active",
  "--accent-soft",
  "--border-focus",
]);

const TERMINAL_KEYS = [
  "background",
  "foreground",
  "cursor",
  "selectionBackground",
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

const COLOR_RE = /^(#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|rgba?\([^)]+\)|hsla?\([^)]+\))$/i;

type ThemeAssetReader = (pluginId: string, relPath: string) => Promise<string>;

let assetReader: ThemeAssetReader | null = null;
let applied: AppliedPluginTheme | null = null;
const listeners = new Set<() => void>();

export function setPluginThemeAssetReader(reader: ThemeAssetReader | null): void {
  assetReader = reader;
}

export function subscribePluginTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notifyThemeListeners(): void {
  for (const listener of listeners) listener();
}

function isSafeColor(value: string): boolean {
  return COLOR_RE.test(value.trim());
}

function parseCssMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!CSS_VAR_ALLOW.has(key)) continue;
    if (typeof value !== "string" || !isSafeColor(value)) continue;
    out[key] = value.trim();
  }
  return out;
}

function parsePalette(raw: unknown): TerminalPalette | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const out: TerminalPalette = {};
  for (const key of TERMINAL_KEYS) {
    const value = rec[key];
    if (typeof value === "string" && isSafeColor(value)) {
      out[key] = value.trim();
    }
  }
  if (!out.background || !out.foreground) return null;
  return out;
}

/** 解析 tokens JSON；非法内容返回 null，不抛。 */
export function parseThemeTokens(raw: string): AppliedPluginTheme | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const rec = value as Record<string, unknown>;
    if (rec.js === true) return null;
    const terminalRaw = rec.terminal;
    if (!terminalRaw || typeof terminalRaw !== "object" || Array.isArray(terminalRaw)) {
      return null;
    }
    const terminalObj = terminalRaw as Record<string, unknown>;
    const dark = parsePalette(terminalObj.dark);
    const light = parsePalette(terminalObj.light);
    if (!dark || !light) return null;
    const cssRaw = rec.css;
    const cssObj =
      cssRaw && typeof cssRaw === "object" && !Array.isArray(cssRaw)
        ? (cssRaw as Record<string, unknown>)
        : {};
    return {
      css: { dark: parseCssMap(cssObj.dark), light: parseCssMap(cssObj.light) },
      terminal: { dark, light },
    };
  } catch {
    return null;
  }
}

const parsedFallback = parseThemeTokens(JSON.stringify(fallbackTokensJson));

export const FALLBACK_THEME_TOKENS: AppliedPluginTheme = parsedFallback ?? {
  css: { dark: {}, light: {} },
  terminal: {
    dark: { background: "#1a1717", foreground: "#f4f1ed" },
    light: { background: "#ffffff", foreground: "#1d1d1f" },
  },
};

export function getAppliedPluginTheme(): AppliedPluginTheme {
  return applied ?? FALLBACK_THEME_TOKENS;
}

export function themeTokensRel(manifest: { contributes?: { themes?: { tokens?: string | null } | null } | null } | null): string {
  const tokens = manifest?.contributes?.themes?.tokens?.trim();
  return tokens && tokens.length > 0 ? tokens : "tokens.json";
}

export function pickActiveThemePluginId(
  items: ThemePluginItem[],
  preferredId: string,
): string | null {
  const enabled = items.filter((item) => item.enabled && item.kind === "theme");
  if (enabled.length === 0) return null;
  const preferred = enabled.find((item) => item.id === preferredId);
  if (preferred) return preferred.id;
  return enabled[0]?.id ?? null;
}

const PLUGIN_THEME_ATTR = "data-plugin-theme";

const COLOR_ALIASES: Record<string, string> = {
  "--accent": "--color-accent",
  "--accent-hover": "--color-accent-hover",
  "--accent-active": "--color-accent-active",
  "--accent-soft": "--color-accent-soft",
};

function currentScheme(): "light" | "dark" {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

function hasCssVars(tokens: AppliedPluginTheme): boolean {
  return Object.keys(tokens.css.dark).length > 0 || Object.keys(tokens.css.light).length > 0;
}

export function applyPluginThemeToDocument(tokens: AppliedPluginTheme, applyCss: boolean): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (!applyCss || !hasCssVars(tokens)) {
    root.removeAttribute(PLUGIN_THEME_ATTR);
    void import("../stores/settingsStore").then(({ reapplyDocumentAccentColor }) => {
      reapplyDocumentAccentColor();
    });
    return;
  }
  root.setAttribute(PLUGIN_THEME_ATTR, "1");
  const vars = tokens.css[currentScheme()];
  for (const key of CSS_VAR_ALLOW) {
    const value = vars[key];
    if (!value) continue;
    root.style.setProperty(key, value);
    const alias = COLOR_ALIASES[key];
    if (alias) root.style.setProperty(alias, value);
  }
}

function commitTheme(tokens: AppliedPluginTheme, applyCss: boolean): void {
  applied = tokens;
  applyPluginThemeToDocument(tokens, applyCss);
  notifyThemeListeners();
  ensureSchemeSubscription();
}

let schemeUnsub: (() => void) | null = null;
let applyCssActive = false;

function ensureSchemeSubscription(): void {
  if (schemeUnsub || typeof document === "undefined") return;
  void import("../stores/settingsStore").then(({ useSettingsStore }) => {
    if (schemeUnsub) return;
    schemeUnsub = useSettingsStore.subscribe((state, prev) => {
      if (state.resolved === prev.resolved) return;
      applyPluginThemeToDocument(getAppliedPluginTheme(), applyCssActive);
    });
  });
}

async function readThemeAsset(pluginId: string, relPath: string): Promise<string> {
  if (assetReader) return assetReader(pluginId, relPath);
  const { commands } = await import("../ipc/bindings");
  const { unwrapCommand } = await import("../ipc/result");
  return unwrapCommand(commands.pluginReadAsset(pluginId, relPath));
}

export async function syncPluginThemeFromRuntime(items: ThemePluginItem[]): Promise<void> {
  const { useSettingsStore } = await import("../stores/settingsStore");
  const preferredId = useSettingsStore.getState().themePackId;
  const activeId = pickActiveThemePluginId(items, preferredId);
  if (!activeId) {
    applyCssActive = false;
    commitTheme(FALLBACK_THEME_TOKENS, false);
    return;
  }
  const rel = themeTokensRel(getPluginManifest(activeId));
  try {
    const raw = await readThemeAsset(activeId, rel);
    const parsed = parseThemeTokens(raw);
    applyCssActive = parsed != null;
    commitTheme(parsed ?? FALLBACK_THEME_TOKENS, parsed != null);
  } catch {
    applyCssActive = false;
    commitTheme(FALLBACK_THEME_TOKENS, false);
  }
}
