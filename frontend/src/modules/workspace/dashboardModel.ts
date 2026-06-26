import type { Connection, DockerContainerSummary, HostSystemStats } from "../../ipc/bindings";
import type { WorkspaceAction } from "../../stores/actionStore";
import type { WorkspaceTabSnapshot } from "../../stores/workspaceTabStore";
import type { WorkspaceInfo } from "../../stores/workspaceStore";
import {
  ENVIRONMENT_LABELS,
  RESOURCE_TYPE_LABELS,
  type EnvironmentTag,
  type ResourceType,
} from "../../lib/resourceRegistry";
import { MODULE_PATHS, WORKSPACE_PATHS, modulePathForType } from "../../lib/paths";
import { LOCAL_TERMINAL_RESOURCE_ID } from "../terminal/paneResource";
import {
  formatUsageBytes,
  safePercent,
} from "../../stores/sshStatsStore";
import { connectionToResource } from "../../stores/connectionStore";

export type DashboardIconKind =
  | "terminal"
  | "database"
  | "ssh"
  | "docker"
  | "server"
  | "files"
  | "workflow"
  | "default";

export type DashboardWorkspaceCard = {
  id: string;
  name: string;
  meta: string[];
  path: string;
  iconKind: DashboardIconKind;
  iconBg: string;
  iconColor: string;
  isActive: boolean;
};

export type DashboardQuickConnect = {
  id: string;
  label: string;
  hint: string;
  path: string;
  resourceId?: string;
  iconKind: DashboardIconKind;
  placeholder?: boolean;
};

export type DashboardTaskRow = {
  id: string;
  name: string;
  info: string;
  dot: string;
  badge: "running" | "queued" | "blocked";
  path: string;
};

export type DashboardDraftRow = {
  id: string;
  title: string;
  time: string;
  dot: string;
  path: string;
};

export type DashboardResourceBar = {
  id: string;
  label: string;
  value: string;
  width: string;
  color: string;
};

export type DashboardContainerItem = {
  id: string;
  name: string;
  status: string;
  dot: string;
};

export type DashboardServerItem = {
  id: string;
  name: string;
  type: string;
  dot: string;
  resourceId: string;
  path: string;
};

const ICON_THEME: Record<
  DashboardIconKind,
  { bg: string; color: string }
> = {
  terminal: {
    bg: "color-mix(in oklch, var(--success) 15%, transparent)",
    color: "var(--success)",
  },
  database: {
    bg: "color-mix(in oklch, var(--warn) 15%, transparent)",
    color: "var(--warn)",
  },
  ssh: {
    bg: "color-mix(in oklch, var(--accent) 15%, transparent)",
    color: "var(--accent)",
  },
  docker: {
    bg: "color-mix(in oklch, var(--accent) 12%, transparent)",
    color: "var(--accent)",
  },
  server: {
    bg: "color-mix(in oklch, var(--meta) 18%, transparent)",
    color: "var(--meta)",
  },
  files: {
    bg: "color-mix(in oklch, var(--success) 12%, transparent)",
    color: "var(--success)",
  },
  workflow: {
    bg: "color-mix(in oklch, var(--warn) 12%, transparent)",
    color: "var(--warn)",
  },
  default: {
    bg: "color-mix(in oklch, var(--meta) 15%, transparent)",
    color: "var(--meta)",
  },
};

export function iconTheme(kind: DashboardIconKind) {
  return ICON_THEME[kind] ?? ICON_THEME.default;
}

function iconKindFromModule(module: WorkspaceTabSnapshot["module"]): DashboardIconKind {
  switch (module) {
    case "terminal":
      return "terminal";
    case "database":
      return "database";
    case "docker":
      return "docker";
    default:
      return "default";
  }
}

function iconKindFromConnection(kind: Connection["kind"]): DashboardIconKind {
  switch (kind) {
    case "ssh":
      return "ssh";
    case "database":
      return "database";
    case "docker":
      return "docker";
    case "panel":
      return "server";
    case "file":
      return "files";
    default:
      return "default";
  }
}

export function metricColor(pct: number): string {
  if (pct >= 85) return "var(--danger)";
  if (pct >= 65) return "var(--warn)";
  return "var(--success)";
}

export function formatRelativeTime(
  timestamp: number,
  labels: { justNow: string; minutes: string; hours: string; days: string },
): string {
  const diff = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return labels.justNow;
  if (minutes < 60) return labels.minutes.replace("{n}", String(minutes));
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return labels.hours.replace("{n}", String(hours));
  const days = Math.floor(hours / 24);
  return labels.days.replace("{n}", String(days));
}

