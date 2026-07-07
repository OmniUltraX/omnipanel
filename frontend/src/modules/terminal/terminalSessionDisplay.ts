import type { HostSystemStats } from "@/ipc/bindings";
import { getResourceTagValue } from "@/lib/resourceTags";
import type { WorkspaceResource } from "@/lib/resourceRegistry";
import { resolveResourceById } from "@/stores/connectionStore";
import type { TerminalSessionInfo } from "@/stores/terminalStore";
import { formatBytes } from "@/stores/sshStatsStore";

/** 终端 Tab 展示用基础标题（不含连接前缀）。 */
export function resolveTerminalTabBaseTitle(
  resourceId: string,
  title?: string | null,
  fallbackName?: string | null,
  shellLabel?: string | null,
): string {
  const trimmedTitle = title?.trim();
  if (trimmedTitle) return trimmedTitle;
  const trimmedFallback = fallbackName?.trim();
  if (trimmedFallback) return trimmedFallback;
  const connectionName = resolveResourceById(resourceId)?.name?.trim();
  if (connectionName) return connectionName;
  const trimmedShell = shellLabel?.trim();
  if (trimmedShell) return trimmedShell;
  return resourceId;
}

/** 终端 Tab 展示标题：连接名 + "-" + 会话标题，例如 p1-deploy。 */
export function formatTerminalTabLabel(
  resourceId: string,
  title?: string | null,
  fallbackName?: string | null,
  shellLabel?: string | null,
): string {
  const connectionName = resolveResourceById(resourceId)?.name?.trim();
  const baseTitle = resolveTerminalTabBaseTitle(
    resourceId,
    title,
    fallbackName,
    shellLabel,
  );

  if (!connectionName) return baseTitle;

  const prefix = `${connectionName}-`;
  if (baseTitle.startsWith(prefix) || baseTitle === connectionName) {
    return baseTitle;
  }

  return `${prefix}${baseTitle}`;
}

export function parseSshSubtitle(subtitle?: string) {
  const match = subtitle?.match(/^([^@\s]+)@([^:\s]+)(?::(\d+))?/);
  return {
    user: match?.[1],
    host: match?.[2],
    port: match?.[3],
  };
}

/** 终端头部展示用路径（尽量折叠 home 目录）。 */
export function formatTerminalCwdDisplay(
  cwd: string | undefined | null,
  user?: string | null,
): string {
  if (!cwd || cwd === "~" || cwd === "~/") return "~";

  const normalized = cwd.replace(/\\/g, "/");

  if (user === "root") {
    if (normalized === "/root") return "~";
    if (normalized.startsWith("/root/")) {
      return `~${normalized.slice("/root".length)}`;
    }
  }

  const homeMatch = /^\/home\/([^/]+)(\/.*)?$/i.exec(normalized);
  if (homeMatch && user && homeMatch[1] === user) {
    return homeMatch[2] ? `~${homeMatch[2]}` : "~";
  }

  const winHomeMatch = /^([A-Za-z]:\/Users\/[^/]+)(\/.*)?$/i.exec(normalized);
  if (winHomeMatch) {
    return winHomeMatch[2] ? `~${winHomeMatch[2].replace(/\//g, "\\")}` : "~";
  }

  if (normalized.length > 42) {
    return `…${normalized.slice(-39)}`;
  }

  return cwd;
}

