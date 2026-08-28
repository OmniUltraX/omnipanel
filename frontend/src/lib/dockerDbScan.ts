import type { ImportCandidate, ImporterContribution, ImporterScannerRule } from "@omnipanel/plugin-sdk";
import { commands, type Connection, type DockerConnectionInfo, type DockerContainerSummary, type DockerKeyValue, type DockerPort } from "../ipc/bindings";
import { unwrapCommand } from "../ipc/result";

export const LOCAL_DOCKER_CONNECTION_ID = "docker-local";

export type DockerScanSkipReason =
  | "not-running"
  | "no-rule"
  | "unpublished-port"
  | "container-ip"
  | "unresolved-host"
  | "inspect-failed";

export type DockerScanSkip = {
  containerId: string;
  name: string;
  reason: DockerScanSkipReason;
};

export type DockerScanOutcome =
  | { candidate: ImportCandidate; skip?: undefined }
  | { candidate?: undefined; skip: DockerScanSkip };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function parseConnectionConfig(conn?: Connection | null): Record<string, unknown> {
  if (!conn?.config) return {};
  try {
    return asRecord(JSON.parse(conn.config));
  } catch {
    return {};
  }
}

export function imageMatchesNeedle(image: string, needle: string): boolean {
  const lower = (image.toLowerCase().split("@")[0] ?? "").trim();
  const lastSlash = lower.lastIndexOf("/");
  const lastColon = lower.lastIndexOf(":");
  const untagged = lastColon > lastSlash ? lower.slice(0, lastColon) : lower;
  const segments = untagged.split("/").filter(Boolean);
  const name = segments[segments.length - 1] ?? "";
  const n = needle.toLowerCase();
  const hit = (part: string) =>
    part === n || part.startsWith(`${n}-`) || part.endsWith(`-${n}`) || part.includes(n);
  return hit(name) || segments.some((part) => part === n || part.startsWith(`${n}-`) || part.endsWith(`-${n}`));
}

export function matchScannerRule(
  image: string,
  rules: ImporterScannerRule[],
): ImporterScannerRule | null {
  return rules.find((rule) => rule.images.some((needle) => imageMatchesNeedle(image, needle))) ?? null;
}

export function publishedPort(ports: DockerPort[], privatePort: number): number | null {
  const match = ports.find((port) => port.privatePort === privatePort && (port.publicPort ?? 0) > 0);
  return match?.publicPort ?? null;
}

/** Docker 默认桥 172.17.0.0/16，禁止当作数据库 host。局域网引擎地址（10.x / 192.168.x）允许。 */
export function isContainerLanHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (!h || h === "localhost" || h === "127.0.0.1" || h === "::1") return false;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  return Number(m[1]) === 172 && Number(m[2]) === 17;
}

export function stripHostUserAndPort(host: string): string {
  const trimmed = host.trim();
  const afterAt = trimmed.includes("@") ? trimmed.slice(trimmed.lastIndexOf("@") + 1) : trimmed;
  if (afterAt.startsWith("[")) {
    const end = afterAt.indexOf("]");
    return end >= 0 ? afterAt.slice(1, end) : afterAt;
  }
  const colon = afterAt.lastIndexOf(":");
  if (colon > 0 && /^\d+$/.test(afterAt.slice(colon + 1))) {
    return afterAt.slice(0, colon);
  }
  return afterAt;
}

export function hostnameFromUrl(url: string): string | null {
  try {
    const host = new URL(url).hostname.trim();
    return host || null;
  } catch {
    return null;
  }
}

export function envMap(env: DockerKeyValue[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of env) {
    if (item.key) out[item.key] = item.value;
  }
  return out;
}

/** Neo4j 官方镜像用 `NEO4J_AUTH=user/password` 或 `none`。 */
export function parseNeo4jAuth(raw: string): { user: string; password: string } | null {
  const auth = raw.trim();
  if (!auth || auth.toLowerCase() === "none") return { user: "neo4j", password: "" };
  const slash = auth.indexOf("/");
  if (slash <= 0 || slash === auth.length - 1) return null;
  return { user: auth.slice(0, slash), password: auth.slice(slash + 1) };
}

export function resolveScanCredentials(
  rule: ImporterScannerRule,
  env: Record<string, string>,
): { user: string; password: string } {
  if (rule.dbType === "neo4j" && env.NEO4J_AUTH) {
    const parsed = parseNeo4jAuth(env.NEO4J_AUTH);
    if (parsed) return parsed;
  }
  return {
    user: pickEnv(env, rule.userEnv, rule.defaultUser ?? ""),
    password: pickEnv(env, rule.passwordEnv, rule.defaultPassword ?? ""),
  };
}

export function pickEnv(map: Record<string, string>, keys: string[], fallback = ""): string {
  for (const key of keys) {
    const value = map[key];
    if (value) return value;
  }
  return fallback;
}

