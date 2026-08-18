import { followUiIntent } from "../../../lib/ai/uiFollow";
import type {
  OnePanelAppInstalledParams,
  OnePanelAppParam,
} from "../../../lib/onepanel";
import { CLIENT_SYNC_MODULES_APPLIED_EVENT } from "../../clientSync";
import {
  formToConnection,
  isSupportedEngine,
  listConnections,
  saveConnection,
  type ConnectionFormData,
  type DbConnectionConfig,
} from "../../database/api";
import { resolveDbEngineType } from "../../database/connection/engineIcons";
import { submitSchemaCacheRefresh } from "../../database/schema/schemaCacheBackgroundTasks";
import type { ServerEntry } from "./serverConnection";

const LOOPBACK = new Set(["", "localhost", "127.0.0.1", "::1", "0.0.0.0", "::"]);

function normalizeToken(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** 将 1Panel 应用 key/名称映射到数据库模块已支持的引擎。 */
export function resolvePanelAppDbEngine(app: {
  key?: string;
  name?: string;
  type?: string;
}): ConnectionFormData["engine"] | null {
  const tokens = [app.key, app.name, app.type].filter(Boolean) as string[];
  for (const raw of tokens) {
    const n = normalizeToken(raw);
    if (!n) continue;
    if (n.startsWith("mariadb") || n.startsWith("mysql")) return "mysql";
    if (n.startsWith("postgres") || n.startsWith("pgsql") || n === "pg") return "postgresql";
    if (n.startsWith("redis")) return "redis";
    if (n.startsWith("mongo")) return "mongodb";
    if (n.startsWith("qdrant")) return "qdrant";
  }
  return null;
}

export function isPanelAppManagedByDatabase(app: {
  key?: string;
  name?: string;
  type?: string;
}): boolean {
  const engine = resolvePanelAppDbEngine(app);
  return engine != null && isSupportedEngine(engine);
}

function looksMasked(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length >= 4 && /^[•*]+$/.test(trimmed);
}

function paramScalar(param: OnePanelAppParam): string {
  const raw = param.value;
  if (typeof raw === "string" && raw.trim() && !looksMasked(raw)) {
    return raw.trim();
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return String(raw);
  }
  if (typeof raw === "boolean") {
    return raw ? "true" : "false";
  }
  if (param.showValue && param.showValue.trim() && !looksMasked(param.showValue)) {
    return param.showValue.trim();
  }
  if (typeof raw === "string") return raw.trim();
  return "";
}

function paramMap(config: OnePanelAppInstalledParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const param of config.params) {
    const key = param.key.trim().toLowerCase();
    if (!key) continue;
    const value = paramScalar(param);
    if (value) out[key] = value;
  }
  return out;
}

function firstByKeys(map: Record<string, string>, keys: string[]): string {
  for (const key of keys) {
    const value = map[key.toLowerCase()]?.trim();
    if (value) return value;
  }
  return "";
}

function firstByKeyIncludes(map: Record<string, string>, needles: string[]): string {
  for (const [key, value] of Object.entries(map)) {
    if (!value.trim()) continue;
    if (needles.some((needle) => key.includes(needle))) return value.trim();
  }
  return "";
}

function parsePort(raw: string): number | null {
  const first = raw.trim().split(/[:\s,]/)[0] ?? "";
  const parsed = Number.parseInt(first, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) return null;
  return parsed;
}

function hostFromPanelAddress(address: string): string {
  const trimmed = address.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`);
    return (url.hostname || "").trim();
  } catch {
    const hostPort = trimmed.replace(/^https?:\/\//i, "").split("/")[0] ?? "";
    if (hostPort.startsWith("[")) {
      const end = hostPort.indexOf("]");
      return end > 1 ? hostPort.slice(1, end) : hostPort;
    }
    return hostPort.split(":")[0] ?? "";
  }
}

function parseWebUi(webUI: string | undefined): { host?: string; port?: number } {
  const raw = (webUI ?? "").trim();
  if (!raw) return {};
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`);
    const host = (url.hostname || "").trim();
    const port = url.port ? parsePort(url.port) : null;
    return {
      host: host && !LOOPBACK.has(host.toLowerCase()) ? host : undefined,
      port: port ?? undefined,
    };
  } catch {
    return {};
  }
}

function pickHost(
  server: ServerEntry,
  config: OnePanelAppInstalledParams,
  map: Record<string, string>,
): string {
  const specify = (config.specifyIP ?? "").trim();
  if (specify && !LOOPBACK.has(specify.toLowerCase())) {
    return specify;
  }
  const fromParam = firstByKeys(map, ["panel_db_host", "mysql_host", "redis_host", "postgres_host"]);
  if (fromParam && !LOOPBACK.has(fromParam.toLowerCase())) {
    return fromParam;
  }
  const fromWeb = parseWebUi(config.webUI).host;
  if (fromWeb) return fromWeb;
  return hostFromPanelAddress(server.address);
}

