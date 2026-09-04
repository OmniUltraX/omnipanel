import { isPluginActivated, usePluginRuntimeStore } from "../stores/pluginRuntimeStore";
import {
  canonicalPanelPluginId,
  PLUGIN_ID_PANEL_1PANEL,
  PLUGIN_ID_PANEL_BT,
} from "../modules/server/panel/panelPlugin";
import { getPluginManifest } from "./pluginManifests";
import { commands } from "../ipc/bindings";
import { unwrapCommand } from "../ipc/result";

/** 与 plugin.json `methods[].name` 对齐的面板 L2 方法。 */
export const PANEL_L2_METHODS = [
  "testConnection",
  "listDatabases",
  "createDatabase",
  "deleteDatabase",
  "listWebsites",
  "setWebsiteStatus",
  "deleteWebsite",
  "listCertificates",
  "deleteCertificate",
  "listCronjobs",
  "setCronjobStatus",
  "runCronjob",
  "deleteCronjob",
  "listApps",
  "listInstalledApps",
  "createWebsite",
  "createCertificate",
  "createCronjob",
  "getDashboard",
  "installApp",
  "uninstallApp",
] as const;

export type PanelL2Method = (typeof PANEL_L2_METHODS)[number];

export type PanelConnectionCtx = {
  address: string;
  apiKey: string;
  connectionId: string;
  panelUser?: string;
};

export type PanelDatabaseItem = {
  id: number | null;
  name: string;
  user: string;
  type: string;
  remark: string;
  raw: Record<string, unknown>;
};

export type PanelCreateDatabaseInput = {
  name: string;
  dbUser: string;
  password: string;
  address?: string;
  charset?: string;
  remark?: string;
};

export type PanelDeleteDatabaseInput = {
  id: number;
  name: string;
  dbUser: string;
  type?: string;
};

export type PanelWebsiteStatusInput = {
  id: number;
  siteName?: string;
  operate: "start" | "stop";
};

export type PanelWebsiteDeleteInput = {
  id: number;
  siteName?: string;
};

export type PanelWebsiteListQuery = {
  search?: string;
  groupId?: string;
};

export type PanelCertificateDeleteInput = {
  id?: number;
  hash?: string;
};

export type PanelCronjobIdInput = {
  id: number;
};

export type PanelCronjobStatusInput = {
  id: number;
  enabled: boolean;
};

export type PanelCreateInput = Record<string, unknown>;

export type PanelAppActionInput = {
  id?: number;
  key?: string;
  name?: string;
  version?: string;
};

export type PanelDashboardQuery = {
  currentOnly?: boolean;
};

export type PanelTestConnectionResult = boolean | { ok: boolean; hostname?: string };

export type PanelSyncAppsResult = void | { dockerAvailable?: boolean };

export type PanelSiteGroup = {
  id: string;
  name: string;
};

