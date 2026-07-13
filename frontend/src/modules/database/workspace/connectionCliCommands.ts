import type { Connection } from "../../../ipc/bindings";
import type { DbConnectionConfig } from "../api";
import type { MysqlDeploymentInfo } from "../mysqlDeploymentDetect";
import { resolveDockerExecTarget } from "../dockerContainerResolve";
import {
  findSshConnectionForDbHostSync,
  hostsMatch,
} from "../mysqlSlowQueryLog";
import type { RedisDeploymentInfo } from "../redisDeploymentDetect";
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

function resolveDockerContainerName(
  deployment: MysqlDeploymentInfo | RedisDeploymentInfo | null,
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

function listMysqlTerminalModes(
  t: TranslateFn,
  connection: DbConnectionConfig,
  deployment: MysqlDeploymentInfo | null,
  sshConnections: Connection[],
): CliTerminalModeOption[] {
  const kind = deployment?.kind ?? "unknown";
  const ssh = resolveSshConnection(deployment, sshConnections, connection.host);

  if (kind === "docker") {
    const container = resolveDockerContainerName(deployment);
    if (container && ssh) {
      return [
        {
          id: "docker-exec",
          title: t("database.connectionInfo.cli.dockerFlow"),
          paneType: "remote",
          resourceId: ssh.id,
          launchSteps: buildMysqlDockerFlowSteps(connection, container),
        },
      ];
    }
    return [];
  }

  if (kind === "host" && ssh) {
    return [
      {
        id: "on-server",
        title: t("database.connectionInfo.cli.hostFlow"),
        paneType: "remote",
        resourceId: ssh.id,
        launchSteps: [formatMysqlCli(connection, "127.0.0.1")],
      },
    ];
  }

  return [
    {
      id: "direct",
      title: t("database.connectionInfo.cli.direct"),
      paneType: "local",
      resourceId: "local-terminal",
      launchSteps: [formatMysqlCli(connection, connection.host)],
    },
  ];
}

function listRedisTerminalModes(
  t: TranslateFn,
  connection: DbConnectionConfig,
  deployment: RedisDeploymentInfo | null,
  sshConnections: Connection[],
): CliTerminalModeOption[] {
  const kind = deployment?.kind ?? "unknown";
  const ssh = resolveSshConnection(deployment, sshConnections, connection.host);

  if (kind === "docker") {
    const container = resolveDockerContainerName(deployment);
    if (container && ssh) {
      return [
        {
          id: "docker-exec",
          title: t("database.connectionInfo.cli.dockerFlow"),
          paneType: "remote",
          resourceId: ssh.id,
          launchSteps: buildRedisDockerFlowSteps(connection, container),
        },
      ];
    }
    return [];
  }

  if (kind === "host" && ssh) {
    return [
      {
        id: "on-server",
        title: t("database.connectionInfo.cli.hostFlow"),
        paneType: "remote",
        resourceId: ssh.id,
        launchSteps: [formatRedisCli(connection, "127.0.0.1")],
      },
    ];
  }

  return [
    {
      id: "direct",
      title: t("database.connectionInfo.cli.direct"),
      paneType: "local",
      resourceId: "local-terminal",
      launchSteps: [formatRedisCli(connection, connection.host)],
    },
  ];
}

export function resolveDefaultCliTerminalModeId(
  _deployment: { kind?: string } | null,
  modes: CliTerminalModeOption[],
): CliTerminalModeId {
  if (modes.length === 0) {
    return "direct";
  }
  return modes[0]?.id ?? "direct";
}

export function describeCliTerminalFlow(
  t: TranslateFn,
  deployment: { kind?: string } | null,
  mode: CliTerminalModeOption | null,
): CliTerminalFlowStep[] {
  const kind = deployment?.kind ?? "unknown";
  if (kind === "docker" && mode) {
    return [
      { label: t("database.connectionInfo.cli.stepSsh") },
      { label: t("database.connectionInfo.cli.stepEnterContainer"), command: mode.launchSteps[0] },
      { label: t("database.connectionInfo.cli.stepClient"), command: mode.launchSteps[1] },
    ];
  }
  if (kind === "host" && mode) {
    return [
      { label: t("database.connectionInfo.cli.stepSsh") },
      { label: t("database.connectionInfo.cli.stepClient"), command: mode.launchSteps[0] },
    ];
  }
  if (mode) {
    return [
      {
        label: t("database.connectionInfo.cli.stepClientLocal"),
        command: mode.launchSteps[0],
      },
    ];
  }
  return [];
}

export function formatCliTerminalStepsText(steps: string[]): string {
  return steps.join("\n");
}

export function listCliTerminalModes(
  client: "mysql" | "redis",
  t: TranslateFn,
  connection: DbConnectionConfig,
  deployment: MysqlDeploymentInfo | RedisDeploymentInfo | null,
  sshConnections: Connection[],
): CliTerminalModeOption[] {
  return client === "mysql"
    ? listMysqlTerminalModes(t, connection, deployment as MysqlDeploymentInfo | null, sshConnections)
    : listRedisTerminalModes(t, connection, deployment as RedisDeploymentInfo | null, sshConnections);
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