export function buildWorkspaceCards(
  workspaces: WorkspaceInfo[],
  currentWorkspaceId: string,
  tabsByWorkspace: Record<string, WorkspaceTabSnapshot[]>,
  labels: {
    panels: (count: number) => string;
    noPanels: string;
    active: string;
  },
): DashboardWorkspaceCard[] {
  const sorted = [...workspaces].sort((a, b) => {
    if (a.id === currentWorkspaceId) return -1;
    if (b.id === currentWorkspaceId) return 1;
    return a.name.localeCompare(b.name, "zh-CN");
  });

  return sorted.slice(0, 3).map((workspace) => {
    const tabs = tabsByWorkspace[workspace.id] ?? [];
    const iconKind = tabs[0] ? iconKindFromModule(tabs[0].module) : "terminal";
    const theme = iconTheme(iconKind);
    const meta: string[] = [];
    if (workspace.id === currentWorkspaceId) {
      meta.push(labels.active);
    }
    meta.push(tabs.length > 0 ? labels.panels(tabs.length) : labels.noPanels);
    if (workspace.description?.trim()) {
      meta.push(workspace.description.trim());
    }
    return {
      id: workspace.id,
      name: workspace.name,
      meta,
      path: WORKSPACE_PATHS.detail(workspace.id),
      iconKind,
      iconBg: theme.bg,
      iconColor: theme.color,
      isActive: workspace.id === currentWorkspaceId,
    };
  });
}

const MODULE_SHORTCUTS: Array<{
  id: string;
  labelKey: DashboardIconKind;
  path: string;
  hint: string;
}> = [
  { id: "shortcut-terminal", labelKey: "terminal", path: MODULE_PATHS.terminal, hint: "local" },
  { id: "shortcut-ssh", labelKey: "ssh", path: MODULE_PATHS.ssh, hint: "ssh" },
  { id: "shortcut-database", labelKey: "database", path: MODULE_PATHS.database, hint: "database" },
  { id: "shortcut-docker", labelKey: "docker", path: MODULE_PATHS.docker, hint: "docker" },
  { id: "shortcut-files", labelKey: "files", path: MODULE_PATHS.files, hint: "files" },
];

export function buildQuickConnectItems(
  connections: Connection[],
  labels: {
    localTerminal: string;
    pendingSetup: string;
    typeLabel: (type: ResourceType) => string;
    envLabel: (env: EnvironmentTag) => string;
  },
): DashboardQuickConnect[] {
  if (connections.length === 0) {
    return MODULE_SHORTCUTS.map((item) => ({
      id: item.id,
      label:
        item.labelKey === "terminal"
          ? labels.localTerminal
          : labels.typeLabel(item.labelKey as ResourceType),
      hint: labels.pendingSetup,
      path: item.path,
      resourceId: item.labelKey === "terminal" ? LOCAL_TERMINAL_RESOURCE_ID : undefined,
      iconKind: item.labelKey,
      placeholder: true,
    }));
  }

  const sorted = [...connections].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const items: DashboardQuickConnect[] = [];
  const hasLocal = sorted.some((c) => c.id === LOCAL_TERMINAL_RESOURCE_ID);

  if (!hasLocal) {
    items.push({
      id: LOCAL_TERMINAL_RESOURCE_ID,
      label: labels.localTerminal,
      hint: labels.envLabel("local"),
      path: MODULE_PATHS.terminal,
      resourceId: LOCAL_TERMINAL_RESOURCE_ID,
      iconKind: "terminal",
    });
  }

  for (const connection of sorted) {
    if (items.length >= 5) break;
    const resource = connectionToResource(connection);
    items.push({
      id: connection.id,
      label: connection.name,
      hint: resource.subtitle || labels.typeLabel(resource.type),
      path: resource.modulePath,
      resourceId: connection.id,
      iconKind: iconKindFromConnection(connection.kind),
    });
  }

  return items.slice(0, 5);
}

function actionPath(action: WorkspaceAction): string {
  switch (action.type) {
    case "docker":
      return MODULE_PATHS.docker;
    case "sql":
      return MODULE_PATHS.database;
    case "workflow":
      return MODULE_PATHS.workflow;
    case "terminal":
    case "ssh":
    case "ai":
      return MODULE_PATHS.terminal;
    case "server":
      return MODULE_PATHS.server;
    default:
      return MODULE_PATHS.terminal;
  }
}

function actionDot(status: WorkspaceAction["status"]): string {
  if (status === "running") return "var(--accent)";
  if (status === "blocked" || status === "draft") return "var(--warn)";
  if (status === "failed") return "var(--danger)";
  return "var(--meta)";
}

export function buildActiveTasks(
  actions: WorkspaceAction[],
  labels: {
    relative: (ts: number) => string;
    resource: (name?: string, env?: EnvironmentTag) => string;
    failed: string;
  },
): DashboardTaskRow[] {
  return actions
    .filter((action) => ["running", "failed", "blocked"].includes(action.status))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 3)
    .map((action) => ({
      id: action.id,
      name: action.title,
      info:
        action.status === "failed"
          ? labels.failed
          : labels.resource(action.resourceName, action.environment),
      dot: actionDot(action.status),
      badge:
        action.status === "running"
          ? "running"
          : action.status === "blocked"
            ? "blocked"
            : "queued",
      path: actionPath(action),
    }));
}

