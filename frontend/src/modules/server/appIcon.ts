import { normalizeBtPanelBaseUrl } from "../../lib/btpanel";
import { normalizeOnePanelBaseUrl } from "../../lib/onepanel";
import type { ServerInstalledApp } from "./serverApp";

export function resolveWebsiteFavicon(website?: string): string | null {
  if (!website?.trim()) return null;
  try {
    return new URL("/favicon.ico", website.trim()).href;
  } catch {
    return null;
  }
}

/**
 * 宝塔应用图标：优先 `icon` 字段；为空时用 `home` 官网 favicon.ico。
 */
export function resolveBtAppIconUrl(panelAddress: string, app: ServerInstalledApp): string | null {
  const icon = app.icon?.trim();
  if (icon) {
    if (/^https?:\/\//i.test(icon)) return icon;
    const origin = normalizeBtPanelBaseUrl(panelAddress);
    return icon.startsWith("/") ? `${origin}${icon}` : `${origin}/${icon}`;
  }
  return resolveWebsiteFavicon(app.app?.website);
}

/** 1Panel 图标 API 不可用时的兜底：列表 icon 字段 → 官网 favicon。 */
export function resolveFallbackAppIconUrl(baseUrl: string, app: ServerInstalledApp): string | null {
  const icon = app.icon?.trim();
  if (icon) {
    if (/^https?:\/\//i.test(icon)) return icon;
    const origin = normalizeOnePanelBaseUrl(baseUrl);
    return icon.startsWith("/") ? `${origin}${icon}` : `${origin}/${icon}`;
  }
  return resolveWebsiteFavicon(app.app?.website);
}
