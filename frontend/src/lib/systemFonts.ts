/**
 * 检测系统已安装字体：Tauri 后端枚举优先，Web 环境回退 Local Font Access / FontFace / canvas / DOM 探测。
 */

import { invoke } from "@tauri-apps/api/core";

/** 常见等宽字体候选（Web 回退探测用） */
export const MONOSPACE_FONT_CANDIDATES = [
  "Cascadia Code",
  "Cascadia Mono",
  "JetBrains Mono",
  "Fira Code",
  "IBM Plex Mono",
  "Berkeley Mono",
  "Source Code Pro",
  "Menlo",
  "Monaco",
  "Consolas",
  "Courier New",
  "Ubuntu Mono",
  "DejaVu Sans Mono",
  "Liberation Mono",
  "Roboto Mono",
  "Inconsolata",
  "Hack",
  "Droid Sans Mono",
  "Noto Sans Mono",
  "SF Mono",
  "PT Mono",
  "Anonymous Pro",
  "Space Mono",
  "Victor Mono",
  "Fantasque Sans Mono",
  "Iosevka",
  "Input Mono",
  "Operator Mono",
  "PragmataPro",
  "Meslo LG M",
  "Bitstream Vera Sans Mono",
  "Lucida Console",
  "Courier",
  "monospace",
] as const;

/** 常见 UI 字体候选（Web 回退探测用） */
const COMMON_UI_FONT_CANDIDATES = [
  "Segoe UI",
  "Arial",
  "Arial Black",
  "Calibri",
  "Cambria",
  "Candara",
  "Comic Sans MS",
  "Constantia",
  "Corbel",
  "Georgia",
  "Impact",
  "Lucida Sans Unicode",
  "Microsoft Sans Serif",
  "Palatino Linotype",
  "Tahoma",
  "Times New Roman",
  "Trebuchet MS",
  "Verdana",
  "Yu Gothic UI",
  "Microsoft YaHei",
  "Microsoft YaHei UI",
  "SimSun",
  "SimHei",
  "PingFang SC",
  "PingFang TC",
  "Hiragino Sans GB",
  "Helvetica Neue",
  "Helvetica",
  "Arial Unicode MS",
  "sans-serif",
  "serif",
] as const;

const BASE_FONT = "monospace";
const PROPORTIONAL_BASE = "sans-serif";
const TEST_STRING = "mmmmmmmmmmlli";
const TEST_SIZE = "72px";
const QUERY_LOCAL_FONTS_TIMEOUT_MS = 2500;

let cachedMonospace: string[] | null = null;
let cachedAll: string[] | null = null;

type LocalFontFace = { family: string };

type QueryLocalFontsWindow = Window & {
  queryLocalFonts?: () => Promise<LocalFontFace[]>;
};

function isTauriApp(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function sortFontNames(names: Iterable<string>): string[] {
  return [...new Set([...names].map((name) => name.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );
}

function ensureIncludesValue(fonts: string[], value?: string): string[] {
  const trimmed = value?.trim();
  if (!trimmed || fonts.includes(trimmed)) {
    return fonts;
  }
  return sortFontNames([trimmed, ...fonts]);
}

async function queryTauriSystemFonts(monospaceOnly: boolean): Promise<string[]> {
  if (!isTauriApp()) {
    return [];
  }
  try {
    const fonts = await invoke<string[]>("list_system_fonts", { monospaceOnly });
    return sortFontNames(fonts);
  } catch {
    return [];
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, timeoutMs);
    promise
      .then((value) => {
        if (!settled) {
          settled = true;
          window.clearTimeout(timer);
          resolve(value);
        }
      })
      .catch(() => {
        if (!settled) {
          settled = true;
          window.clearTimeout(timer);
          resolve(null);
        }
      });
  });
}

async function queryLocalFontFamilies(): Promise<string[]> {
  const queryLocalFonts = (window as QueryLocalFontsWindow).queryLocalFonts;
  if (!queryLocalFonts) {
    return [];
  }
  try {
    const faces = await withTimeout(queryLocalFonts(), QUERY_LOCAL_FONTS_TIMEOUT_MS);
    if (!faces) {
      return [];
    }
    return sortFontNames(faces.map((face) => face.family));
  } catch {
    return [];
  }
}

async function ensureDocumentFontsReady(): Promise<void> {
  if (!document.fonts?.ready) {
    return;
  }
  try {
    await document.fonts.ready;
  } catch {
    // ignore
  }
}

function isGenericFamily(font: string): boolean {
  return font === "monospace" || font === "sans-serif" || font === "serif";
}

function isFontAvailableByCheck(font: string): boolean {
  if (isGenericFamily(font) || !document.fonts?.check) {
    return isGenericFamily(font);
  }
  return (
    document.fonts.check(`16px "${font}"`) ||
    document.fonts.check(`16px '${font}'`) ||
    document.fonts.check(`72px "${font}"`)
  );
}

function probeInstalledFontsByDom(
  candidates: readonly string[],
  genericFamily: string,
): string[] {
  if (typeof document === "undefined" || !document.body) {
    return [];
  }

  // 批量探测：为每个候选字体创建独立 span，一次性 append，
  // 浏览器合并为一次 style recalc + layout，避免循环内逐次 offsetWidth 强制 reflow。
  const container = document.createElement("div");
  container.style.cssText = "position:absolute;left:-9999px;top:-9999px;visibility:hidden;pointer-events:none;";

  const baseSpan = document.createElement("span");
  baseSpan.textContent = TEST_STRING;
  baseSpan.style.cssText = `whiteSpace:nowrap;font-size:${TEST_SIZE};font-family:${genericFamily};`;
  container.appendChild(baseSpan);

  const fontSpans: Array<{ font: string; span: HTMLSpanElement }> = [];
  for (const font of candidates) {
    if (isGenericFamily(font)) continue;
    const span = document.createElement("span");
    span.textContent = TEST_STRING;
    span.style.cssText = `whiteSpace:nowrap;font-size:${TEST_SIZE};font-family:"${font}", ${genericFamily};`;
    container.appendChild(span);
    fontSpans.push({ font, span });
  }

  document.body.appendChild(container);

  // 批量读取：所有 span 共享同一次 layout
  const genericWidth = baseSpan.offsetWidth;
  const detected: string[] = [];
  for (const { font, span } of fontSpans) {
    if (span.offsetWidth !== genericWidth) {
      detected.push(font);
    }
  }

  document.body.removeChild(container);
  return detected;
}

function probeInstalledFontsByCanvas(
  candidates: readonly string[],
  baseFont: string,
): string[] {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return [];
  }

  ctx.font = `${TEST_SIZE} ${baseFont}`;
  const baselineWidth = ctx.measureText(TEST_STRING).width;
  const detected: string[] = [];

  for (const font of candidates) {
    if (isGenericFamily(font)) {
      detected.push(font);
      continue;
    }
    ctx.font = `${TEST_SIZE} "${font}", ${baseFont}`;
    const quotedWidth = ctx.measureText(TEST_STRING).width;
    if (quotedWidth !== baselineWidth) {
      detected.push(font);
      continue;
    }
    ctx.font = `${TEST_SIZE} '${font}', ${baseFont}`;
    if (ctx.measureText(TEST_STRING).width !== baselineWidth) {
      detected.push(font);
    }
  }

  return detected;
}

