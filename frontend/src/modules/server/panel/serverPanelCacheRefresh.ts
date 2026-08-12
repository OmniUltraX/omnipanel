import {
  btDockerAppIconPath,
  createBtPanelClient,
  isBtPanelAuthFailureMessage,
  type BtDockerApp,
  type BtInstalledApp,
  type BtSoftItem,
} from "../../../lib/btpanel";
import {
  createOnePanelClient,
  type OnePanelApp,
  type OnePanelInstalledApp,
} from "../../../lib/onepanel";
import type {
  ServerPanelCacheServerMeta,
  ServerPanelResourceCache,
  ServerPanelSiteGroup,
} from "./serverPanelCache";
import { emptyServerPanelResourceCache } from "./serverPanelCache";
import { websiteRowGroup, websiteRowGroupId } from "./serverResourceLabels";

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export type ServerPanelAppsCacheSlice = Pick<
  ServerPanelResourceCache,
  "apps" | "installedApps" | "appsRefreshedAt" | "appsError"
>;

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

function btInstalledToOnePanel(item: BtInstalledApp): OnePanelInstalledApp {
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
  return {
    id: Number(app.appid) || 0,
    name: (app.apptitle || key || "—").trim(),
    key,
    type: app.apptype,
    icon,
    description: app.appdesc,
    shortDescZh: app.appdesc,
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

/** 将宝塔软件商店条目适配为应用市场卡片模型。 */
export function btSoftItemToMarketApp(
  item: BtSoftItem,
  typeTitleById?: Map<number, string>,
): OnePanelApp {
  const key = (item.name || "").trim();
  const typeTitle =
    item.type != null && typeTitleById ? typeTitleById.get(Number(item.type)) : undefined;
  const installVersion = pickSoftInstallVersion(item);
  return {
    id: Number(item.id) || 0,
    name: (item.title || key || "—").trim(),
    key,
    type: typeTitle || (item.type != null ? String(item.type) : undefined),
    icon: item.icon,
    description: item.ps,
    shortDescZh: item.ps,
    shortDescEn: item.ps_en,
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
    if (server.serviceType === "1panel") {
      const client = createOnePanelClient(server.address, server.key, server.id);
      const [websitesResult, certificatesResult, groupsResult] = await Promise.allSettled([
        client.searchWebsites(),
        client.searchCertificates(),
        client.searchGroups("website"),
      ]);
      const errors: string[] = [];
      let websites: Record<string, unknown>[] = [];
      if (websitesResult.status === "fulfilled") {
        const raw = websitesResult.value as unknown;
        websites = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
      } else {
        errors.push(`网站：${formatError(websitesResult.reason)}`);
      }
      if (certificatesResult.status === "fulfilled") {
        const raw = certificatesResult.value as unknown;
        entry.certificates = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
      } else {
        errors.push(`证书：${formatError(certificatesResult.reason)}`);
      }
      if (groupsResult.status === "fulfilled") {
        const raw = groupsResult.value;
        entry.siteGroups = (Array.isArray(raw) ? raw : [])
          .map((g) => ({ id: String(g.id), name: g.name.trim() }))
          .filter((g) => g.id && g.name);
      }
      entry.websites = enrichWebsitesWithGroups(websites, entry.siteGroups);
      if (errors.length > 0 && entry.websites.length === 0 && entry.certificates.length === 0) {
        throw new Error(errors.join("；"));
      }
      entry.error = errors.length > 0 ? errors.join("；") : null;
    } else if (server.serviceType === "bt") {
      const client = createBtPanelClient(server.address, server.key, server.id);
      // 串行：任一鉴权/封禁失败立刻停，避免 Promise.all 并发把验证失败次数打满
      const errors: string[] = [];
      let websites: Record<string, unknown>[] = [];
      try {
        const site = await client.getWebsiteList({ limit: 200, type: -1 });
        const raw = site.data as unknown;
        websites = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
      } catch (err) {
        errors.push(`网站：${formatError(err)}`);
        if (isBtPanelAuthFailureMessage(formatError(err))) {
          entry.error = errors.join("；");
          entry.refreshedAt = Date.now();
          return entry;
        }
      }
      try {
        const certificates = await client.getSslList();
        const raw = certificates as unknown;
        entry.certificates = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
      } catch (err) {
        errors.push(`证书：${formatError(err)}`);
        if (isBtPanelAuthFailureMessage(formatError(err))) {
          entry.websites = websites;
          entry.error = errors.join("；");
          entry.refreshedAt = Date.now();
          return entry;
        }
      }
      try {
        const types = await client.getSiteTypes();
        const raw = types;
        entry.siteGroups = (Array.isArray(raw) ? raw : [])
          .map((g) => ({ id: String(g.id), name: (g.name || "").trim() }))
          .filter((g) => g.name);
      } catch (err) {
        errors.push(`分组：${formatError(err)}`);
      }
      entry.websites = enrichWebsitesWithGroups(websites, entry.siteGroups);
      if (errors.length > 0 && entry.websites.length === 0 && entry.certificates.length === 0) {
        throw new Error(errors.join("；"));
      }
      entry.error = errors.length > 0 ? errors.join("；") : null;
    }
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
    apps: [],
    installedApps: [],
    appsRefreshedAt: Date.now(),
    appsError: null,
  };

  if (server.serviceType === "1panel") {
    try {
      const client = createOnePanelClient(server.address, server.key, server.id);
      const [marketResult, installedResult] = await Promise.allSettled([
        client.searchApps({ page: 1, pageSize: 200, name: "" }),
        client.searchInstalledApps({ page: 1, pageSize: 500, all: true }),
      ]);

      const errors: string[] = [];
      let apps: OnePanelApp[] = [];
      let installedApps: OnePanelInstalledApp[] = [];

      if (marketResult.status === "fulfilled") {
        apps = marketResult.value.items;
      } else {
        errors.push(`应用市场：${formatError(marketResult.reason)}`);
      }
      if (installedResult.status === "fulfilled") {
        installedApps = installedResult.value.items;
      } else {
        errors.push(`已安装：${formatError(installedResult.reason)}`);
      }

      if (errors.length > 0 && apps.length === 0 && installedApps.length === 0) {
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

  if (server.serviceType === "bt") {
    try {
      const client = createBtPanelClient(server.address, server.key, server.id);
      // 串行：鉴权/封禁失败立刻停，避免 3 路并发打满宝塔验证计数
      const errors: string[] = [];
      let apps: OnePanelApp[] = [];
      let installedApps: OnePanelInstalledApp[] = [];
      const seen = new Set<string>();
      let softOk = false;

      try {
        const soft = await client.getSoftList({ p: 1, type: 0, query: "", force: 0, row: 300 });
        softOk = true;
        const typeMap = new Map(soft.types.map((t) => [t.id, t.title]));
        for (const item of soft.items) {
          const mapped = btSoftItemToMarketApp(item, typeMap);
          const key = mapped.key.toLowerCase();
          if (!key || seen.has(key)) continue;
          seen.add(key);
          apps.push(mapped);
          if (mapped.installed) {
            installedApps.push({
              id: mapped.id,
              name: mapped.name,
              appKey: mapped.key,
              appName: mapped.name,
              version: mapped.versions?.[0],
              status: "Installed",
            });
          }
        }
      } catch (err) {
        errors.push(`软件商店：${formatError(err)}`);
        if (isBtPanelAuthFailureMessage(formatError(err))) {
          return {
            apps,
            installedApps,
            appsRefreshedAt: Date.now(),
            appsError: errors.join("；"),
          };
        }
      }

      try {
        const installed = await client.getInstalledApps({ p: 1, row: 500, appType: "all" });
        for (const item of installed.items) {
          installedApps.push(btInstalledToOnePanel(item));
        }
      } catch (err) {
        errors.push(`已安装：${formatError(err)}`);
        if (isBtPanelAuthFailureMessage(formatError(err))) {
          return {
            apps,
            installedApps,
            appsRefreshedAt: Date.now(),
            appsError: errors.join("；"),
          };
        }
      }

      try {
        const dockerApps = await client.getDockerApps();
        const installedKeys = new Set(
          installedApps
            .map((item) => (item.appKey || item.name || "").trim().toLowerCase())
            .filter(Boolean),
        );
        for (const item of dockerApps.items) {
          const mapped = btDockerAppToMarketApp(item);
          const key = mapped.key.toLowerCase();
          if (!key || seen.has(key)) continue;
          seen.add(key);
          if (installedKeys.has(key)) mapped.installed = true;
          apps.push(mapped);
        }
      } catch (err) {
        // Docker 商店未初始化时忽略；仅当软商店也失败时记错误
        if (!softOk) {
          errors.push(`Docker 应用：${formatError(err)}`);
        }
      }

      if (errors.length > 0 && apps.length === 0 && installedApps.length === 0) {
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

  return {
    ...empty,
    appsError: "当前面板类型不支持应用市场",
  };
}
