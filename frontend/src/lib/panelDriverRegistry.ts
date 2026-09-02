import { isPluginActivated, usePluginRuntimeStore } from "../stores/pluginRuntimeStore";
import { canonicalPanelPluginId } from "../modules/server/panel/panelPlugin";
import type { ServerEntry } from "../modules/server/panel/serverConnection";

/** 与 plugin.json `methods[].name` 对齐的面板 L2 方法（阶段 A：进程内 driver）。 */
export const PANEL_L2_METHODS = [
  "testConnection",
  "listDatabases",
  "createDatabase",
  "deleteDatabase",
] as const;

export type PanelL2Method = (typeof PANEL_L2_METHODS)[number];

export type PanelConnectionCtx = {
  address: string;
  apiKey: string;
  connectionId: string;
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

export type PanelDriver = {
  testConnection?: (ctx: PanelConnectionCtx) => Promise<boolean>;
  listDatabases: (ctx: PanelConnectionCtx) => Promise<PanelDatabaseItem[]>;
  createDatabase?: (ctx: PanelConnectionCtx, input: PanelCreateDatabaseInput) => Promise<void>;
  deleteDatabase?: (ctx: PanelConnectionCtx, input: PanelDeleteDatabaseInput) => Promise<void>;
};

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

export function panelConnectionCtx(server: ServerEntry): PanelConnectionCtx {
  return {
    address: server.address,
    apiKey: server.key,
    connectionId: server.id,
  };
}

export function getPanelDriver(serviceType: string | null | undefined): PanelDriver | null {
  const pluginId = canonicalPanelPluginId(serviceType);
  const hydrated = usePluginRuntimeStore.getState().hydrated;
  if (hydrated && !isPluginActivated(pluginId)) return null;
  return findPanelDriver(pluginId);
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