export type PanelDriver = {
  testConnection?: (ctx: PanelConnectionCtx) => Promise<PanelTestConnectionResult>;
  listDatabases: (ctx: PanelConnectionCtx) => Promise<PanelDatabaseItem[]>;
  createDatabase?: (ctx: PanelConnectionCtx, input: PanelCreateDatabaseInput) => Promise<void>;
  deleteDatabase?: (ctx: PanelConnectionCtx, input: PanelDeleteDatabaseInput) => Promise<void>;
  listWebsites?: (
    ctx: PanelConnectionCtx,
    query?: PanelWebsiteListQuery,
  ) => Promise<Record<string, unknown>[]>;
  /** 为 true 时 Host 在搜索/分组变化时带 query 重拉 listWebsites。 */
  remoteWebsiteFilter?: boolean;
  createWebsite?: (ctx: PanelConnectionCtx, input: PanelCreateInput) => Promise<void>;
  setWebsiteStatus?: (ctx: PanelConnectionCtx, input: PanelWebsiteStatusInput) => Promise<void>;
  deleteWebsite?: (ctx: PanelConnectionCtx, input: PanelWebsiteDeleteInput) => Promise<void>;
  listCertificates?: (ctx: PanelConnectionCtx) => Promise<Record<string, unknown>[]>;
  createCertificate?: (ctx: PanelConnectionCtx, input: PanelCreateInput) => Promise<void>;
  deleteCertificate?: (ctx: PanelConnectionCtx, input: PanelCertificateDeleteInput) => Promise<void>;
  downloadCertificate?: (
    ctx: PanelConnectionCtx,
    input: { id: number },
  ) => Promise<{ filename: string; bytes: Uint8Array }>;
  updateCertificate?: (
    ctx: PanelConnectionCtx,
    input: {
      id: number;
      primaryDomain: string;
      provider: string;
      autoRenew: boolean;
      description?: string;
    },
  ) => Promise<void>;
  listCronjobs?: (ctx: PanelConnectionCtx) => Promise<Record<string, unknown>[]>;
  createCronjob?: (ctx: PanelConnectionCtx, input: PanelCreateInput) => Promise<void>;
  setCronjobStatus?: (ctx: PanelConnectionCtx, input: PanelCronjobStatusInput) => Promise<void>;
  runCronjob?: (ctx: PanelConnectionCtx, input: PanelCronjobIdInput) => Promise<void>;
  deleteCronjob?: (ctx: PanelConnectionCtx, input: PanelCronjobIdInput) => Promise<void>;
  listApps?: (ctx: PanelConnectionCtx) => Promise<Record<string, unknown>[]>;
  listInstalledApps?: (ctx: PanelConnectionCtx) => Promise<Record<string, unknown>[]>;
  getDashboard?: (ctx: PanelConnectionCtx, query?: PanelDashboardQuery) => Promise<unknown>;
  installApp?: (ctx: PanelConnectionCtx, input: PanelAppActionInput) => Promise<void>;
  uninstallApp?: (ctx: PanelConnectionCtx, input: PanelAppActionInput) => Promise<void>;
  syncApps?: (ctx: PanelConnectionCtx) => Promise<PanelSyncAppsResult>;
  getAppIconDataUrl?: (
    ctx: PanelConnectionCtx,
    input: { key: string; icon?: string },
  ) => Promise<string | null>;
  getInstalledAppParams?: (
    ctx: PanelConnectionCtx,
    input: { id: number },
  ) => Promise<unknown>;
  listSiteGroups?: (ctx: PanelConnectionCtx) => Promise<PanelSiteGroup[]>;
};

function ctxPayload(
  ctx: PanelConnectionCtx,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    address: ctx.address,
    apiKey: ctx.apiKey,
    connectionId: ctx.connectionId,
    ...(ctx.panelUser ? { panelUser: ctx.panelUser } : {}),
    ...extra,
  };
}

/**
 * Host 注入面板主密钥：连接存盘后 `ServerEntry.key` 恒为空，
 * 密钥在 `panel-key-{id}`，插件 vault 读不到。与 Cloud 注入 AK 对齐。
 */
export async function injectPanelApiKey(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const apiKey = typeof args.apiKey === "string" ? args.apiKey.trim() : "";
  const connectionId = typeof args.connectionId === "string" ? args.connectionId.trim() : "";
  if (apiKey || !connectionId) {
    return apiKey ? { ...args, apiKey } : args;
  }
  try {
    const fromVault = (
      await unwrapCommand(commands.panelResolveApiKey(connectionId), { quiet: true })
    ).trim();
    return fromVault ? { ...args, apiKey: fromVault } : args;
  } catch {
    return args;
  }
}

/** 通过 plugin_invoke 调用第三方 panel L2 方法。 */
export async function invokePanelMethod<T = unknown>(
  pluginId: string,
  method: PanelL2Method,
  args: Record<string, unknown>,
): Promise<T> {
  const payload = await injectPanelApiKey(args);
  return (await unwrapCommand(commands.pluginInvoke(pluginId, method, payload as never))) as T;
}