export function resolveDockerReachableHost(input: {
  connectionId: string;
  source: DockerConnectionInfo["source"];
  hostLabel: string;
  dockerConfig?: Record<string, unknown>;
  sshHost?: string;
}): string | null {
  if (input.connectionId === LOCAL_DOCKER_CONNECTION_ID || input.source === "local-engine") {
    return "127.0.0.1";
  }
  const cfg = input.dockerConfig ?? {};
  const accept = (raw: string | undefined): string | null => {
    if (!raw?.trim()) return null;
    const host = stripHostUserAndPort(raw);
    if (!host || isContainerLanHost(host)) return null;
    return host;
  };

  if (input.source === "remote-engine") {
    const host = accept(typeof cfg.host === "string" ? cfg.host : undefined);
    if (host) return host;
  }

  const fromSsh = accept(input.sshHost);
  if (fromSsh) return fromSsh;

  const ssh = asRecord(cfg.ssh);
  const fromCfgSsh = accept(typeof ssh.host === "string" ? ssh.host : undefined);
  if (fromCfgSsh) return fromCfgSsh;

  const onepanel = asRecord(cfg.onepanel);
  const btpanel = asRecord(cfg.btpanel);
  const panel = asRecord(cfg.panel);
  const panelUrl =
    (typeof onepanel.baseUrl === "string" && onepanel.baseUrl) ||
    (typeof btpanel.baseUrl === "string" && btpanel.baseUrl) ||
    (typeof panel.baseUrl === "string" && panel.baseUrl) ||
    "";
  if (panelUrl) {
    const host = accept(hostnameFromUrl(panelUrl) ?? undefined);
    if (host) return host;
  }

  if (input.source === "remote-engine") return null;
  return accept(input.hostLabel);
}

export function sshHostFromConnections(
  docker: DockerConnectionInfo,
  connections: Connection[],
): string | undefined {
  const dockerCfg = parseConnectionConfig(connections.find((item) => item.id === docker.connectionId));
  const boundId =
    docker.boundSshConnectionId?.trim() ||
    (typeof dockerCfg.boundSshConnectionId === "string" ? dockerCfg.boundSshConnectionId.trim() : "");
  if (!boundId) {
    const ssh = asRecord(dockerCfg.ssh);
    return typeof ssh.host === "string" ? ssh.host : undefined;
  }
  const sshConn = connections.find((item) => item.id === boundId);
  const sshCfg = parseConnectionConfig(sshConn);
  return typeof sshCfg.host === "string" ? sshCfg.host : undefined;
}

function containerDisplayName(container: Pick<DockerContainerSummary, "name">): string {
  return container.name.replace(/^\//, "") || container.name;
}

export function scanContainerToCandidate(input: {
  pluginId: string;
  accountId: string;
  host: string;
  container: Pick<
    DockerContainerSummary,
    "id" | "name" | "image" | "running" | "ports" | "composeProject" | "ipAddress"
  >;
  env: DockerKeyValue[];
  rules: ImporterScannerRule[];
  defaultGroup?: string;
}): DockerScanOutcome {
  const name = containerDisplayName(input.container);
  if (!input.container.running) {
    return { skip: { containerId: input.container.id, name, reason: "not-running" } };
  }
  const rule = matchScannerRule(input.container.image, input.rules);
  if (!rule) {
    return { skip: { containerId: input.container.id, name, reason: "no-rule" } };
  }
  if (isContainerLanHost(input.host)) {
    return { skip: { containerId: input.container.id, name, reason: "container-ip" } };
  }
  const port = publishedPort(input.container.ports, rule.defaultPort);
  if (port == null) {
    return { skip: { containerId: input.container.id, name, reason: "unpublished-port" } };
  }
  const env = envMap(input.env);
  const creds = resolveScanCredentials(rule, env);
  const user = creds.user;
  const password = creds.password;
  const database = pickEnv(env, rule.databaseEnv);
  const compose = input.container.composeProject?.trim() ?? "";
  return {
    candidate: {
      pluginId: input.pluginId,
      accountId: input.accountId,
      remoteId: input.container.id,
      remoteKind: rule.dbType,
      name,
      config: {
        host: input.host,
        port,
        user,
        ...(password ? { password } : {}),
        database,
        ...(compose ? { importGroup: compose } : input.defaultGroup ? { importGroup: input.defaultGroup } : {}),
      },
    },
  };
}

export async function scanDockerDatabases(opts: {
  pluginId: string;
  importer: ImporterContribution;
  docker: DockerConnectionInfo;
  connections: Connection[];
}): Promise<{ candidates: ImportCandidate[]; skipped: number }> {
  const rules = opts.importer.scanners ?? [];
  if (rules.length === 0) {
    throw new Error("导入器未声明 scanners");
  }
  const dockerCfg = parseConnectionConfig(
    opts.connections.find((item) => item.id === opts.docker.connectionId),
  );
  const host = resolveDockerReachableHost({
    connectionId: opts.docker.connectionId,
    source: opts.docker.source,
    hostLabel: opts.docker.hostLabel,
    dockerConfig: dockerCfg,
    sshHost: sshHostFromConnections(opts.docker, opts.connections),
  });
  if (!host) {
    throw new Error(`无法解析 Docker 引擎可达地址：${opts.docker.name}`);
  }
  const containers = await unwrapCommand(commands.dockerListContainers(opts.docker.connectionId, "running"));
  const candidates: ImportCandidate[] = [];
  let skipped = 0;
  for (const container of containers) {
    if (!matchScannerRule(container.image, rules)) continue;
    let env: DockerKeyValue[] = [];
    try {
      const detail = await unwrapCommand(
        commands.dockerInspectContainer(opts.docker.connectionId, container.id),
      );
      env = detail.env;
    } catch {
      skipped += 1;
      continue;
    }
    const outcome = scanContainerToCandidate({
      pluginId: opts.pluginId,
      accountId: opts.docker.connectionId,
      host,
      container,
      env,
      rules,
      defaultGroup: opts.importer.defaultGroup,
    });
    if (outcome.candidate) candidates.push(outcome.candidate);
    else if (outcome.skip.reason !== "no-rule" && outcome.skip.reason !== "not-running") skipped += 1;
  }
  return { candidates, skipped };
}
