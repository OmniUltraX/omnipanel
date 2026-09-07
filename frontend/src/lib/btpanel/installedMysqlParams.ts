import type { OnePanelAppInstalledParams, OnePanelAppParam } from "../onepanel";
import type { BtPanelClient } from "./client";
import type { BtCloudServer, BtInstalledApp, BtSoftItem } from "./types";

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

export function parsePortCandidate(raw: string): number | null {
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

function looksMaskedSecret(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length >= 4 && /^[•*]+$/.test(trimmed);
}

/** 兼容 fieldKey/key/attr 与 fieldValue/value/default 等多种宝塔字段形态。 */
export function fieldMapFromAppInfo(app: BtInstalledApp): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of app.appinfo ?? []) {
    const row = field as unknown as Record<string, unknown>;
    const key = String(row.fieldKey ?? row.key ?? row.attr ?? row.name ?? "").trim();
    if (!key) continue;
    const raw = row.fieldValue ?? row.value ?? row.default;
    if (raw == null || raw === "") continue;
    const text = String(raw).trim();
    if (!text || looksMaskedSecret(text)) continue;
    out[key.toLowerCase()] = text;
  }
  return out;
}

function mergeEnvTextIntoMap(envText: string, map: Record<string, string>): void {
  for (const line of envText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim().toLowerCase();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!key || !value || looksMaskedSecret(value)) continue;
    if (!map[key]) map[key] = value;
  }
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
    "mysql_port",
    "mariadb_port",
    "panel_mysql_port",
    "host_port",
    "db_port",
    "port",
  ]);
  if (fromPreferred) {
    const n = parsePortCandidate(fromPreferred);
    if (n != null) return String(n);
  }
  const fromIncludes = firstByKeyIncludes(map, ["mysql_port", "mariadb_port", "_port"]);
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
      "mysql_root_password",
      "mariadb_root_password",
      "panel_db_root_password",
      "root_password",
      "mysql_password",
      "mariadb_password",
    ]) || firstByKeyIncludes(map, ["root_password", "rootpassword"])
  );
}

export function pickDockerMysqlUser(map: Record<string, string>): string {
  return (
    firstByKeys(map, [
      "panel_db_root_user",
      "mysql_root_user",
      "mariadb_root_user",
      "root_user",
    ]) || "root"
  );
}

/** 将 Docker MySQL 与面板「远程数据库」条目对齐（安装后常自动注册）。 */
export function matchCloudServerForDockerMysql(
  servers: BtCloudServer[],
  app: BtInstalledApp,
): BtCloudServer | null {
  const service = (app.service_name || "").trim().toLowerCase();
  const title = (app.apptitle || app.appname || "").trim().toLowerCase();
  const nonLocal = servers.filter((item) => Number(item.id) !== 0);
  if (service) {
    const byPs = nonLocal.find((item) => {
      const ps = String(item.ps ?? "").trim().toLowerCase();
      return ps === service || ps.includes(service) || service.includes(ps);
    });
    if (byPs) return byPs;
  }
  if (title) {
    const byTitle = nonLocal.find((item) =>
      String(item.ps ?? "").trim().toLowerCase().includes(title),
    );
    if (byTitle) return byTitle;
  }
  // 仅当只有一个非本机库服务器时兜底（常见：刚装的 Docker MySQL）
  if (nonLocal.length === 1 && isBtMysqlOrMariadbKey(app.appname)) {
    return nonLocal[0]!;
  }
  return null;
}

function toInstalledParams(options: {
  port: string;
  username: string;
  password: string;
  containerName?: string;
  type?: string;
  extraParams?: OnePanelAppParam[];
}): OnePanelAppInstalledParams {
  return {
    params: [
      param("PANEL_MYSQL_PORT", options.port, { labelZh: "端口", labelEn: "Port" }),
      param("PANEL_DB_ROOT_USER", options.username, { labelZh: "用户", labelEn: "User" }),
      param("PANEL_DB_ROOT_PASSWORD", options.password, {
        type: "password",
        labelZh: "密码",
        labelEn: "Password",
      }),
      ...(options.extraParams ?? []),
    ],
    containerName: options.containerName,
    type: options.type,
  };
}