function formatMemoryCapacity(bytes: number | null | undefined): string | null {
  if (bytes == null || bytes <= 0) return null;
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${Math.round(gb)}G`;
  const mb = bytes / 1024 ** 2;
  return `${Math.max(1, Math.round(mb))}M`;
}

export function formatHardwareFromStats(stats: HostSystemStats | null | undefined): string | null {
  if (!stats) return null;
  const mem = formatMemoryCapacity(stats.memory.total);
  const cores = stats.cpuCores > 0 ? stats.cpuCores : null;
  if (cores && mem) return `${cores}C/${mem}`;
  if (cores) return `${cores}C`;
  if (mem) return mem;
  return null;
}

function tagShellLabel(tags: string[] | undefined): string | null {
  if (!tags?.length) return null;
  for (const tag of tags) {
    const value = tag.includes(":") ? tag.split(":").slice(1).join(":") : tag;
    const lower = value.toLowerCase();
    // 支持 bash/zsh/fish/sh/powershell/pwsh/cmd/wsl/nushell/nu/xonsh/tcsh/csh
    if (/^(bash|zsh|fish|sh|powershell|pwsh|cmd|wsl|nushell|nu|xonsh|tcsh|csh)$/i.test(lower)) {
      if (lower === "pwsh") return "PowerShell";
      if (lower === "cmd") return "cmd.exe";
      if (lower === "nu" || lower === "nushell") return "nushell";
      return value;
    }
  }
  return null;
}

function inferShellLabel(
  session: Pick<TerminalSessionInfo, "shellLabel" | "type">,
  resource: WorkspaceResource | null,
): string {
  const generic = session.shellLabel.trim();
  // 显式 shellLabel 优先（包括 cmd、wsl 等具体值）
  if (generic && !/^(ssh|shell|auto|unknown)$/i.test(generic)) {
    return generic;
  }

  const fromTag = tagShellLabel(resource?.tags);
  if (fromTag) return fromTag;

  if (session.type === "local") {
    return typeof navigator !== "undefined" && /win/i.test(navigator.userAgent)
      ? "PowerShell"
      : "bash";
  }

  return "bash";
}

export function resolveOsLabel(
  resource: WorkspaceResource | null,
  stats: HostSystemStats | null | undefined,
): string | null {
  const fromStats = stats?.osInfo?.trim();
  if (fromStats) return fromStats;

  const fromTag = getResourceTagValue(resource?.tags, "os");
  if (fromTag) return fromTag;

  const legacyTag = resource?.tags?.find((tag) =>
    /ubuntu|debian|centos|linux|windows|macos|alpine|fedora/i.test(tag),
  );
  if (legacyTag) {
    return legacyTag.includes(":") ? legacyTag.split(":").slice(1).join(":") : legacyTag;
  }

  const fromMetrics = resource?.metrics?.OS?.trim();
  if (fromMetrics) return fromMetrics;

  return null;
}

export function resolveHardwareLabel(
  resource: WorkspaceResource | null,
  stats: HostSystemStats | null | undefined,
  sessionType: TerminalSessionInfo["type"],
): string | null {
  const fromStats = formatHardwareFromStats(stats);
  if (fromStats) return fromStats;

  const fromMetrics =
    resource?.metrics?.配置?.trim() ??
    resource?.metrics?.Hardware?.trim() ??
    resource?.metrics?.硬件?.trim();
  if (fromMetrics) return fromMetrics;

  if (sessionType === "local" && stats?.memory.total) {
    return formatBytes(stats.memory.total);
  }

  return null;
}

export function resolveCommandPromptSymbol(
  session: Pick<TerminalSessionInfo, "shellLabel" | "type">,
  user?: string | null,
  resource?: WorkspaceResource | null,
): string {
  const shell = inferShellLabel(session, resource ?? null).toLowerCase();
  const isRoot = user === "root" || user?.toLowerCase() === "administrator";

  if (/powershell|pwsh/.test(shell)) return ">";
  if (/fish/.test(shell)) return isRoot ? "#" : ">";
  if (/zsh/.test(shell)) return isRoot ? "#" : "%";
  return isRoot ? "#" : "$";
}

export function buildSessionMetaLine(
  session: TerminalSessionInfo,
  resource: WorkspaceResource | null,
  stats: HostSystemStats | null | undefined,
): string {
  const shellLabel = inferShellLabel(session, resource);
  const osLabel = resolveOsLabel(resource, stats);
  const hardwareLabel = resolveHardwareLabel(resource, stats, session.type);

  if (session.type === "local" && !osLabel && !hardwareLabel) {
    return shellLabel;
  }

  return [shellLabel, osLabel, hardwareLabel].filter(Boolean).join(" · ");
}

export { inferShellLabel };
