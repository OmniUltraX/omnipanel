import type { OnePanelAppInstalledParams, OnePanelAppParam } from "../onepanel";
import type { BtPanelClient } from "./client";
import type { BtInstalledApp, BtSoftItem } from "./types";

/**
 * 软件商店 MySQL/MariaDB 在 soft id 缺失/为 0 时的稳定 installId，
 * 供应用市场「一键管理」回调识别。
 */
export const BT_SOFT_MYSQL_FALLBACK_INSTALL_ID = -91001;

function normalizeToken(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** 是否为 MySQL / MariaDB 应用标识（软件商店 name 或 Docker appname）。 */
export function isBtMysqlOrMariadbKey(raw: string | null | undefined): boolean {
  const n = normalizeToken(raw ?? "");
  if (!n) return false;
  return n.startsWith("mysql") || n.startsWith("mariadb");
}

/** 软件商店已装 MySQL/MariaDB 的 installId（缺 id 时用 fallback）。 */
export function btSoftMysqlInstallId(item: Pick<BtSoftItem, "id" | "name">): number {
  const id = Number(item.id) || 0;
  if (id > 0) return id;
  return BT_SOFT_MYSQL_FALLBACK_INSTALL_ID;
}

function param(
  key: string,
  value: string,
  extra?: Partial<OnePanelAppParam>,
): OnePanelAppParam {
  return {
    key,
    value,
    showValue: value,
    ...extra,
  };
}

function parsePortCandidate(raw: string): number | null {
  const text = raw.trim();
  if (!text) return null;
  // "3307:3306" / "0.0.0.0:3307->3306/tcp" → 优先宿主机端口
  const hostMapped = text.match(/(?:^|[^\d])(\d{2,5})\s*:\s*\d{2,5}\b/);
  if (hostMapped) {
    const n = Number.parseInt(hostMapped[1]!, 10);
    if (n > 0 && n <= 65535) return n;
  }
  const arrow = text.match(/:(\d{2,5})\s*->/);
  if (arrow) {
    const n = Number.parseInt(arrow[1]!, 10);
    if (n > 0 && n <= 65535) return n;
  }
  const first = text.match(/\b(\d{2,5})\b/);
  if (first) {
    const n = Number.parseInt(first[1]!, 10);
    if (n > 0 && n <= 65535) return n;
  }
  return null;
}

function fieldMapFromAppInfo(app: BtInstalledApp): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of app.appinfo ?? []) {
    const key = String(field.fieldKey ?? "").trim();
    if (!key) continue;
    const raw = field.fieldValue;
    if (raw == null || raw === "") continue;
    out[key.toLowerCase()] = String(raw).trim();
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

export function pickDockerMysqlPort(app: BtInstalledApp, map: Record<string, string>): string {
  const fromPreferred = firstByKeys(map, [
    "panel_mysql_port",
    "mysql_port",
    "mariadb_port",
    "host_port",
    "port",
    "db_port",
  ]);
  if (fromPreferred) {
    const n = parsePortCandidate(fromPreferred);
    if (n != null) return String(n);
  }
  const fromIncludes = firstByKeyIncludes(map, ["_port", "port"]);
  if (fromIncludes) {
    const n = parsePortCandidate(fromIncludes);
    if (n != null) return String(n);
  }
  for (const raw of app.port ?? []) {
    const n = parsePortCandidate(String(raw));
    if (n != null) return String(n);
  }
  return "3306";
}

export function pickDockerMysqlPassword(map: Record<string, string>): string {
  return (
    firstByKeys(map, [
      "panel_db_root_password",
      "mysql_root_password",
      "mariadb_root_password",
      "mysql_password",
      "mariadb_password",
      "root_password",
      "password",
    ]) || firstByKeyIncludes(map, ["password", "passwd"])
  );
}

export function pickDockerMysqlUser(map: Record<string, string>): string {
  return (
    firstByKeys(map, [
      "panel_db_root_user",
      "mysql_user",
      "mysql_root_user",
      "mariadb_user",
      "root_user",
      "username",
      "user",
    ]) || "root"
  );
}

/** 将 Docker 已装 MySQL/MariaDB 转为与 1Panel 同形的 params。 */
export function buildParamsFromBtDockerMysql(app: BtInstalledApp): OnePanelAppInstalledParams {
  const map = fieldMapFromAppInfo(app);
  const port = pickDockerMysqlPort(app, map);
  const password = pickDockerMysqlPassword(map);
  const username = pickDockerMysqlUser(map);
  const params: OnePanelAppParam[] = [
    param("PANEL_MYSQL_PORT", port, { labelZh: "端口", labelEn: "Port" }),
    param("PANEL_DB_ROOT_USER", username, { labelZh: "用户", labelEn: "User" }),
    param("PANEL_DB_ROOT_PASSWORD", password, {
      type: "password",
      labelZh: "密码",
      labelEn: "Password",
    }),
  ];
  // 附带原始 appinfo，便于参数对话框浏览
  for (const field of app.appinfo ?? []) {
    const key = String(field.fieldKey ?? "").trim();
    if (!key) continue;
    const lower = key.toLowerCase();
    if (
      lower === "panel_mysql_port" ||
      lower === "panel_db_root_user" ||
      lower === "panel_db_root_password"
    ) {
      continue;
    }
    const value = field.fieldValue;
    if (value == null || value === "") continue;
    const text = String(value).trim();
    params.push(
      param(key, text, {
        labelZh: field.fieldTitle || key,
        labelEn: field.fieldTitle || key,
        type: /password|passwd|secret/i.test(key) ? "password" : undefined,
      }),
    );
  }
  return {
    params,
    containerName: (app.container_id || app.service_name || "").trim() || undefined,
    type: app.apptype,
  };
}

/** 软件商店本机 MySQL/MariaDB：拉端口 + root 密码。 */
export async function buildParamsFromBtSoftMysql(
  client: BtPanelClient,
): Promise<OnePanelAppInstalledParams> {
  let port = "3306";
  try {
    const info = await client.getMySQLInfo();
    const parsed = parsePortCandidate(String(info.port ?? ""));
    if (parsed != null) port = String(parsed);
  } catch {
    // 保留默认 3306
  }

  let username = "root";
  let password = "";
  try {
    const servers = await client.getCloudServers();
    const local =
      servers.find((item) => Number(item.id) === 0) ??
      servers.find((item) => /本地|local/i.test(String(item.ps ?? ""))) ??
      servers[0];
    if (local?.db_user?.trim()) username = local.db_user.trim();
    if (local?.db_password?.trim()) password = local.db_password.trim();
    const cloudPort = parsePortCandidate(String(local?.db_port ?? ""));
    if (cloudPort != null) port = String(cloudPort);
  } catch {
    // 忽略
  }

  if (!password) {
    try {
      password = (await client.getConfigKey({ key: "mysql_root" })).trim();
    } catch {
      // 密码拿不到时仍返回 host/port/user，导入后可手动补
    }
  }

  return {
    params: [
      param("PANEL_MYSQL_PORT", port, { labelZh: "端口", labelEn: "Port" }),
      param("PANEL_DB_ROOT_USER", username, { labelZh: "用户", labelEn: "User" }),
      param("PANEL_DB_ROOT_PASSWORD", password, {
        type: "password",
        labelZh: "密码",
        labelEn: "Password",
      }),
    ],
    type: "runtime",
  };
}

function softItemMatchesInstallId(item: BtSoftItem, installId: number): boolean {
  if (!item.setup || !isBtMysqlOrMariadbKey(item.name)) return false;
  return btSoftMysqlInstallId(item) === installId;
}

/**
 * 按应用市场 installId 解析宝塔 MySQL/MariaDB 连接参数。
 * 优先 Docker 已装（appid），否则软件商店本机实例。
 */
export async function resolveBtInstalledMysqlParams(
  client: BtPanelClient,
  installId: number,
): Promise<OnePanelAppInstalledParams> {
  if (!Number.isFinite(installId)) {
    throw new Error("应用安装 ID 无效");
  }

  try {
    const docker = await client.getInstalledApps({ p: 1, row: 500, appType: "all" });
    const hit = docker.items.find(
      (item) =>
        Number(item.appid) === installId && isBtMysqlOrMariadbKey(item.appname),
    );
    if (hit) return buildParamsFromBtDockerMysql(hit);
  } catch {
    // Docker 商店不可用时继续尝试软件商店
  }

  const soft = await client.getSoftList({ p: 1, type: 0, query: "", force: 0, row: 300 });
  const softHit = soft.items.find((item) => softItemMatchesInstallId(item, installId));
  if (softHit) {
    return buildParamsFromBtSoftMysql(client);
  }

  // fallback installId：只要本机软件商店已装 MySQL/MariaDB 即可
  if (installId === BT_SOFT_MYSQL_FALLBACK_INSTALL_ID) {
    const anySoft = soft.items.find(
      (item) => item.setup && isBtMysqlOrMariadbKey(item.name),
    );
    if (anySoft) return buildParamsFromBtSoftMysql(client);
  }

  throw new Error("未找到对应的 MySQL/MariaDB 安装，或当前应用不支持一键管理");
}