/** 将 Docker 已装 MySQL/MariaDB 转为与 1Panel 同形的 params（同步路径，不含读盘）。 */
export function buildParamsFromBtDockerMysql(app: BtInstalledApp): OnePanelAppInstalledParams {
  const map = fieldMapFromAppInfo(app);
  return toInstalledParams({
    port: pickDockerMysqlPort(app, map),
    username: pickDockerMysqlUser(map),
    password: pickDockerMysqlPassword(map),
    containerName: (app.container_id || app.service_name || "").trim() || undefined,
    type: app.apptype,
    extraParams: buildRawAppInfoParams(app),
  });
}

function buildRawAppInfoParams(app: BtInstalledApp): OnePanelAppParam[] {
  const params: OnePanelAppParam[] = [];
  for (const field of app.appinfo ?? []) {
    const row = field as unknown as Record<string, unknown>;
    const key = String(row.fieldKey ?? row.key ?? row.attr ?? row.name ?? "").trim();
    if (!key) continue;
    const lower = key.toLowerCase();
    if (
      lower === "panel_mysql_port" ||
      lower === "panel_db_root_user" ||
      lower === "panel_db_root_password" ||
      lower === "mysql_port" ||
      lower === "mysql_root_password" ||
      lower === "panel_redis_port" ||
      lower === "panel_redis_root_password" ||
      lower === "redis_port" ||
      lower === "redis_password" ||
      lower === "redis_pass" ||
      lower === "requirepass"
    ) {
      continue;
    }
    const value = row.fieldValue ?? row.value ?? row.default;
    if (value == null || value === "") continue;
    const text = String(value).trim();
    if (!text || looksMaskedSecret(text)) continue;
    params.push(
      param(key, text, {
        labelZh: String(row.fieldTitle ?? row.name ?? key),
        labelEn: String(row.fieldTitle ?? row.name ?? key),
        type: /password|passwd|secret/i.test(key) ? "password" : undefined,
      }),
    );
  }
  return params;
}

async function enrichDockerMapFromEnvFile(
  client: BtPanelClient,
  app: BtInstalledApp,
  map: Record<string, string>,
): Promise<void> {
  const base = (app.path || "").trim().replace(/\/+$/, "");
  if (!base) return;
  const candidates = [".env", "mysql.env", ".env.mysql"];
  for (const rel of candidates) {
    try {
      const body = await client.getFileBody(`${base}/${rel}`);
      const text = typeof body.data === "string" ? body.data : "";
      if (!text.trim()) continue;
      mergeEnvTextIntoMap(text, map);
      return;
    } catch {
      // 尝试下一个
    }
  }
}

/** Docker MySQL：appinfo + CloudServer + 可选 .env。 */
export async function buildParamsFromBtDockerMysqlAsync(
  client: BtPanelClient,
  app: BtInstalledApp,
): Promise<OnePanelAppInstalledParams> {
  const map = fieldMapFromAppInfo(app);
  await enrichDockerMapFromEnvFile(client, app, map);

  let port = pickDockerMysqlPort(app, map);
  let username = pickDockerMysqlUser(map);
  let password = pickDockerMysqlPassword(map);

  try {
    const servers = await client.getCloudServers();
    const matched = matchCloudServerForDockerMysql(servers, app);
    if (matched) {
      const cloudPort = parsePortCandidate(String(matched.db_port ?? ""));
      if (cloudPort != null) port = String(cloudPort);
      if (matched.db_user?.trim()) username = matched.db_user.trim();
      if (matched.db_password?.trim() && !looksMaskedSecret(matched.db_password)) {
        password = matched.db_password.trim();
      }
    }
  } catch {
    // CloudServer 失败时保留 appinfo/.env
  }

  return toInstalledParams({
    port,
    username,
    password,
    containerName: (app.container_id || app.service_name || "").trim() || undefined,
    type: app.apptype,
    extraParams: buildRawAppInfoParams(app),
  });
}

