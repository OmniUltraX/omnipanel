import type { Connection } from "../../../ipc/bindings";
import type { DbConnectionConfig } from "../api";
import type { MysqlDeploymentInfo } from "../mysqlDeploymentDetect";
import { resolveDockerExecTarget } from "../dockerContainerResolve";
import {
  findSshConnectionForDbHostSync,
  hostsMatch,
} from "../mysqlSlowQueryLog";
import type { RedisDeploymentInfo } from "../redisDeploymentDetect";
import type { PostgresDeploymentInfo } from "../postgresDeploymentDetect";
import { parseSshConfig } from "../../server/panel/serverConnection";

export interface CliCommandSection {
  id: string;
  title: string;
  command: string;
  description?: string;
}

type TranslateFn = (key: string, params?: Record<string, string | number>) => string;

function formatCliArg(value: string): string {
  if (/^[A-Za-z0-9_@.%/:+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildSshLoginCommand(ssh: Connection): string | null {
  const cfg = parseSshConfig(ssh);
  if (!cfg?.host) {
    return null;
  }
  const portPart = cfg.port && cfg.port !== 22 ? ` -p ${cfg.port}` : "";
  const user = cfg.user?.trim() || "root";
  return `ssh${portPart} ${user}@${cfg.host}`;
}

function resolveSshConnection(
  deployment: { sshConnectionId?: string } | null | undefined,
  sshConnections: Connection[],
  dbHost: string,
): Connection | undefined {
  if (deployment?.sshConnectionId) {
    const matched = sshConnections.find((conn) => conn.id === deployment.sshConnectionId);
    if (matched) {
      return matched;
    }
  }
  return findSshConnectionForDbHostSync(sshConnections, dbHost);
}

function dedupeSections(sections: CliCommandSection[]): CliCommandSection[] {
  const seen = new Set<string>();
  const next: CliCommandSection[] = [];
  for (const section of sections) {
    const key = section.command.trim();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    next.push(section);
  }
  return next;
}

function formatMysqlCli(connection: DbConnectionConfig, host: string, port?: number): string {
  const tokens = ["mysql"];
  tokens.push("-h", formatCliArg(host));
  tokens.push("-P", String(port ?? connection.port));
  if (connection.user?.trim()) {
    tokens.push("-u", formatCliArg(connection.user.trim()));
  }
  if (connection.password) {
    tokens.push(`-p${formatCliArg(connection.password)}`);
  } else {
    tokens.push("-p");
  }
  if (connection.ssl) {
    tokens.push("--ssl-mode=REQUIRED");
  }
  const database = connection.database?.trim();
  if (database) {
    tokens.push(formatCliArg(database));
  }
  return tokens.join(" ");
}

function formatRedisCli(connection: DbConnectionConfig, host: string, port?: number): string {
  const tokens = ["redis-cli"];
  tokens.push("-h", formatCliArg(host));
  tokens.push("-p", String(port ?? connection.port));
  if (connection.user?.trim()) {
    tokens.push("--user", formatCliArg(connection.user.trim()));
  }
  if (connection.password) {
    tokens.push("-a", formatCliArg(connection.password));
  }
  return tokens.join(" ");
}

function formatPsqlCli(connection: DbConnectionConfig, host: string, port?: number): string {
  // psql 用 URI 或分开参数；这里用分开参数更易读，与 mysql/redis 一致
  const tokens = ["psql"];
  tokens.push("-h", formatCliArg(host));
  tokens.push("-p", String(port ?? connection.port));
  if (connection.user?.trim()) {
    tokens.push("-U", formatCliArg(connection.user.trim()));
  }
  const database = connection.database?.trim();
  if (database) {
    tokens.push("-d", formatCliArg(database));
  }
  // psql 没有 -p<password> 这种形式，密码通过 PGPASSWORD 环境变量传递
  // 这里在命令前加 PGPASSWORD 前缀（仅 local shell 模式可用）
  if (connection.password) {
    return `PGPASSWORD=${formatCliArg(connection.password)} ${tokens.join(" ")}`;
  }
  return tokens.join(" ");
}

function resolveDockerContainerName(
  deployment:
    | MysqlDeploymentInfo
    | RedisDeploymentInfo
    | PostgresDeploymentInfo
    | null,
): string | null {
  return resolveDockerExecTarget({
    containerId: deployment?.containerId,
    containerName: deployment?.containerName,
    locationTag: deployment?.locationTag,
  });
}

function maybeAddSshSection(
  t: TranslateFn,
  sections: CliCommandSection[],
  ssh: Connection | undefined,
): void {
  if (!ssh) {
    return;
  }
  const command = buildSshLoginCommand(ssh);
  if (!command) {
    return;
  }
  sections.push({
    id: "ssh",
    title: t("database.connectionInfo.cli.sshLogin"),
    command,
    description: t("database.connectionInfo.cli.sshLoginHint"),
  });
}

function maybeAddSshTunnelMysqlSection(
  t: TranslateFn,
  sections: CliCommandSection[],
  connection: DbConnectionConfig,
  ssh: Connection | undefined,
  kind: string,
): void {
  if (!ssh || hostsMatch(connection.host, "127.0.0.1")) {
    return;
  }
  const cfg = parseSshConfig(ssh);
  if (!cfg?.host) {
    return;
  }
  const localPort = connection.port === 3306 ? 3307 : connection.port + 10000;
  const portPart = cfg.port && cfg.port !== 22 ? ` -p ${cfg.port}` : "";
  const user = cfg.user?.trim() || "root";
  const tunnel = `ssh -L ${localPort}:127.0.0.1:${connection.port}${portPart} ${user}@${cfg.host}`;
  const client = formatMysqlCli(connection, "127.0.0.1", localPort);
  sections.push({
    id: "ssh-tunnel",
    title: t("database.connectionInfo.cli.sshTunnel"),
    command: `${tunnel}\n${client}`,
    description:
      kind === "docker"
        ? t("database.connectionInfo.cli.sshTunnelMysqlDockerHint")
        : t("database.connectionInfo.cli.sshTunnelMysqlHint"),
  });
}

function maybeAddSshTunnelRedisSection(
  t: TranslateFn,
  sections: CliCommandSection[],
  connection: DbConnectionConfig,
  ssh: Connection | undefined,
  kind: string,
): void {
  if (!ssh || hostsMatch(connection.host, "127.0.0.1")) {
    return;
  }
  const cfg = parseSshConfig(ssh);
  if (!cfg?.host) {
    return;
  }
  const localPort = connection.port === 6379 ? 6380 : connection.port + 10000;
  const portPart = cfg.port && cfg.port !== 22 ? ` -p ${cfg.port}` : "";
  const user = cfg.user?.trim() || "root";
  const tunnel = `ssh -L ${localPort}:127.0.0.1:${connection.port}${portPart} ${user}@${cfg.host}`;
  const client = formatRedisCli(connection, "127.0.0.1", localPort);
  sections.push({
    id: "ssh-tunnel",
    title: t("database.connectionInfo.cli.sshTunnel"),
    command: `${tunnel}\n${client}`,
    description:
      kind === "docker"
        ? t("database.connectionInfo.cli.sshTunnelRedisDockerHint")
        : t("database.connectionInfo.cli.sshTunnelRedisHint"),
  });
}

function maybeAddSshTunnelPostgresSection(
  t: TranslateFn,
  sections: CliCommandSection[],
  connection: DbConnectionConfig,
  ssh: Connection | undefined,
  kind: string,
): void {
  if (!ssh || hostsMatch(connection.host, "127.0.0.1")) {
    return;
  }
  const cfg = parseSshConfig(ssh);
  if (!cfg?.host) {
    return;
  }
  const localPort = connection.port === 5432 ? 5433 : connection.port + 10000;
  const portPart = cfg.port && cfg.port !== 22 ? ` -p ${cfg.port}` : "";
  const user = cfg.user?.trim() || "root";
  const tunnel = `ssh -L ${localPort}:127.0.0.1:${connection.port}${portPart} ${user}@${cfg.host}`;
  const client = formatPsqlCli(connection, "127.0.0.1", localPort);
  sections.push({
    id: "ssh-tunnel",
    title: t("database.connectionInfo.cli.sshTunnel"),
    command: `${tunnel}\n${client}`,
    description:
      kind === "docker"
        ? t("database.connectionInfo.cli.sshTunnelPostgresDockerHint")
        : t("database.connectionInfo.cli.sshTunnelPostgresHint"),
  });
}

export type CliTerminalModeId = "direct" | "on-server" | "docker-exec";

export interface CliTerminalModeOption {
  id: CliTerminalModeId;
  title: string;
  paneType: "local" | "remote";
  resourceId: string;
  /** SSH/本地 Shell 就绪后依次执行的命令（SSH 连接由终端 Pane 自动完成） */
  launchSteps: string[];
}

export interface CliTerminalFlowStep {
  label: string;
  command?: string;
}

function formatMysqlCliInContainer(connection: DbConnectionConfig): string {
  const tokens = ["mysql"];
  if (connection.user?.trim()) {
    tokens.push("-u", formatCliArg(connection.user.trim()));
  }
  if (connection.password) {
    tokens.push(`-p${formatCliArg(connection.password)}`);
  } else {
    tokens.push("-p");
  }
  const database = connection.database?.trim();
  if (database) {
    tokens.push(formatCliArg(database));
  }
  return tokens.join(" ");
}

function formatRedisCliInContainer(connection: DbConnectionConfig): string {
  const tokens = ["redis-cli"];
  if (connection.user?.trim()) {
    tokens.push("--user", formatCliArg(connection.user.trim()));
  }
  if (connection.password) {
    tokens.push("-a", formatCliArg(connection.password));
  }
  return tokens.join(" ");
}

function formatPsqlCliInContainer(connection: DbConnectionConfig): string {
  // 容器内执行：host 为本地 socket，省略 -h；密码通过 PGPASSWORD 前缀传递
  const tokens = ["psql"];
  if (connection.user?.trim()) {
    tokens.push("-U", formatCliArg(connection.user.trim()));
  }
  const database = connection.database?.trim();
  if (database) {
    tokens.push("-d", formatCliArg(database));
  }
  if (connection.password) {
    return `PGPASSWORD=${formatCliArg(connection.password)} ${tokens.join(" ")}`;
  }
  return tokens.join(" ");
}

function buildDockerShellEnterCommand(container: string): string {
  return `docker exec -it ${formatCliArg(container)} sh`;
}

function buildMysqlDockerFlowSteps(
  connection: DbConnectionConfig,
  container: string,
): string[] {
  return [buildDockerShellEnterCommand(container), formatMysqlCliInContainer(connection)];
}

function buildRedisDockerFlowSteps(
  connection: DbConnectionConfig,
  container: string,
): string[] {
  return [buildDockerShellEnterCommand(container), formatRedisCliInContainer(connection)];
}

function buildPostgresDockerFlowSteps(
  connection: DbConnectionConfig,
  container: string,
): string[] {
  return [buildDockerShellEnterCommand(container), formatPsqlCliInContainer(connection)];
}

function buildDirectTerminalMode(
  t: TranslateFn,
  launchSteps: string[],
): CliTerminalModeOption {
  return {
    id: "direct",
    title: t("database.connectionInfo.cli.direct"),
    paneType: "local",
    resourceId: "local-terminal",
    launchSteps,
  };
}

function listMysqlTerminalModes(
  t: TranslateFn,
  connection: DbConnectionConfig,
  deployment: MysqlDeploymentInfo | null,
  sshConnections: Connection[],
): CliTerminalModeOption[] {
  const kind = deployment?.kind ?? "unknown";
  const ssh = resolveSshConnection(deployment, sshConnections, connection.host);
  // 与 Navicat 一致：默认用连接信息本机直连；SSH/Docker 仅作可选运维入口
  const modes: CliTerminalModeOption[] = [
    buildDirectTerminalMode(t, [formatMysqlCli(connection, connection.host)]),
  ];

  if (kind === "docker") {
    const container = resolveDockerContainerName(deployment);
    if (container && ssh) {
      modes.push({
        id: "docker-exec",
        title: t("database.connectionInfo.cli.dockerFlow"),
        paneType: "remote",
        resourceId: ssh.id,
        launchSteps: buildMysqlDockerFlowSteps(connection, container),
      });
    }
  } else if (kind === "host" && ssh) {
    modes.push({
      id: "on-server",
      title: t("database.connectionInfo.cli.hostFlow"),
      paneType: "remote",
      resourceId: ssh.id,
      launchSteps: [formatMysqlCli(connection, "127.0.0.1")],
    });
  }

  return modes;
}

function listRedisTerminalModes(
  t: TranslateFn,
  connection: DbConnectionConfig,
  deployment: RedisDeploymentInfo | null,
  sshConnections: Connection[],
): CliTerminalModeOption[] {
  const kind = deployment?.kind ?? "unknown";
  const ssh = resolveSshConnection(deployment, sshConnections, connection.host);
  const modes: CliTerminalModeOption[] = [
    buildDirectTerminalMode(t, [formatRedisCli(connection, connection.host)]),
  ];

  if (kind === "docker") {
    const container = resolveDockerContainerName(deployment);
    if (container && ssh) {
      modes.push({
        id: "docker-exec",
        title: t("database.connectionInfo.cli.dockerFlow"),
        paneType: "remote",
        resourceId: ssh.id,
        launchSteps: buildRedisDockerFlowSteps(connection, container),
      });
    }
  } else if (kind === "host" && ssh) {
    modes.push({
      id: "on-server",
      title: t("database.connectionInfo.cli.hostFlow"),
      paneType: "remote",
      resourceId: ssh.id,
      launchSteps: [formatRedisCli(connection, "127.0.0.1")],
    });
  }

  return modes;
}

function listPostgresTerminalModes(
  t: TranslateFn,
  connection: DbConnectionConfig,
  deployment: PostgresDeploymentInfo | null,
  sshConnections: Connection[],
): CliTerminalModeOption[] {
  const kind = deployment?.kind ?? "unknown";
  const ssh = resolveSshConnection(deployment, sshConnections, connection.host);
  const modes: CliTerminalModeOption[] = [
    buildDirectTerminalMode(t, [formatPsqlCli(connection, connection.host)]),
  ];

  if (kind === "docker") {
    const container = resolveDockerContainerName(deployment);
    if (container && ssh) {
      modes.push({
        id: "docker-exec",
        title: t("database.connectionInfo.cli.dockerFlow"),
        paneType: "remote",
        resourceId: ssh.id,
        launchSteps: buildPostgresDockerFlowSteps(connection, container),
      });
    }
  } else if (kind === "host" && ssh) {
    modes.push({
      id: "on-server",
      title: t("database.connectionInfo.cli.hostFlow"),
      paneType: "remote",
      resourceId: ssh.id,
      launchSteps: [formatPsqlCli(connection, "127.0.0.1")],
    });
  }

  return modes;
}

export function resolveDefaultCliTerminalModeId(
  _deployment: { kind?: string } | null,
  modes: CliTerminalModeOption[],
): CliTerminalModeId {
  if (modes.some((mode) => mode.id === "direct")) {
    return "direct";
  }
  return modes[0]?.id ?? "direct";
}

export function describeCliTerminalFlow(
  t: TranslateFn,
  _deployment: { kind?: string } | null,
  mode: CliTerminalModeOption | null,
): CliTerminalFlowStep[] {
  if (!mode) {
    return [];
  }
  if (mode.id === "docker-exec") {
    return [
      { label: t("database.connectionInfo.cli.stepSsh") },
      { label: t("database.connectionInfo.cli.stepEnterContainer"), command: mode.launchSteps[0] },
      { label: t("database.connectionInfo.cli.stepClient"), command: mode.launchSteps[1] },
    ];
  }
  if (mode.id === "on-server") {
    return [
      { label: t("database.connectionInfo.cli.stepSsh") },
      { label: t("database.connectionInfo.cli.stepClient"), command: mode.launchSteps[0] },
    ];
  }
  return [
    {
      label: t("database.connectionInfo.cli.stepClientLocal"),
      command: mode.launchSteps[0],
    },
  ];
}

export function formatCliTerminalStepsText(steps: string[]): string {
  return steps.join("\n");
}

export function listCliTerminalModes(
  client: "mysql" | "redis" | "psql",
  t: TranslateFn,
  connection: DbConnectionConfig,
  deployment: MysqlDeploymentInfo | RedisDeploymentInfo | PostgresDeploymentInfo | null,
  sshConnections: Connection[],
): CliTerminalModeOption[] {
  if (client === "mysql") {
    return listMysqlTerminalModes(
      t,
      connection,
      deployment as MysqlDeploymentInfo | null,
      sshConnections,
    );
  }
  if (client === "psql") {
    return listPostgresTerminalModes(
      t,
      connection,
      deployment as PostgresDeploymentInfo | null,
      sshConnections,
    );
  }
  return listRedisTerminalModes(
    t,
    connection,
    deployment as RedisDeploymentInfo | null,
    sshConnections,
  );
}

export function buildMysqlCliSections(
  t: TranslateFn,
  connection: DbConnectionConfig,
  deployment: MysqlDeploymentInfo | null,
  sshConnections: Connection[],
): CliCommandSection[] {
  const sections: CliCommandSection[] = [];
  const kind = deployment?.kind ?? "unknown";
  const ssh = resolveSshConnection(deployment, sshConnections, connection.host);

  maybeAddSshSection(t, sections, ssh);

  if (kind === "docker") {
    const container = resolveDockerContainerName(deployment);
    if (container) {
      sections.push({
        id: "docker-enter",
        title: t("database.connectionInfo.cli.stepEnterContainer"),
        command: buildDockerShellEnterCommand(container),
        description: t("database.connectionInfo.cli.dockerEnterHint"),
      });
      sections.push({
        id: "docker-client",
        title: t("database.connectionInfo.cli.stepClient"),
        command: formatMysqlCliInContainer(connection),
        description: t("database.connectionInfo.cli.dockerClientMysqlHint"),
      });
    }
  }

  if (kind === "host") {
    sections.push({
      id: "on-server",
      title: t("database.connectionInfo.cli.stepClient"),
      command: formatMysqlCli(connection, "127.0.0.1"),
      description: t("database.connectionInfo.cli.onServerMysqlHint"),
    });
  }

  if (kind === "unknown") {
    sections.push({
      id: "direct",
      title: t("database.connectionInfo.cli.direct"),
      command: formatMysqlCli(connection, connection.host),
      description: t("database.connectionInfo.cli.directMysqlHint"),
    });
    maybeAddSshTunnelMysqlSection(t, sections, connection, ssh, kind);
  }

  return dedupeSections(sections);
}

/** 根据 Redis 部署方式生成 redis-cli 连接命令。 */
export function buildRedisCliSections(
  t: TranslateFn,
  connection: DbConnectionConfig,
  deployment: RedisDeploymentInfo | null,
  sshConnections: Connection[],
): CliCommandSection[] {
  const sections: CliCommandSection[] = [];
  const kind = deployment?.kind ?? "unknown";
  const ssh = resolveSshConnection(deployment, sshConnections, connection.host);

  maybeAddSshSection(t, sections, ssh);

  if (kind === "docker") {
    const container = resolveDockerContainerName(deployment);
    if (container) {
      sections.push({
        id: "docker-enter",
        title: t("database.connectionInfo.cli.stepEnterContainer"),
        command: buildDockerShellEnterCommand(container),
        description: t("database.connectionInfo.cli.dockerEnterHint"),
      });
      sections.push({
        id: "docker-client",
        title: t("database.connectionInfo.cli.stepClient"),
        command: formatRedisCliInContainer(connection),
        description: t("database.connectionInfo.cli.dockerClientRedisHint"),
      });
    }
  }

  if (kind === "host") {
    sections.push({
      id: "on-server",
      title: t("database.connectionInfo.cli.stepClient"),
      command: formatRedisCli(connection, "127.0.0.1"),
      description: t("database.connectionInfo.cli.onServerRedisHint"),
    });
  }

  if (kind === "unknown") {
    sections.push({
      id: "direct",
      title: t("database.connectionInfo.cli.direct"),
      command: formatRedisCli(connection, connection.host),
      description: t("database.connectionInfo.cli.directRedisHint"),
    });
    maybeAddSshTunnelRedisSection(t, sections, connection, ssh, kind);
  }

  return dedupeSections(sections);
}

/** 根据 PostgreSQL 部署方式生成 psql 连接命令。 */
export function buildPostgresCliSections(
  t: TranslateFn,
  connection: DbConnectionConfig,
  deployment: PostgresDeploymentInfo | null,
  sshConnections: Connection[],
): CliCommandSection[] {
  const sections: CliCommandSection[] = [];
  const kind = deployment?.kind ?? "unknown";
  const ssh = resolveSshConnection(deployment, sshConnections, connection.host);

  maybeAddSshSection(t, sections, ssh);

  if (kind === "docker") {
    const container = resolveDockerContainerName(deployment);
    if (container) {
      sections.push({
        id: "docker-enter",
        title: t("database.connectionInfo.cli.stepEnterContainer"),
        command: buildDockerShellEnterCommand(container),
        description: t("database.connectionInfo.cli.dockerEnterHint"),
      });
      sections.push({
        id: "docker-client",
        title: t("database.connectionInfo.cli.stepClient"),
        command: formatPsqlCliInContainer(connection),
        description: t("database.connectionInfo.cli.dockerClientPostgresHint"),
      });
    }
  }

  if (kind === "host") {
    sections.push({
      id: "on-server",
      title: t("database.connectionInfo.cli.stepClient"),
      command: formatPsqlCli(connection, "127.0.0.1"),
      description: t("database.connectionInfo.cli.onServerPostgresHint"),
    });
  }

  if (kind === "unknown") {
    sections.push({
      id: "direct",
      title: t("database.connectionInfo.cli.direct"),
      command: formatPsqlCli(connection, connection.host),
      description: t("database.connectionInfo.cli.directPostgresHint"),
    });
    maybeAddSshTunnelPostgresSection(t, sections, connection, ssh, kind);
  }

  return dedupeSections(sections);
}
