import type { BtAppInfoField, BtInstalledApp } from "../../lib/btpanel";
import type { OnePanelInstalledApp } from "../../lib/onepanel";

/** 服务器模块统一的应用展示模型（兼容 1Panel / 宝塔）。 */
export interface ServerInstalledApp extends OnePanelInstalledApp {
  uid: string;
  portTags?: string[];
  description?: string;
  btAppInfo?: BtAppInfoField[];
  runtimeLabel?: string;
  serverIp?: string;
}

export function toServerInstalledApp(app: OnePanelInstalledApp): ServerInstalledApp {
  return { ...app, uid: String(app.id) };
}

function stableNumericId(uid: string): number {
  let hash = 0;
  for (let i = 0; i < uid.length; i += 1) {
    hash = (hash * 31 + uid.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) || 1;
}

function normalizeBtStatus(value: unknown): string {
  if (value === true || value === 1 || value === "1") return "Running";
  if (value === false || value === 0 || value === "0") return "Stopped";
  if (typeof value !== "string" || !value.trim()) return "-";
  const lower = value.trim().toLowerCase();
  if (["running", "up", "active", "healthy", "run"].includes(lower)) return "Running";
  if (["stopped", "stop", "down", "exited", "exit", "dead", "pause", "paused"].includes(lower)) {
    return "Stopped";
  }
  return value.trim();
}

export function formatBtAppInfoValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "boolean") return value ? "是" : "否";
  return String(value);
}

export function getBtAppInfoField(app: BtInstalledApp, fieldKey: string): string | undefined {
  const field = app.appinfo?.find((item) => item.fieldKey === fieldKey);
  if (!field) return undefined;
  const text = formatBtAppInfoValue(field.fieldValue);
  return text === "-" ? undefined : text;
}

export function mapBtInstalledApp(app: BtInstalledApp): ServerInstalledApp {
  const uid = String(app.id ?? app.service_name ?? app.appid ?? "");
  const appName = app.apptitle?.trim() || app.appname || "-";
  const name = app.service_name?.trim() || app.appname || appName;
  const appKey = app.appname?.trim() || name;
  const status = normalizeBtStatus(app.status ?? app.appstatus);
  const ports = Array.isArray(app.port) ? app.port.map(String).filter(Boolean) : [];
  const appPath = getBtAppInfoField(app, "app_path") || app.path;
  const appType = getBtAppInfoField(app, "app_type") || app.apptype;

  return {
    id: stableNumericId(uid),
    uid,
    name,
    appName,
    appKey,
    version: app.version?.trim() || undefined,
    status,
    appStatus: status,
    httpPort: ports[0] ? Number(ports[0]) || undefined : undefined,
    path: appPath,
    icon: app.icon?.trim() || undefined,
    description: app.appdesc?.trim() || undefined,
    appType,
    container: app.container_id,
    serviceName: app.service_name,
    createdAt: app.createat,
    runtimeLabel: app.createat,
    canUpdate: Boolean(app.canUpdate),
    portTags: ports,
    btAppInfo: app.appinfo,
    serverIp: app.server_ip,
    app: app.home ? { website: app.home } : undefined,
    appID: typeof app.appid === "number" ? app.appid : Number(app.appid) || undefined,
  };
}
