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
      const [websites, certificates] = await Promise.all([
        client.searchWebsites(),
        client.searchCertificates(),
      ]);
      entry.websites = websites as Record<string, unknown>[];
      entry.certificates = certificates as Record<string, unknown>[];
    } else if (server.serviceType === "bt") {
      const client = createBtPanelClient(server.address, server.key);
      const [siteResult, certificates] = await Promise.all([
        client.getWebsiteList({ limit: 100 }),
        client.getSslList(),
      ]);
      entry.websites = siteResult.data as unknown as Record<string, unknown>[];
      entry.certificates = certificates as Record<string, unknown>[];
    }
    entry.refreshedAt = Date.now();
    entry.error = null;
    return entry;
  } catch (err) {
    entry.refreshedAt = Date.now();
    entry.error = formatError(err);
    return entry;
  }
}