/** 软件商店本机 MySQL/MariaDB：GetMySQLInfo 端口 + GetConcifInfo 密码。 */
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

  let password = "";
  // 官方推荐：GetConcifInfo.mysql_root（比 getKey / 空密码的本地 CloudServer 更可靠）
  try {
    const conf = await client.getConcifInfo();
    const root = String(conf.mysql_root ?? "").trim();
    if (root && !looksMaskedSecret(root)) password = root;
  } catch {
    // 继续降级
  }
  if (!password) {
    try {
      const key = (await client.getConfigKey({ key: "mysql_root" })).trim();
      if (key && !looksMaskedSecret(key)) password = key;
    } catch {
      // 忽略
    }
  }
  // 仅使用 id=0 本地服务器补密；绝不 fallback 到 remote（会污染端口/密码）
  if (!password) {
    try {
      const servers = await client.getCloudServers();
      const local = servers.find((item) => Number(item.id) === 0);
      const localPass = local?.db_password?.trim() ?? "";
      if (localPass && !looksMaskedSecret(localPass)) password = localPass;
    } catch {
      // 忽略
    }
  }

  return toInstalledParams({
    port,
    username: "root",
    password,
    type: "runtime",
  });
}

function softItemMatchesInstallId(item: BtSoftItem, installId: number): boolean {
  if (!item.setup || !isBtMysqlOrMariadbKey(item.name)) return false;
  return btSoftMysqlInstallId(item) === installId;
}

function softItemMatchesRedisInstallId(item: BtSoftItem, installId: number): boolean {
  if (!item.setup || !isBtRedisKey(item.name)) return false;
  return btSoftRedisInstallId(item) === installId;
}

/**
 * 软件商店 Redis 在 soft id 缺失/为 0 时的稳定 installId。
 */
export const BT_SOFT_REDIS_FALLBACK_INSTALL_ID = -91002;

/** 是否为 Redis 应用标识（软件商店 name 或 Docker appname）。 */
export function isBtRedisKey(raw: string | null | undefined): boolean {
  const n = normalizeToken(raw ?? "");
  if (!n) return false;
  return n.startsWith("redis");
}

/** 软件商店已装 Redis 的 installId（缺 id 时用 fallback）。 */
export function btSoftRedisInstallId(item: Pick<BtSoftItem, "id" | "name">): number {
  const id = Number(item.id) || 0;
  if (id > 0) return id;
  return BT_SOFT_REDIS_FALLBACK_INSTALL_ID;
}

/** 本机软装数据库类应用的 fallback installId（一键管理用）。 */
export function btSoftDbFallbackInstallId(appKey: string | null | undefined): number | undefined {
  if (isBtMysqlOrMariadbKey(appKey)) return BT_SOFT_MYSQL_FALLBACK_INSTALL_ID;
  if (isBtRedisKey(appKey)) return BT_SOFT_REDIS_FALLBACK_INSTALL_ID;
  return undefined;
}

export function pickDockerRedisPort(app: BtInstalledApp, map: Record<string, string>): string {
  const fromPreferred = firstByKeys(map, [
    "redis_port",
    "panel_redis_port",
    "host_port",
    "port",
  ]);
  if (fromPreferred) {
    const n = parsePortCandidate(fromPreferred);
    if (n != null) return String(n);
  }
  const fromIncludes = firstByKeyIncludes(map, ["redis_port", "_port"]);
  if (fromIncludes) {
    const n = parsePortCandidate(fromIncludes);
    if (n != null) return String(n);
  }
  for (const raw of app.port ?? []) {
    const n = parsePortCandidate(String(raw));
    if (n != null) return String(n);
  }
  return "6379";
}

export function pickDockerRedisPassword(map: Record<string, string>): string {
  return (
    firstByKeys(map, [
      "redis_password",
      "redis_pass",
      "panel_redis_root_password",
      "requirepass",
      "password",
    ]) || firstByKeyIncludes(map, ["redis_password", "requirepass", "password"])
  );
}

