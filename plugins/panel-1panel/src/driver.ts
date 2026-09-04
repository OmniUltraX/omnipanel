import { createOnePanelClient } from "../../../frontend/src/lib/onepanel";
import type { OnePanelWebsiteCreate } from "../../../frontend/src/lib/onepanel";
import {
  asRecordList,
  normalizePanelDatabaseRow,
  type PanelConnectionCtx,
  type PanelCreateDatabaseInput,
  type PanelCreateInput,
  type PanelDeleteDatabaseInput,
  type PanelDriver,
} from "../../../frontend/src/lib/panelDriverRegistry";

function clientOf(ctx: PanelConnectionCtx) {
  return createOnePanelClient(ctx.address, ctx.apiKey, ctx.connectionId, ctx.panelUser);
}

function defaultParamsFromDetail(params: unknown): Record<string, unknown> {
  if (!params || typeof params !== "object") return {};
  const obj = params as Record<string, unknown>;
  const fields = obj.formFields ?? obj.fields;
  if (!Array.isArray(fields)) return {};
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (!field || typeof field !== "object") continue;
    const f = field as Record<string, unknown>;
    const key = String(f.envKey ?? f.key ?? "").trim();
    if (!key) continue;
    if ("default" in f && f.default !== undefined) {
      out[key] = f.default;
    } else if ("value" in f && f.value !== undefined) {
      out[key] = f.value;
    }
  }
  return out;
}

export const onePanelDriver: PanelDriver = {
  async testConnection(ctx) {
    const info = await clientOf(ctx).getDeviceBase();
    return { ok: true, hostname: info.hostname || ctx.address };
  },
  async listDatabases(ctx) {
    const items = await clientOf(ctx).searchDatabases();
    return asRecordList(items).map((row) => normalizePanelDatabaseRow(row));
  },
  async createDatabase(ctx: PanelConnectionCtx, input: PanelCreateDatabaseInput) {
    await clientOf(ctx).createDatabase({
      name: input.name,
      username: input.dbUser,
      password: input.password,
      permission: input.address || "127.0.0.1",
      format: input.charset || "utf8mb4",
      description: input.remark ?? "",
    });
  },
  async deleteDatabase(ctx: PanelConnectionCtx, input: PanelDeleteDatabaseInput) {
    await clientOf(ctx).deleteDatabase({
      id: input.id,
      name: input.name,
      type: input.type,
    });
  },
  async listWebsites(ctx) {
    return asRecordList(await clientOf(ctx).searchWebsites());
  },
  async createWebsite(ctx, input: PanelCreateInput) {
    await clientOf(ctx).createWebsite(input as unknown as OnePanelWebsiteCreate);
  },
  async setWebsiteStatus(ctx, input) {
    await clientOf(ctx).operateWebsite(input.id, input.operate);
  },
  async deleteWebsite(ctx, input) {
    await clientOf(ctx).deleteWebsite(input.id);
  },
  async listCertificates(ctx) {
    return asRecordList(await clientOf(ctx).searchCertificates());
  },
  async createCertificate() {
    // 第一方走 CreateCertificateDialog；方法存在仅为能力开门。
  },
  async deleteCertificate(ctx, input) {
    if (input.id == null) return;
    await clientOf(ctx).deleteWebsiteSsl([input.id]);
  },
  async downloadCertificate(ctx, input) {
    return clientOf(ctx).downloadWebsiteSsl(input.id);
  },
  async updateCertificate(ctx, input) {
    await clientOf(ctx).updateWebsiteSsl({
      id: input.id,
      primaryDomain: input.primaryDomain,
      provider: input.provider,
      autoRenew: input.autoRenew,
      description: input.description,
    });
  },
  async listCronjobs(ctx) {
    return asRecordList(await clientOf(ctx).searchCronjobs());
  },
  async createCronjob() {
    // 第一方走 CreateCronjobDialog。
  },
  async setCronjobStatus(ctx, input) {
    await clientOf(ctx).updateCronjobStatus(input.id, input.enabled ? "Enable" : "Disable");
  },
  async runCronjob(ctx, input) {
    await clientOf(ctx).handleCronjobOnce(input.id);
  },
  async deleteCronjob(ctx, input) {
    await clientOf(ctx).deleteCronjobs([input.id]);
  },
  async listApps(ctx) {
    const result = await clientOf(ctx).searchApps({ page: 1, pageSize: 200, name: "" });
    return asRecordList(result.items);
  },
  async listInstalledApps(ctx) {
    const result = await clientOf(ctx).searchInstalledApps({ page: 1, pageSize: 500, all: true });
    return asRecordList(result.items);
  },
  async getDashboard(ctx, query) {
    const client = clientOf(ctx);
    if (query?.currentOnly) {
      const current = await client.getDashboardCurrent();
      return { currentInfo: current };
    }
    const base = await client.getDashboardBase().catch(() => client.getOsInfo());
    const current = await client.getDashboardCurrent().catch(() => base.currentInfo);
    return { ...base, currentInfo: current ?? base.currentInfo };
  },
  async installApp(ctx, input) {
    const client = clientOf(ctx);
    const key = (input.key || input.name || "").trim();
    if (!key) throw new Error("应用 key 不能为空");
    let versions: string[] = [];
    let appId = input.id ?? 0;
    let appType = "runtime";
    const detail = await client.getApp(key);
    versions = detail.versions ?? versions;
    appId = detail.id || appId;
    appType = detail.type || appType;
    const version = (input.version || "").trim() || versions[0] || "";
    if (!version || !appId) {
      throw new Error("应用没有可安装版本");
    }
    const appDetail = await client.getAppDetail(appId, version, appType);
    if (!appDetail.id) {
      throw new Error("应用详情无效");
    }
    await client.installApp({
      appDetailId: appDetail.id,
      name: key,
      params: defaultParamsFromDetail(appDetail.params),
      pullImage: true,
      allowPort: true,
    });
  },
  async syncApps(ctx) {
    await clientOf(ctx).syncAppsRemote();
  },
  async getAppIconDataUrl(ctx, input) {
    const key = input.key.trim();
    if (!key) return null;
    return clientOf(ctx).getAppIconDataUrl(key);
  },
  async getInstalledAppParams(ctx, input) {
    return clientOf(ctx).getInstalledAppParams(input.id);
  },
  async listSiteGroups(ctx) {
    const groups = await clientOf(ctx).searchGroups("website");
    return groups
      .map((g) => ({ id: String(g.id), name: g.name.trim() }))
      .filter((g) => g.id && g.name);
  },
};
