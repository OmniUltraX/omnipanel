import {
  createBtPanelClient,
  fetchBtMergedWebsiteList,
  parseBtDiskUsageList,
  type BtAddSiteParams,
} from "../../../frontend/src/lib/btpanel";
import {
  asRecordList,
  normalizePanelDatabaseRow,
  type PanelConnectionCtx,
  type PanelCreateDatabaseInput,
  type PanelCreateInput,
  type PanelDeleteDatabaseInput,
  type PanelDriver,
} from "../../../frontend/src/lib/panelDriverRegistry";
import {
  btDockerAppToMarketApp,
  btInstalledToOnePanel,
  btSoftItemToMarketApp,
} from "../../../frontend/src/modules/server/panel/serverPanelCacheRefresh";

function clientOf(ctx: PanelConnectionCtx) {
  return createBtPanelClient(ctx.address, ctx.apiKey, ctx.connectionId);
}

function requireSiteName(siteName: string | undefined): string {
  const name = (siteName ?? "").trim();
  if (!name) throw new Error("缺少网站名称");
  return name;
}

export const btPanelDriver: PanelDriver = {
  remoteWebsiteFilter: true,
  async testConnection(ctx) {
    const info = await clientOf(ctx).getSystemTotal();
    return { ok: true, hostname: info.system || info.version || ctx.address };
  },
  async listDatabases(ctx) {
    const result = await clientOf(ctx).getDatabaseList({ limit: 100 });
    return asRecordList(result.data).map((row) => normalizePanelDatabaseRow(row));
  },
  async createDatabase(ctx: PanelConnectionCtx, input: PanelCreateDatabaseInput) {
    await clientOf(ctx).addDatabase({
      name: input.name,
      dbUser: input.dbUser,
      password: input.password,
      address: input.address || "127.0.0.1",
      codeing: input.charset || "utf8mb4",
      ps: input.remark ?? "",
    });
  },
  async deleteDatabase(ctx: PanelConnectionCtx, input: PanelDeleteDatabaseInput) {
    await clientOf(ctx).deleteDatabase({
      id: input.id,
      name: input.name,
      dbUser: input.dbUser,
    });
  },
  async listWebsites(ctx, query) {
    const typeId =
      query?.groupId && /^-?\d+$/.test(query.groupId) ? Number(query.groupId) : -1;
    return fetchBtMergedWebsiteList(clientOf(ctx), {
      limit: 200,
      type: typeId,
      search: query?.search || undefined,
    });
  },
  async createWebsite(ctx, input: PanelCreateInput) {
    await clientOf(ctx).addSite(input as unknown as BtAddSiteParams);
  },
  async setWebsiteStatus(ctx, input) {
    const name = requireSiteName(input.siteName);
    const client = clientOf(ctx);
    if (input.operate === "stop") {
      await client.stopWebsite(input.id, name);
    } else {
      await client.startWebsite(input.id, name);
    }
  },
  async deleteWebsite(ctx, input) {
    await clientOf(ctx).deleteWebsite(input.id, requireSiteName(input.siteName), { path: true });
  },
  async listCertificates(ctx) {
    return asRecordList(await clientOf(ctx).getSslList());
  },
  async createCertificate() {
    // 第一方走 CreateCertificateDialog。
  },
  async deleteCertificate(ctx, input) {
    await clientOf(ctx).removeSslCert({
      id: input.id ?? undefined,
      hash: input.hash ?? undefined,
    });
  },
  async listCronjobs(ctx) {
    const result = await clientOf(ctx).getCronList({ limit: 100 });
    return asRecordList(result.data);
  },
  async createCronjob() {
    // 第一方走 CreateCronjobDialog。
  },
  async setCronjobStatus(ctx, input) {
    await clientOf(ctx).setCronStatus(input.id);
  },
  async runCronjob(ctx, input) {
    await clientOf(ctx).startCronTask(input.id);
  },
  async deleteCronjob(ctx, input) {
    await clientOf(ctx).deleteCrontab(input.id);
  },
  async listApps(ctx) {
    const client = clientOf(ctx);
    const apps: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    const soft = await client.getSoftList({ p: 1, type: 0, query: "", force: 0, row: 300 });
    const typeMap = new Map(soft.types.map((t) => [t.id, t.title]));
    for (const item of soft.items) {
      const mapped = btSoftItemToMarketApp(item, typeMap);
      const key = mapped.key.toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      apps.push(mapped as unknown as Record<string, unknown>);
    }
    try {
      const dockerApps = await client.getDockerApps();
      for (const item of dockerApps.items) {
        const mapped = btDockerAppToMarketApp(item);
        const key = mapped.key.toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        apps.push(mapped as unknown as Record<string, unknown>);
      }
    } catch {
      // Docker 商店未初始化时忽略
    }
    return apps;
  },
  async listInstalledApps(ctx) {
    const client = clientOf(ctx);
    const installed: Record<string, unknown>[] = [];
    const soft = await client.getSoftList({ p: 1, type: 0, query: "", force: 0, row: 300 });
    const typeMap = new Map(soft.types.map((t) => [t.id, t.title]));
    for (const item of soft.items) {
      const mapped = btSoftItemToMarketApp(item, typeMap);
      if (!mapped.installed) continue;
      installed.push({
        id: mapped.id,
        name: mapped.name,
        appKey: mapped.key,
        appName: mapped.name,
        version: mapped.versions?.[0],
        status: "Installed",
      });
    }
    try {
      const apps = await client.getInstalledApps({ p: 1, row: 500, appType: "all" });
      for (const item of apps.items) {
        installed.push(btInstalledToOnePanel(item) as unknown as Record<string, unknown>);
      }
    } catch {
      // 已安装列表失败时保留软件商店已安装项
    }
    return installed;
  },
  async getDashboard(ctx) {
    const bt = clientOf(ctx);
    const total = await bt.getSystemTotal();
    const network = await bt.getNetwork();
    const disks = await bt.getDiskInfo();
    const memPct = total.memTotal ? ((total.memRealUsed ?? 0) / total.memTotal) * 100 : 0;
    const cpuPct = network.cpu?.[0] ?? total.cpuRealUsed ?? 0;
    const diskUsages = parseBtDiskUsageList(Array.isArray(disks) ? disks : []);
    return {
      hostname: total.system,
      os: total.system,
      platformVersion: total.version,
      cpuCores: total.cpuNum,
      currentInfo: {
        cpuUsedPercent: cpuPct,
        memoryTotal: (total.memTotal ?? 0) * 1024 * 1024,
        memoryUsed: (total.memRealUsed ?? 0) * 1024 * 1024,
        memoryAvailable: ((total.memTotal ?? 0) - (total.memRealUsed ?? 0)) * 1024 * 1024,
        memoryUsedPercent: memPct,
        load1: network.load?.one,
        load5: network.load?.five,
        load15: network.load?.fifteen,
        diskData: diskUsages.map((d) => ({
          path: d.path,
          total: d.total,
          used: d.used,
          free: d.free,
          usedPercent: d.usedPercent,
        })),
      },
    };
  },
  async installApp(ctx, input) {
    const client = clientOf(ctx);
    const key = (input.key || "").trim();
    const version = (input.version || "").trim();
    if (version) {
      await client.installSoft(key, version);
      return;
    }
    const market = await client.getDockerApps();
    const def = market.items.find(
      (item) => (item.appname || "").trim().toLowerCase() === key.toLowerCase(),
    );
    if (!def) {
      throw new Error("未找到应用定义");
    }
    await client.installDockerAppFromDefinition(def);
  },
  async syncApps(ctx) {
    const client = clientOf(ctx);
    await client.getSoftList({ p: 1, type: 0, query: "", force: 1, row: 50 });
    try {
      await client.getDockerApps();
      return { dockerAvailable: true };
    } catch {
      return { dockerAvailable: false };
    }
  },
  async getAppIconDataUrl(ctx, input) {
    const key = input.key.trim();
    if (!key) return null;
    return clientOf(ctx).getAppIconDataUrl(key, input.icon);
  },
  async listSiteGroups(ctx) {
    const types = await clientOf(ctx).getSiteTypes();
    return (Array.isArray(types) ? types : [])
      .map((g) => ({ id: String(g.id), name: (g.name || "").trim() }))
      .filter((g) => g.name);
  },
};
