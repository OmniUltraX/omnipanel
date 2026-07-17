import { createBtPanelClient } from "../../../lib/btpanel";
import { createOnePanelClient } from "../../../lib/onepanel";
import type { ServerPanelCacheServerMeta, ServerPanelResourceCache } from "./serverPanelCache";
import { emptyServerPanelResourceCache } from "./serverPanelCache";

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** 从远端面板拉取网站 + 证书，写入缓存条目（不落盘，由 store 负责）。 */
export async function fetchServerPanelResources(
  server: ServerPanelCacheServerMeta,
): Promise<ServerPanelResourceCache> {
  const entry = emptyServerPanelResourceCache();
  try {
    if (server.serviceType === "1panel") {
      const client = createOnePanelClient(server.address, server.key);
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
      const client = createBtPanelClient(server.address, server.key);
      const [siteResult, certificates] = await Promise.all([
        client.getWebsiteList({ limit: 100 }),
        client.getSslList(),
      ]);
      entry.websites = siteResult.data as unknown as Record<string, unknown>[];
      entry.certificates = certificates as Record<string, unknown>[];
      entry.error = null;
    }
    entry.refreshedAt = Date.now();
    return entry;
  } catch (err) {
    entry.refreshedAt = Date.now();
    entry.error = formatError(err);
    return entry;
  }
}