async function invokePanelList(
  pluginId: string,
  method: PanelL2Method,
  ctx: PanelConnectionCtx,
  extra?: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  const res = await invokePanelMethod<
    { items: Record<string, unknown>[] } | Record<string, unknown>[]
  >(pluginId, method, ctxPayload(ctx, extra));
  const list = Array.isArray(res) ? res : res.items;
  return asRecordList(list);
}

const drivers = new Map<string, PanelDriver>();

export function registerPanelDriver(pluginId: string, driver: PanelDriver): void {
  drivers.set(pluginId, driver);
}

export function unregisterPanelDriver(pluginId: string): void {
  drivers.delete(pluginId);
}

export function findPanelDriver(pluginId: string): PanelDriver | null {
  return drivers.get(pluginId) ?? null;
}

/** 已登记进程内 TS driver（第一方）；L2 兜底不算。 */
export function hasInprocPanelDriver(serviceType: string | null | undefined): boolean {
  return findPanelDriver(canonicalPanelPluginId(serviceType)) != null;
}

export function panelDriverHas(
  serviceType: string | null | undefined,
  method: keyof PanelDriver,
): boolean {
  const driver = getPanelDriver(serviceType);
  return typeof driver?.[method] === "function";
}

export function panelConnectionCtx(server: {
  id: string;
  address: string;
  key: string;
  panelUser?: string;
}): PanelConnectionCtx {
  return {
    address: server.address,
    apiKey: server.key,
    connectionId: server.id,
    panelUser: server.panelUser,
  };
}

export function unwrapPanelTestConnection(
  res: PanelTestConnectionResult | null | undefined,
): { ok: boolean; hostname?: string } {
  if (res === true) return { ok: true };
  if (res === false || res == null) return { ok: false };
  return {
    ok: res.ok === true,
    hostname: typeof res.hostname === "string" && res.hostname.trim() ? res.hostname.trim() : undefined,
  };
}

function declaredL2Methods(pluginId: string): Set<string> {
  return new Set((getPluginManifest(pluginId)?.methods ?? []).map((item) => item.name));
}

