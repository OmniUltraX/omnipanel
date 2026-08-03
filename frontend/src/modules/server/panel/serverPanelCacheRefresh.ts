import {
  createBtPanelClient,
  mapBtAppToOnePanel,
  mapBtInstalledAppToOnePanel,
} from "../../../lib/btpanel";
import {
  createOnePanelClient,
  type OnePanelApp,
  type OnePanelInstalledApp,
} from "../../../lib/onepanel";
import type { ServerPanelCacheServerMeta, ServerPanelResourceCache } from "./serverPanelCache";
import { emptyServerPanelResourceCache } from "./serverPanelCache";

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export type ServerPanelAppsCacheSlice = Pick<
  ServerPanelResourceCache,
  "apps" | "installedApps" | "appsRefreshedAt" | "appsError"
>;

/** 从远端面板拉取网站 + 证书，写入缓存条目（不落盘，由 store 负责）。 */
export async function fetchServerPanelResources(
  server: ServerPanelCacheServerMeta,
): Promise<ServerPanelResourceCache> {
  const entry = emptyServerPanelResourceCache();
  try {
    if (server.serviceType === "1panel") {
      const client = createOnePanelClient(server.address, server.key, server.id);
      // 分开拉取：证书接口可能 gzip，避免一侧失败拖垮另一侧
      const [websitesResult, certificatesResult] = await Promise.allSettled([
        client.searchWebsites(),
        client.searchCertificates(),
      ]);
      const errors: string[] = [];
      if (websitesResult.status === "fulfilled") {
        entry.websites = websitesResult.value as Record<string, unknown>[];
      } else {
        errors.push(`网站：${formatError(websitesResult.reason)}`);
      }
      if (certificatesResult.status === "fulfilled") {
        entry.certificates = certificatesResult.value as Record<string, unknown>[];
      } else {
        errors.push(`证书：${formatError(certificatesResult.reason)}`);
      }
      if (errors.length > 0 && entry.websites.length === 0 && entry.certificates.length === 0) {
        throw new Error(errors.join("；"));
      }
      entry.error = errors.length > 0 ? errors.join("；") : null;
    } else if (server.serviceType === "bt") {
      const client = createBtPanelClient(server.address, server.key, server.id);
      // 证书接口在部分版本不稳定，避免拖垮网站列表
      const [siteResult, certificatesResult] = await Promise.allSettled([
        client.getWebsiteList({ limit: 100 }),
        client.getSslList(),
      ]);
      const errors: string[] = [];
      if (siteResult.status === "fulfilled") {
        entry.websites = siteResult.value.data as unknown as Record<string, unknown>[];
      } else {
        errors.push(`网站：${formatError(siteResult.reason)}`);
      }
      if (certificatesResult.status === "fulfilled") {
        entry.certificates = certificatesResult.value as Record<string, unknown>[];
      } else {
        errors.push(`证书：${formatError(certificatesResult.reason)}`);
      }
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

  if (server.serviceType === "bt") {
    try {
      const client = createBtPanelClient(server.address, server.key, server.id);
      const [marketResult, installedResult] = await Promise.allSettled([
        client.getApps({ p: 1, row: 200, query: "", force: 0, appType: "all" }),
        client.getInstalledApps({ p: 1, row: 200, query: "", appType: "all" }),
      ]);

      const errors: string[] = [];
      let apps: OnePanelApp[] = [];
      let installedApps: OnePanelInstalledApp[] = [];

      if (marketResult.status === "fulfilled") {
        apps = marketResult.value.items.map((item, index) => mapBtAppToOnePanel(item, index));
      } else {
        errors.push(`应用市场：${formatError(marketResult.reason)}`);
      }
      if (installedResult.status === "fulfilled") {
        installedApps = installedResult.value.items.map(mapBtInstalledAppToOnePanel);
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

  if (server.serviceType !== "1panel") {
    return {
      ...empty,
      appsError: "当前仅支持 1Panel / 宝塔应用市场",
    };
  }

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
