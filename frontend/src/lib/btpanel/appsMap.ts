import type { OnePanelApp, OnePanelInstalledApp } from "../onepanel";
import { normalizeBtPanelBaseUrl } from "./auth";
import type { BtApp, BtAppVersion, BtInstalledApp } from "./types";

/** 宝塔 Docker 应用商店静态图标相对路径。 */
export function btDockerAppIconPath(appname: string): string {
  const name = appname.trim();
  return `/static/img/soft_ico/dkapp/ico-dkapp_${name}.png`;
}

/** 拼出可直接用于 <img src> 的绝对图标地址。 */
export function btDockerAppIconUrl(panelBaseUrl: string, appname: string): string {
  const name = appname.trim();
  if (!name) return "";
  return `${normalizeBtPanelBaseUrl(panelBaseUrl)}${btDockerAppIconPath(name)}`;
}

/**
 * 解析图标字段。
 * 注意：不要把面板局域网 http(s) 绝对地址直接塞给 `<img>`——Tauri WebView 常加载失败；
 * 前端应通过 `getAppIconDataUrl` 走 Rust 代理成 data URL。
 */
function resolveBtAppIcon(icon: string | undefined, appname: string): string | undefined {
  const raw = String(icon ?? "").trim();
  if (raw) {
    if (raw.startsWith("data:") || raw.startsWith("blob:")) {
      return raw;
    }
    // 部分接口直接返回 base64
    if (/^[A-Za-z0-9+/=]+$/.test(raw) && raw.length > 64) {
      return `data:image/png;base64,${raw}`;
    }
  }
  // 仅保留相对路径标记；实际展示由懒加载拉 data URL
  if (appname.trim()) {
    return btDockerAppIconPath(appname);
  }
  return undefined;
}

/** 展平宝塔 appversion → 可读版本字符串列表（如 8.0）。 */
export function flattenBtAppVersions(versions: BtAppVersion[] | undefined): string[] {
  if (!versions?.length) return [];
  const out: string[] = [];
  for (const item of versions) {
    const major = String(item.m_version ?? "").trim();
    if (!major) continue;
    const minors = Array.isArray(item.s_version)
      ? item.s_version
      : item.s_version != null && String(item.s_version).trim() !== ""
        ? [String(item.s_version)]
        : [];
    if (minors.length === 0) {
      out.push(major);
      continue;
    }
    for (const minor of minors) {
      const s = String(minor).trim();
      out.push(s ? `${major}.${s}` : major);
    }
  }
  return out;
}

/** 取应用商店条目的首选主/子版本（安装 create_app 用）。 */
export function pickBtAppVersion(
  app: BtApp,
): { mVersion: string; sVersion: string } | null {
  const first = app.appversion?.[0];
  if (!first) return null;
  const mVersion = String(first.m_version ?? "").trim();
  if (!mVersion) return null;
  const minors = Array.isArray(first.s_version)
    ? first.s_version
    : first.s_version != null
      ? [first.s_version]
      : [];
  const sVersion = String(minors[0] ?? "0").trim() || "0";
  return { mVersion, sVersion };
}

/** 从 field/env 默认值组装安装附加参数。 */
export function defaultBtCreateAppExtras(app: BtApp): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const field of app.field ?? []) {
    const key = String(field.attr ?? "").trim();
    if (!key || field.default == null) continue;
    if (typeof field.default === "string" || typeof field.default === "number" || typeof field.default === "boolean") {
      out[key] = field.default;
    }
  }
  for (const env of app.env ?? []) {
    const key = String(env.key ?? "").trim();
    if (!key || key === "version" || env.default == null || key in out) continue;
    if (typeof env.default === "string" || typeof env.default === "number" || typeof env.default === "boolean") {
      out[key] = env.default;
    }
  }
  return out;
}

/** 映射为应用市场统一卡片模型（复用 ServerAppsTab）。 */
export function mapBtAppToOnePanel(app: BtApp, index = 0): OnePanelApp {
  const key = String(app.appname ?? "").trim();
  const name = String(app.apptitle ?? key).trim() || key;
  return {
    id: typeof app.appid === "number" ? app.appid : index + 1,
    name,
    key,
    type: app.apptype,
    icon: resolveBtAppIcon(app.icon, key),
    description: app.appdesc,
    shortDescZh: app.appdesc,
    versions: flattenBtAppVersions(app.appversion),
    installed: Boolean(app.installed),
  };
}

/** 映射已安装应用，供市场「已安装」标记。 */
export function mapBtInstalledAppToOnePanel(app: BtInstalledApp): OnePanelInstalledApp {
  const appKey = String(app.appname ?? "").trim();
  const version =
    String(app.version ?? "").trim() ||
    [app.m_version, app.s_version].filter(Boolean).join(".") ||
    undefined;
  return {
    id: Number(app.appid) || 0,
    name: String(app.service_name || appKey).trim(),
    appName: String(app.apptitle || appKey).trim(),
    appKey,
    appType: app.apptype,
    version,
    status: app.status,
    icon: resolveBtAppIcon(app.icon, appKey),
    path: app.path,
    container: app.container_id,
    serviceName: app.service_name,
    canUpdate: Boolean(app.canUpdate),
  };
}
