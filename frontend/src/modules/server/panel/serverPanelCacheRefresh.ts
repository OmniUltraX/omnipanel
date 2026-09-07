import {
  btDockerAppIconPath,
  isBtPanelAuthFailureMessage,
  type BtDockerApp,
  type BtInstalledApp,
  type BtSoftItem,
} from "../../../lib/btpanel";
import {
  type OnePanelApp,
  type OnePanelInstalledApp,
} from "../../../lib/onepanel";
import { stripHtmlToPlainText } from "../../../lib/stripHtmlToPlainText";
import type {
  ServerPanelCacheServerMeta,
  ServerPanelResourceCache,
  ServerPanelSiteGroup,
} from "./serverPanelCache";
import { emptyServerPanelResourceCache } from "./serverPanelCache";
import { websiteRowGroup, websiteRowGroupId } from "./serverResourceLabels";
import {
  getPanelDriver,
  panelConnectionCtx,
} from "../../../lib/panelDriverRegistry";
import { panelHasCapability } from "./panelPlugin";

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export type ServerPanelAppsCacheSlice = {
  /** 未拉到则省略，merge 时保留上次缓存 */
  apps?: OnePanelApp[];
  installedApps?: OnePanelInstalledApp[];
  appsRefreshedAt: number;
  appsError: string | null;
};

export function enrichWebsitesWithGroups(
  websites: Record<string, unknown>[],
  groups: ServerPanelSiteGroup[],
): Record<string, unknown>[] {
  const list = Array.isArray(websites) ? websites : [];
  const groupList = Array.isArray(groups) ? groups : [];
  if (list.length === 0) return list;
  const byId = new Map(groupList.map((g) => [g.id, g.name]));
  return list.map((row) => {
    if (websiteRowGroup(row) !== "—") return row;
    const groupId = websiteRowGroupId(row);
    if (groupId == null) return row;
    const name = byId.get(groupId);
    if (!name) return row;
    return { ...row, group: name, type_name: name };
  });
}

export function btInstalledToOnePanel(item: BtInstalledApp): OnePanelInstalledApp {
  return {
    id: Number(item.appid) || 0,
    name: item.service_name || item.apptitle || item.appname,
    appKey: item.appname,
    appName: item.apptitle || item.appname,
    status: item.status || (item.appstatus === 1 ? "Running" : "Stopped"),
    version: item.version || (item.m_version && item.s_version ? `${item.m_version}.${item.s_version}` : item.m_version),
  };
}

function pickBtVersionLabel(app: BtDockerApp): string | null {
  const versions = app.appversion;
  if (!Array.isArray(versions) || versions.length === 0) {
    return app.version?.trim() || null;
  }
  const first = versions[0];
  if (!first) return null;
  const m = String(first.m_version ?? "").trim();
  const sRaw = first.s_version;
  const s = Array.isArray(sRaw)
    ? String(sRaw[0] ?? "").trim()
    : String(sRaw ?? "").trim();
  if (m && s) return `${m}.${s}`;
  return m || s || null;
}

/** 将宝塔 Docker 商店条目适配为应用市场卡片模型。 */
export function btDockerAppToMarketApp(app: BtDockerApp): OnePanelApp {
  const key = (app.appname || "").trim();
  const versionLabel = pickBtVersionLabel(app);
  const rawIcon = String(app.icon ?? "").trim();
  // 仅保留 data/blob/base64 或相对路径标记；勿拼面板 http，WebView/安全入口下会失败
  let icon: string | undefined;
  if (rawIcon.startsWith("data:") || rawIcon.startsWith("blob:")) {
    icon = rawIcon;
  } else if (/^[A-Za-z0-9+/=]+$/.test(rawIcon) && rawIcon.length > 64) {
    icon = `data:image/png;base64,${rawIcon}`;
  } else if (key) {
    icon = btDockerAppIconPath(key);
  }
  const desc = stripHtmlToPlainText(app.appdesc);
  return {
    id: Number(app.appid) || 0,
    name: (app.apptitle || key || "—").trim(),
    key,
    type: app.apptype,
    icon,
    description: desc || undefined,
    shortDescZh: desc || undefined,
    installed: Boolean(app.installed),
    versions: versionLabel ? [versionLabel] : [],
    tags: app.apptype ? [{ key: app.apptype, name: app.apptype }] : [],
  };
}