async function probeInstalledFonts(
  candidates: readonly string[],
  genericFamily: string,
): Promise<string[]> {
  await ensureDocumentFontsReady();

  const detected = new Set<string>();
  for (const font of candidates) {
    if (isFontAvailableByCheck(font)) {
      detected.add(font);
    }
  }
  for (const font of probeInstalledFontsByDom(candidates, genericFamily)) {
    detected.add(font);
  }
  for (const font of probeInstalledFontsByCanvas(candidates, genericFamily)) {
    detected.add(font);
  }
  return sortFontNames(detected);
}

async function detectFromWebFallback(
  candidates: readonly string[],
  genericFamily: string,
): Promise<string[]> {
  const fromApi = await queryLocalFontFamilies();
  if (fromApi.length > 0) {
    return fromApi;
  }
  const probed = await probeInstalledFonts(candidates, genericFamily);
  return probed.length > 0 ? probed : sortFontNames(candidates);
}

/**
 * 探测系统已安装的等宽字体。
 */
export async function detectMonospaceFonts(currentValue?: string): Promise<string[]> {
  if (cachedMonospace) {
    return ensureIncludesValue(cachedMonospace, currentValue);
  }

  const fromTauri = await queryTauriSystemFonts(true);
  if (fromTauri.length > 0) {
    cachedMonospace = fromTauri;
    return ensureIncludesValue(cachedMonospace, currentValue);
  }

  let detected = await detectFromWebFallback(MONOSPACE_FONT_CANDIDATES, BASE_FONT);
  if (!detected.includes("monospace")) {
    detected = sortFontNames([...detected, "monospace"]);
  }
  cachedMonospace = sortFontNames(detected);
  return ensureIncludesValue(cachedMonospace, currentValue);
}

/**
 * 探测系统已安装的全部字体（尽力而为）。
 */
export async function detectAllSystemFonts(currentValue?: string): Promise<string[]> {
  if (cachedAll) {
    return ensureIncludesValue(cachedAll, currentValue);
  }

  const fromTauri = await queryTauriSystemFonts(false);
  if (fromTauri.length > 0) {
    cachedAll = fromTauri;
    return ensureIncludesValue(cachedAll, currentValue);
  }

  const fromApi = await queryLocalFontFamilies();
  if (fromApi.length > 0) {
    cachedAll = fromApi;
    return ensureIncludesValue(cachedAll, currentValue);
  }

  const monospace = await probeInstalledFonts(MONOSPACE_FONT_CANDIDATES, BASE_FONT);
  const proportional = await probeInstalledFonts(COMMON_UI_FONT_CANDIDATES, PROPORTIONAL_BASE);
  const merged = sortFontNames([...monospace, ...proportional]);
  cachedAll =
    merged.length > 0
      ? merged
      : sortFontNames([...MONOSPACE_FONT_CANDIDATES, ...COMMON_UI_FONT_CANDIDATES]);
  return ensureIncludesValue(cachedAll, currentValue);
}

/** 清除字体探测缓存（主要用于测试）。 */
export function clearSystemFontCache(): void {
  cachedMonospace = null;
  cachedAll = null;
}