function thirdPartyL2Driver(pluginId: string): PanelDriver {
  const declared = declaredL2Methods(pluginId);
  const has = (name: PanelL2Method) => declared.has(name);

  const driver: PanelDriver = {
    listDatabases: async (ctx) =>
      (await invokePanelList(pluginId, "listDatabases", ctx)).map(normalizePanelDatabaseRow),
  };

  if (has("testConnection")) {
    driver.testConnection = async (ctx) => {
      const res = await invokePanelMethod<PanelTestConnectionResult>(
        pluginId,
        "testConnection",
        ctxPayload(ctx),
      );
      return unwrapPanelTestConnection(res);
    };
  }
  if (has("createDatabase")) {
    driver.createDatabase = async (ctx, input) => {
      await invokePanelMethod(pluginId, "createDatabase", ctxPayload(ctx, { ...input }));
    };
  }
  if (has("deleteDatabase")) {
    driver.deleteDatabase = async (ctx, input) => {
      await invokePanelMethod(pluginId, "deleteDatabase", ctxPayload(ctx, { ...input }));
    };
  }
  if (has("listWebsites")) {
    driver.listWebsites = (ctx, query) =>
      invokePanelList(pluginId, "listWebsites", ctx, {
        ...(query?.search ? { search: query.search } : {}),
        ...(query?.groupId ? { groupId: query.groupId } : {}),
      });
  }
  if (has("createWebsite")) {
    driver.createWebsite = async (ctx, input) => {
      await invokePanelMethod(pluginId, "createWebsite", ctxPayload(ctx, { ...input }));
    };
  }
  if (has("setWebsiteStatus")) {
    driver.setWebsiteStatus = async (ctx, input) => {
      await invokePanelMethod(pluginId, "setWebsiteStatus", ctxPayload(ctx, { ...input }));
    };
  }
  if (has("deleteWebsite")) {
    driver.deleteWebsite = async (ctx, input) => {
      await invokePanelMethod(pluginId, "deleteWebsite", ctxPayload(ctx, { ...input }));
    };
  }
  if (has("listCertificates")) {
    driver.listCertificates = (ctx) => invokePanelList(pluginId, "listCertificates", ctx);
  }
  if (has("createCertificate")) {
    driver.createCertificate = async (ctx, input) => {
      await invokePanelMethod(pluginId, "createCertificate", ctxPayload(ctx, { ...input }));
    };
  }
  if (has("deleteCertificate")) {
    driver.deleteCertificate = async (ctx, input) => {
      await invokePanelMethod(pluginId, "deleteCertificate", ctxPayload(ctx, { ...input }));
    };
  }
  if (has("listCronjobs")) {
    driver.listCronjobs = (ctx) => invokePanelList(pluginId, "listCronjobs", ctx);
  }
  if (has("createCronjob")) {
    driver.createCronjob = async (ctx, input) => {
      await invokePanelMethod(pluginId, "createCronjob", ctxPayload(ctx, { ...input }));
    };
  }
  if (has("setCronjobStatus")) {
    driver.setCronjobStatus = async (ctx, input) => {
      await invokePanelMethod(pluginId, "setCronjobStatus", ctxPayload(ctx, { ...input }));
    };
  }
  if (has("runCronjob")) {
    driver.runCronjob = async (ctx, input) => {
      await invokePanelMethod(pluginId, "runCronjob", ctxPayload(ctx, { ...input }));
    };
  }
  if (has("deleteCronjob")) {
    driver.deleteCronjob = async (ctx, input) => {
      await invokePanelMethod(pluginId, "deleteCronjob", ctxPayload(ctx, { ...input }));
    };
  }
  if (has("listApps")) {
    driver.listApps = (ctx) => invokePanelList(pluginId, "listApps", ctx);
  }
  if (has("listInstalledApps")) {
    driver.listInstalledApps = (ctx) => invokePanelList(pluginId, "listInstalledApps", ctx);
  }
  if (has("getDashboard")) {
    driver.getDashboard = (ctx, query) =>
      invokePanelMethod(pluginId, "getDashboard", ctxPayload(ctx, { ...query }));
  }
  if (has("installApp")) {
    driver.installApp = async (ctx, input) => {
      await invokePanelMethod(pluginId, "installApp", ctxPayload(ctx, { ...input }));
    };
  }
  if (has("uninstallApp")) {
    driver.uninstallApp = async (ctx, input) => {
      await invokePanelMethod(pluginId, "uninstallApp", ctxPayload(ctx, { ...input }));
    };
  }
  return driver;
}

/**
 * 获取 panel driver：优先进程内 TS driver，兜底 L2 plugin_invoke（第三方）。
 * 返回的 driver 所有方法均已按 PanelDriver 签名封装。
 */
export function getPanelDriver(serviceType: string | null | undefined): PanelDriver | null {
  const pluginId = canonicalPanelPluginId(serviceType);
  const hydrated = usePluginRuntimeStore.getState().hydrated;
  if (hydrated && !isPluginActivated(pluginId)) return null;

  const local = findPanelDriver(pluginId);
  if (local) return local;

  // 第一方必须走进程内 driver；未登记时不要误走 L2。
  if (pluginId === PLUGIN_ID_PANEL_1PANEL || pluginId === PLUGIN_ID_PANEL_BT) {
    return null;
  }

  return thirdPartyL2Driver(pluginId);
}

export function normalizePanelDatabaseRow(row: Record<string, unknown>): PanelDatabaseItem {
  const rawId = row.id;
  const id =
    typeof rawId === "number" && Number.isFinite(rawId)
      ? rawId
      : typeof rawId === "string" && /^\d+$/.test(rawId.trim())
        ? Number(rawId.trim())
        : null;
  return {
    id,
    name: String(row.name ?? row.database ?? row.dbName ?? "—"),
    user: String(row.username ?? row.user ?? row.db_user ?? row.name ?? "—"),
    type: String(row.type ?? row.dbType ?? "MySQL"),
    remark: String(row.ps ?? row.remark ?? row.description ?? ""),
    raw: row,
  };
}

export function asRecordList(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> =>
    Boolean(item) && typeof item === "object" && !Array.isArray(item),
  );
}