function toRedisInstalledParams(options: {
  port: string;
  password: string;
  containerName?: string;
  type?: string;
  extraParams?: OnePanelAppParam[];
}): OnePanelAppInstalledParams {
  return {
    params: [
      param("PANEL_REDIS_PORT", options.port, { labelZh: "端口", labelEn: "Port" }),
      param("PANEL_REDIS_ROOT_PASSWORD", options.password, {
        type: "password",
        labelZh: "密码",
        labelEn: "Password",
      }),
      param("PANEL_DB_NAME", "0", { labelZh: "库", labelEn: "Database" }),
      ...(options.extraParams ?? []),
    ],
    containerName: options.containerName,
    type: options.type,
  };
}

/** 解析宝塔 redis.conf：port / requirepass（忽略注释行）。 */
export function parseBtRedisConf(text: string): { port: string; password: string } {
  let port = "6379";
  let password = "";
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const portMatch = /^port\s+(\d{1,5})\b/i.exec(trimmed);
    if (portMatch) {
      const n = Number.parseInt(portMatch[1]!, 10);
      if (n > 0 && n <= 65535) port = String(n);
      continue;
    }
    const passMatch = /^requirepass\s+(.+)$/i.exec(trimmed);
    if (passMatch) {
      let value = passMatch[1]!.trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (value && !looksMaskedSecret(value)) password = value;
    }
  }
  return { port, password };
}

async function enrichDockerMapFromRedisEnvFile(
  client: BtPanelClient,
  app: BtInstalledApp,
  map: Record<string, string>,
): Promise<void> {
  const base = (app.path || "").trim().replace(/\/+$/, "");
  if (!base) return;
  const candidates = [".env", "redis.env", ".env.redis"];
  for (const rel of candidates) {
    try {
      const body = await client.getFileBody(`${base}/${rel}`);
      const text = typeof body.data === "string" ? body.data : "";
      if (!text.trim()) continue;
      mergeEnvTextIntoMap(text, map);
      return;
    } catch {
      // 尝试下一个
    }
  }
}

/** Docker Redis：appinfo + 可选 .env。 */
export async function buildParamsFromBtDockerRedisAsync(
  client: BtPanelClient,
  app: BtInstalledApp,
): Promise<OnePanelAppInstalledParams> {
  const map = fieldMapFromAppInfo(app);
  await enrichDockerMapFromRedisEnvFile(client, app, map);
  return toRedisInstalledParams({
    port: pickDockerRedisPort(app, map),
    password: pickDockerRedisPassword(map),
    containerName: (app.container_id || app.service_name || "").trim() || undefined,
    type: app.apptype,
    extraParams: buildRawAppInfoParams(app),
  });
}

/** 同步路径（仅 appinfo / port），不含读盘。 */
export function buildParamsFromBtDockerRedis(app: BtInstalledApp): OnePanelAppInstalledParams {
  const map = fieldMapFromAppInfo(app);
  return toRedisInstalledParams({
    port: pickDockerRedisPort(app, map),
    password: pickDockerRedisPassword(map),
    containerName: (app.container_id || app.service_name || "").trim() || undefined,
    type: app.apptype,
    extraParams: buildRawAppInfoParams(app),
  });
}

const BT_SOFT_REDIS_CONF_PATHS = [
  "/www/server/redis/redis.conf",
  "/www/server/redis/src/redis.conf",
];

/** 软件商店本机 Redis：读 redis.conf 的 port / requirepass。 */
export async function buildParamsFromBtSoftRedis(
  client: BtPanelClient,
): Promise<OnePanelAppInstalledParams> {
  let port = "6379";
  let password = "";
  for (const confPath of BT_SOFT_REDIS_CONF_PATHS) {
    try {
      const body = await client.getFileBody(confPath);
      const text = typeof body.data === "string" ? body.data : "";
      if (!text.trim()) continue;
      const parsed = parseBtRedisConf(text);
      port = parsed.port;
      password = parsed.password;
      break;
    } catch {
      // 尝试下一个路径
    }
  }
  return toRedisInstalledParams({
    port,
    password,
    type: "runtime",
  });
}