function pickSoftInstallVersion(item: BtSoftItem): string | null {
  const versions = item.versions ?? [];
  const candidate =
    versions.find((v) => !v.setup && v.m_version) ??
    versions.find((v) => v.m_version) ??
    null;
  if (candidate?.m_version) return String(candidate.m_version).trim();
  const current = (item.version || "").trim();
  return current || null;
}

function normalizeThirdPartyAppRow(row: Record<string, unknown>): OnePanelApp {
  const tagsRaw = row.tags;
  const tags = Array.isArray(tagsRaw)
    ? tagsRaw
        .map((tag) => {
          if (typeof tag === "string" && tag.trim()) {
            return { key: tag.trim(), name: tag.trim() };
          }
          if (tag && typeof tag === "object" && !Array.isArray(tag)) {
            const item = tag as Record<string, unknown>;
            const key = String(item.key ?? item.name ?? "").trim();
            const name = String(item.name ?? item.key ?? "").trim();
            if (!key && !name) return null;
            return { key: key || name, name: name || key };
          }
          return null;
        })
        .filter((item): item is { key: string; name: string } => item != null)
    : undefined;
  return {
    id: Number(row.id) || 0,
    name: String(row.name ?? row.title ?? row.appName ?? "—"),
    key: String(row.key ?? row.appKey ?? row.name ?? ""),
    type: row.type != null ? String(row.type) : undefined,
    icon: typeof row.icon === "string" ? row.icon : undefined,
    description: row.description != null ? String(row.description) : undefined,
    shortDescZh: row.shortDescZh != null ? String(row.shortDescZh) : undefined,
    shortDescEn: row.shortDescEn != null ? String(row.shortDescEn) : undefined,
    installed: Boolean(row.installed),
    versions: Array.isArray(row.versions) ? row.versions.map(String) : undefined,
    tags,
  };
}

function normalizeThirdPartyInstalledAppRow(row: Record<string, unknown>): OnePanelInstalledApp {
  return {
    id: Number(row.id) || 0,
    name: String(row.name ?? row.appName ?? "—"),
    appName: row.appName != null ? String(row.appName) : undefined,
    appKey:
      row.appKey != null
        ? String(row.appKey)
        : row.key != null
          ? String(row.key)
          : undefined,
    appType:
      row.appType != null
        ? String(row.appType)
        : row.type != null
          ? String(row.type)
          : undefined,
    version: row.version != null ? String(row.version) : undefined,
    status: row.status != null ? String(row.status) : undefined,
    message: row.message != null ? String(row.message) : undefined,
    icon: typeof row.icon === "string" ? row.icon : undefined,
  };
}

function isAuthFailure(err: unknown): boolean {
  return isBtPanelAuthFailureMessage(formatError(err));
}

/** 将宝塔软件商店条目适配为应用市场卡片模型。 */
export function btSoftItemToMarketApp(
  item: BtSoftItem,
  typeTitleById?: Map<number, string>,
): OnePanelApp {
  const key = (item.name || "").trim();
  const typeTitle =
    item.type != null && typeTitleById ? typeTitleById.get(Number(item.type)) : undefined;
  const installVersion = pickSoftInstallVersion(item);
  // 宝塔 `ps` / `ps_en` 常带 HTML（如 description-line），卡片只展示纯文本
  const descZh = stripHtmlToPlainText(item.ps);
  const descEn = stripHtmlToPlainText(item.ps_en);
  return {
    id: Number(item.id) || 0,
    name: (item.title || key || "—").trim(),
    key,
    type: typeTitle || (item.type != null ? String(item.type) : undefined),
    icon: item.icon,
    description: descZh || undefined,
    shortDescZh: descZh || undefined,
    shortDescEn: descEn || undefined,
    installed: Boolean(item.setup),
    versions: installVersion ? [installVersion] : [],
    tags: typeTitle ? [{ key: String(item.type ?? typeTitle), name: typeTitle }] : [],
  };
}