export function buildDraftRows(
  actions: WorkspaceAction[],
  aiDrafts: DashboardDraftRow[],
  labels: {
    relative: (ts: number) => string;
    resource: (name?: string) => string;
  },
): DashboardDraftRow[] {
  const fromActions = actions
    .filter((action) => action.status === "draft")
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 3)
    .map((action) => ({
      id: action.id,
      title: action.title,
      time: `${action.command?.trim() || action.description} · ${labels.resource(action.resourceName)}`,
      dot: actionDot(action.status),
      path: actionPath(action),
    }));

  const merged = [...aiDrafts, ...fromActions];
  const seen = new Set<string>();
  return merged.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  }).slice(0, 3);
}

function resolveHostLabel(hostId: string, connectionNames: Map<string, string>): string {
  return connectionNames.get(hostId) ?? hostId;
}

function diskUsagePercent(stats: HostSystemStats): number {
  if (stats.disk.total != null && stats.disk.total > 0) {
    return safePercent(stats.disk.used, stats.disk.total);
  }
  const devices = stats.disk.disks ?? [];
  if (devices.length === 0) return 0;
  return Math.max(
    ...devices.map((disk) => safePercent(disk.used, disk.total)),
    0,
  );
}

export function buildResourceBars(
  statsList: HostSystemStats[],
  connectionNames: Map<string, string>,
  labels: { cpu: string; memory: string; disk: string },
  maxBars = 6,
): DashboardResourceBar[] {
  const bars: DashboardResourceBar[] = [];

  for (const stats of statsList) {
    const host = resolveHostLabel(stats.hostId, connectionNames);
    const cpuPct = Math.round(stats.cpuUsage ?? stats.cpu.usage ?? 0);
    bars.push({
      id: `${stats.hostId}-cpu`,
      label: `${host} — ${labels.cpu}`,
      value: `${cpuPct}%`,
      width: `${cpuPct}%`,
      color: metricColor(cpuPct),
    });

    const memPct = safePercent(stats.memory.used, stats.memory.total);
    bars.push({
      id: `${stats.hostId}-mem`,
      label: `${host} — ${labels.memory}`,
      value: formatUsageBytes(stats.memory.used, stats.memory.total),
      width: `${memPct}%`,
      color: metricColor(memPct),
    });

    const diskPct = diskUsagePercent(stats);
    if (diskPct > 0 || stats.disk.total != null) {
      bars.push({
        id: `${stats.hostId}-disk`,
        label: `${host} — ${labels.disk}`,
        value: formatUsageBytes(stats.disk.used, stats.disk.total),
        width: `${diskPct}%`,
        color: metricColor(diskPct),
      });
    }

    if (bars.length >= maxBars) break;
  }

  return bars.slice(0, maxBars);
}

export function buildContainerItems(containers: DockerContainerSummary[]): DashboardContainerItem[] {
  const sorted = [...containers].sort((a, b) => {
    if (a.running !== b.running) return a.running ? -1 : 1;
    return a.name.localeCompare(b.name, "zh-CN");
  });

  return sorted.slice(0, 6).map((container) => ({
    id: container.id,
    name: container.name || container.shortId,
    status: container.statusText || container.state,
    dot: container.running
      ? "var(--success)"
      : container.state === "restarting"
        ? "var(--warn)"
        : "var(--meta)",
  }));
}

export function buildServerItems(
  connections: Connection[],
  statsMap: Record<string, HostSystemStats>,
  labels: {
    notCollected: string;
    cpu: (pct: number) => string;
    disk: (pct: number) => string;
  },
): DashboardServerItem[] {
  const candidates = connections.filter((c) => c.kind === "ssh" || c.kind === "panel");
  const sorted = [...candidates].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));

  return sorted.slice(0, 6).map((connection) => {
    const stats = statsMap[connection.id];
    const cpuPct = stats
      ? Math.round(stats.cpuUsage ?? stats.cpu.usage ?? 0)
      : null;
    const diskPct = stats ? diskUsagePercent(stats) : null;

    let type = labels.notCollected;
    let dot = "var(--meta)";
    if (cpuPct != null && cpuPct > 0) {
      type = labels.cpu(cpuPct);
      dot = metricColor(cpuPct);
    } else if (diskPct != null && diskPct > 0) {
      type = labels.disk(diskPct);
      dot = metricColor(diskPct);
    }

    return {
      id: connection.id,
      name: connection.name,
      type,
      dot,
      resourceId: connection.id,
      path: modulePathForType(connection.kind === "panel" ? "server" : "ssh"),
    };
  });
}

export function connectionNameMap(connections: Connection[]): Map<string, string> {
  const map = new Map<string, string>();
  map.set(LOCAL_TERMINAL_RESOURCE_ID, "本地终端");
  for (const connection of connections) {
    map.set(connection.id, connection.name);
  }
  return map;
}

export function envLabel(env: EnvironmentTag): string {
  return ENVIRONMENT_LABELS[env] ?? ENVIRONMENT_LABELS.unknown;
}

export function typeLabel(type: ResourceType): string {
  return RESOURCE_TYPE_LABELS[type] ?? type;
}