/**
 * 按应用市场 installId 解析宝塔 MySQL/MariaDB 连接参数。
 * 先软件商店（避免 soft id 与 docker appid 碰撞误走 Docker），再 Docker。
 */
export async function resolveBtInstalledMysqlParams(
  client: BtPanelClient,
  installId: number,
): Promise<OnePanelAppInstalledParams> {
  if (!Number.isFinite(installId)) {
    throw new Error("应用安装 ID 无效");
  }

  let softItems: BtSoftItem[] = [];
  try {
    const soft = await client.getSoftList({ p: 1, type: 0, query: "", force: 0, row: 300 });
    softItems = soft.items;
  } catch {
    softItems = [];
  }

  const softHit = softItems.find((item) => softItemMatchesInstallId(item, installId));
  if (softHit) {
    return buildParamsFromBtSoftMysql(client);
  }
  if (installId === BT_SOFT_MYSQL_FALLBACK_INSTALL_ID) {
    const anySoft = softItems.find(
      (item) => item.setup && isBtMysqlOrMariadbKey(item.name),
    );
    if (anySoft) return buildParamsFromBtSoftMysql(client);
  }

  try {
    const docker = await client.getInstalledApps({ p: 1, row: 500, appType: "all" });
    const hit = docker.items.find(
      (item) =>
        isBtMysqlOrMariadbKey(item.appname) &&
        (Number(item.id) === installId || Number(item.appid) === installId),
    );
    if (hit) return buildParamsFromBtDockerMysqlAsync(client, hit);
  } catch {
    // Docker 商店不可用
  }

  throw new Error("未找到对应的 MySQL/MariaDB 安装，或当前应用不支持一键管理");
}

/**
 * 按 installId 解析宝塔已装数据库类应用参数（MySQL / MariaDB / Redis）。
 * 先软件商店，再 Docker 已装列表。
 */
export async function resolveBtInstalledAppParams(
  client: BtPanelClient,
  installId: number,
): Promise<OnePanelAppInstalledParams> {
  if (!Number.isFinite(installId)) {
    throw new Error("应用安装 ID 无效");
  }

  let softItems: BtSoftItem[] = [];
  try {
    const soft = await client.getSoftList({ p: 1, type: 0, query: "", force: 0, row: 300 });
    softItems = soft.items;
  } catch {
    softItems = [];
  }

  const softMysql = softItems.find((item) => softItemMatchesInstallId(item, installId));
  if (softMysql) return buildParamsFromBtSoftMysql(client);
  if (installId === BT_SOFT_MYSQL_FALLBACK_INSTALL_ID) {
    const anySoft = softItems.find(
      (item) => item.setup && isBtMysqlOrMariadbKey(item.name),
    );
    if (anySoft) return buildParamsFromBtSoftMysql(client);
  }

  const softRedis = softItems.find((item) => softItemMatchesRedisInstallId(item, installId));
  if (softRedis) return buildParamsFromBtSoftRedis(client);
  if (installId === BT_SOFT_REDIS_FALLBACK_INSTALL_ID) {
    const anySoft = softItems.find((item) => item.setup && isBtRedisKey(item.name));
    if (anySoft) return buildParamsFromBtSoftRedis(client);
  }

  try {
    const docker = await client.getInstalledApps({ p: 1, row: 500, appType: "all" });
    const mysqlHit = docker.items.find(
      (item) =>
        isBtMysqlOrMariadbKey(item.appname) &&
        (Number(item.id) === installId || Number(item.appid) === installId),
    );
    if (mysqlHit) return buildParamsFromBtDockerMysqlAsync(client, mysqlHit);

    const redisHit = docker.items.find(
      (item) =>
        isBtRedisKey(item.appname) &&
        (Number(item.id) === installId || Number(item.appid) === installId),
    );
    if (redisHit) return buildParamsFromBtDockerRedisAsync(client, redisHit);
  } catch {
    // Docker 商店不可用
  }

  throw new Error("未找到对应的数据库应用安装，或当前应用不支持一键管理");
}