function pickPort(
  config: OnePanelAppInstalledParams,
  map: Record<string, string>,
): string {
  if (config.hostMode) {
    return "";
  }
  const preferred = firstByKeys(map, [
    "panel_app_port_http",
    "panel_redis_port",
    "panel_mysql_port",
    "panel_db_port",
    "panel_postgres_port",
    "panel_mongo_port",
    "panel_mongodb_port",
    "host_port",
    "http_port",
  ]);
  const fromPreferred = preferred ? parsePort(preferred) : null;
  if (fromPreferred != null) return String(fromPreferred);

  const fromIncludes = firstByKeyIncludes(map, ["_port", "port"]);
  const fromIncludesPort = fromIncludes ? parsePort(fromIncludes) : null;
  if (fromIncludesPort != null) return String(fromIncludesPort);

  const fromWeb = parseWebUi(config.webUI).port;
  if (fromWeb != null) return String(fromWeb);

  return "";
}

function pickPassword(map: Record<string, string>): string {
  const preferred = firstByKeys(map, [
    "panel_db_root_password",
    "panel_redis_root_password",
    "panel_db_user_password",
    "panel_db_password",
    "mysql_root_password",
    "postgres_password",
    "redis_password",
    "mongo_initdb_root_password",
  ]);
  if (preferred) return preferred;
  return firstByKeyIncludes(map, ["password", "passwd", "secret"]);
}

function pickUsername(engine: ConnectionFormData["engine"], map: Record<string, string>): string {
  const preferred = firstByKeys(map, [
    "panel_db_root_user",
    "panel_db_user",
    "mysql_user",
    "postgres_user",
    "mongo_initdb_root_username",
  ]);
  if (preferred) return preferred;
  if (engine === "mysql") return "root";
  if (engine === "postgresql") return "postgres";
  if (engine === "mongodb") return "root";
  return "";
}

function pickDatabase(engine: ConnectionFormData["engine"], map: Record<string, string>): string {
  const preferred = firstByKeys(map, [
    "panel_db_name",
    "mysql_database",
    "postgres_db",
    "mongo_initdb_database",
  ]);
  if (preferred) return preferred;
  if (engine === "redis") return "0";
  if (engine === "postgresql") return "postgres";
  return "";
}

export function defaultPanelAppConnectionName(serverName: string, appLabel: string): string {
  return `${serverName.trim()} · ${appLabel.trim()}`.replace(/^ · | · $/g, "").trim();
}

export function buildDbFormFromPanelApp(options: {
  server: ServerEntry;
  appLabel: string;
  engine: ConnectionFormData["engine"];
  config: OnePanelAppInstalledParams;
  name?: string;
}): ConnectionFormData {
  const map = paramMap(options.config);
  const host = pickHost(options.server, options.config, map);
  return {
    engine: options.engine,
    name:
      options.name?.trim() ||
      defaultPanelAppConnectionName(options.server.name, options.appLabel),
    host,
    port: pickPort(options.config, map),
    database: pickDatabase(options.engine, map),
    username: pickUsername(options.engine, map),
    password: pickPassword(map),
    ssl: false,
    group: options.server.name.trim() || "默认",
  };
}

function sameEndpoint(
  connection: DbConnectionConfig,
  form: ConnectionFormData,
): boolean {
  const engine = resolveDbEngineType(connection.db_type);
  if (engine !== form.engine) return false;
  if (connection.host.trim().toLowerCase() !== form.host.trim().toLowerCase()) return false;
  const formConn = formToConnection(form);
  return connection.port === formConn.port;
}

function notifyDatabaseSidebar(): void {
  window.dispatchEvent(new Event(CLIENT_SYNC_MODULES_APPLIED_EVENT));
}

export async function importPanelAppToDatabase(options: {
  server: ServerEntry;
  appLabel: string;
  appKey?: string;
  appType?: string;
  config: OnePanelAppInstalledParams;
  name?: string;
}): Promise<{ connection: DbConnectionConfig; created: boolean }> {
  const engine = resolvePanelAppDbEngine({
    key: options.appKey,
    name: options.appLabel,
    type: options.appType,
  });
  if (!engine || !isSupportedEngine(engine)) {
    throw new Error("当前应用不是数据库模块支持的类型");
  }
  const form = buildDbFormFromPanelApp({
    server: options.server,
    appLabel: options.appLabel,
    engine,
    config: options.config,
    name: options.name,
  });
  if (!form.host.trim()) {
    throw new Error("无法从面板地址解析主机");
  }

  const existing = (await listConnections()).find((item) => sameEndpoint(item, form));
  if (existing) {
    notifyDatabaseSidebar();
    followUiIntent({ type: "openConnection", module: "database", resourceId: existing.id });
    return { connection: existing, created: false };
  }

  const saved = await saveConnection(formToConnection(form));
  notifyDatabaseSidebar();
  void submitSchemaCacheRefresh([saved.id]).catch(() => {
    // Schema 刷新失败不影响连接已写入侧栏
  });
  followUiIntent({ type: "openConnection", module: "database", resourceId: saved.id });
  return { connection: saved, created: true };
}