/** 从远端面板拉取网站 + 证书 + 分组，写入缓存条目（不落盘，由 store 负责）。 */
export async function fetchServerPanelResources(
  server: ServerPanelCacheServerMeta,
): Promise<ServerPanelResourceCache> {
  const entry = emptyServerPanelResourceCache();
  try {
    const driver = getPanelDriver(server.serviceType);
    if (!driver) {
      entry.error = "当前面板未激活或没有 driver";
      entry.refreshedAt = Date.now();
      return entry;
    }
    const ctx = panelConnectionCtx(server);
    const errors: string[] = [];
    let websites: Record<string, unknown>[] = [];

    if (panelHasCapability(server.serviceType, "websites") && driver.listWebsites) {
      try {
        websites = await driver.listWebsites(ctx);
      } catch (err) {
        errors.push(`网站：${formatError(err)}`);
        if (isAuthFailure(err)) {
          entry.error = errors.join("；");
          entry.refreshedAt = Date.now();
          return entry;
        }
      }
    }
    if (panelHasCapability(server.serviceType, "certificates") && driver.listCertificates) {
      try {
        entry.certificates = await driver.listCertificates(ctx);
      } catch (err) {
        errors.push(`证书：${formatError(err)}`);
        if (isAuthFailure(err)) {
          entry.websites = websites;
          entry.error = errors.join("；");
          entry.refreshedAt = Date.now();
          return entry;
        }
      }
    }
    if (driver.listSiteGroups) {
      try {
        entry.siteGroups = await driver.listSiteGroups(ctx);
      } catch (err) {
        errors.push(`分组：${formatError(err)}`);
      }
    }
    entry.websites = enrichWebsitesWithGroups(websites, entry.siteGroups);
    if (errors.length > 0 && entry.websites.length === 0 && entry.certificates.length === 0) {
      throw new Error(errors.join("；"));
    }
    entry.error = errors.length > 0 ? errors.join("；") : null;
    entry.refreshedAt = Date.now();
    return entry;
  } catch (err) {
    entry.refreshedAt = Date.now();
    entry.error = formatError(err);
    return entry;
  }
}

/** 从远端拉取应用市场 + 已安装列表（不落盘，由 store 负责）。 */
export async function fetchServerPanelApps(
  server: ServerPanelCacheServerMeta,
): Promise<ServerPanelAppsCacheSlice> {
  const empty: ServerPanelAppsCacheSlice = {
    appsRefreshedAt: Date.now(),
    appsError: null,
  };

  const driver = getPanelDriver(server.serviceType);
  if (!driver || (!driver.listApps && !driver.listInstalledApps)) {
    return {
      ...empty,
      appsError: "当前面板类型不支持应用市场",
    };
  }

  try {
    const ctx = panelConnectionCtx(server);
    const errors: string[] = [];
    let apps: OnePanelApp[] | undefined;
    let installedApps: OnePanelInstalledApp[] | undefined;

    if (driver.listApps) {
      try {
        apps = (await driver.listApps(ctx)).map(normalizeThirdPartyAppRow);
      } catch (err) {
        errors.push(`应用市场：${formatError(err)}`);
        if (isAuthFailure(err)) {
          return {
            ...(apps && apps.length > 0 ? { apps } : {}),
            appsRefreshedAt: Date.now(),
            appsError: errors.join("；"),
          };
        }
      }
    }
    if (driver.listInstalledApps) {
      try {
        installedApps = (await driver.listInstalledApps(ctx)).map(
          normalizeThirdPartyInstalledAppRow,
        );
      } catch (err) {
        errors.push(`已安装：${formatError(err)}`);
        if (isAuthFailure(err)) {
          return {
            ...(apps && apps.length > 0 ? { apps } : {}),
            ...(installedApps && installedApps.length > 0 ? { installedApps } : {}),
            appsRefreshedAt: Date.now(),
            appsError: errors.join("；"),
          };
        }
      }
    }

    if (errors.length > 0 && apps == null && installedApps == null) {
      throw new Error(errors.join("；"));
    }

    return {
      apps,
      installedApps,
      appsRefreshedAt: Date.now(),
      appsError: errors.length > 0 ? errors.join("；") : null,
    };
  } catch (err) {
    return {
      ...empty,
      appsError: formatError(err),
    };
  }
}

