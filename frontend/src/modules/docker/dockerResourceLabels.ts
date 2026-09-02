import type {
  DockerContainerSummary,
  DockerImageSummary,
  DockerNetworkSummary,
  DockerVolumeSummary,
} from "../../ipc/bindings";
import { formatBytes } from "../../stores/sshStatsStore";
import type { DockerTreeCategory } from "./dockerSidebarNav";

export function makeDockerTreeKey(
  connectionId: string,
  category?: DockerTreeCategory,
  itemId?: string,
): string {
  if (!category) return `docker:${connectionId}`;
  if (!itemId) return `docker:${connectionId}:${category}`;
  return `docker:${connectionId}:${category}:${itemId}`;
}

export function makeDockerComposeProjectTreeKey(connectionId: string, project: string): string {
  return `docker:${connectionId}:containers:compose:${encodeURIComponent(project)}`;
}

export function imageRowLabel(image: DockerImageSummary): string {
  const ref =
    image.repository && image.tag ? `${image.repository}:${image.tag}` : image.repository || image.tag;
  if (ref && ref !== ":") return ref;
  return image.shortId || image.id.slice(0, 12) || "—";
}

export function imageRowSizeLabel(image: DockerImageSummary): string {
  return formatBytes(image.sizeBytes);
}

export function containerRowLabel(container: DockerContainerSummary): string {
  return container.name || container.shortId || container.id.slice(0, 12) || "—";
}

type UptimeUnit = "second" | "minute" | "hour" | "day" | "week" | "month" | "year";

export type DockerUptimeSegment = { value: number; unit: UptimeUnit };

/**
 * 解析 Docker daemon 生成的运行状态文本（如 "Up 2 hours"、"Up 2 days, 5 hours (healthy)"）。
 * 仅运行中（Up 开头）返回分段时长；已退出 / Created / 解析失败返回 null。
 */
export function parseDockerUptime(statusText: string | null | undefined): DockerUptimeSegment[] | null {
  const text = statusText?.trim();
  if (!text) return null;
  const matched = /^Up\s+(.+)$/i.exec(text);
  if (!matched) return null;
  let body = matched[1].trim();
  // 去掉尾部健康检查括号："(healthy)" / "(unhealthy)" / "(health: starting)"
  body = body.replace(/\s*\([^)]*\)\s*$/, "").trim();
  if (/^less than a second$/i.test(body)) {
    return [{ value: 0, unit: "second" }];
  }
  if (/^about a minute$/i.test(body)) {
    return [{ value: 1, unit: "minute" }];
  }
  if (/^about an hour$/i.test(body)) {
    return [{ value: 1, unit: "hour" }];
  }
  const segments: DockerUptimeSegment[] = [];
  for (const part of body.split(/\s*,\s*/)) {
    const seg = /^(\d+)\s+(seconds?|minutes?|hours?|days?|weeks?|months?|years?)$/i.exec(part.trim());
    if (!seg) return null;
    const unit = seg[2].toLowerCase().replace(/s$/, "") as UptimeUnit;
    segments.push({ value: Number(seg[1]), unit });
  }
  return segments.length > 0 ? segments : null;
}

const UPTIME_UNIT_LABEL_KEYS: Record<UptimeUnit, string> = {
  second: "docker.composePanel.uptimeSecond",
  minute: "docker.composePanel.uptimeMinute",
  hour: "docker.composePanel.uptimeHour",
  day: "docker.composePanel.uptimeDay",
  week: "docker.composePanel.uptimeWeek",
  month: "docker.composePanel.uptimeMonth",
  year: "docker.composePanel.uptimeYear",
};

export function formatDockerUptime(
  segments: DockerUptimeSegment[],
  t: (key: string) => string,
): string {
  return segments.map((s) => t(UPTIME_UNIT_LABEL_KEYS[s.unit]).replace("{n}", String(s.value))).join("");
}

/** 容器运行时长展示文本（如 "2小时5分"）；非运行中或无法解析返回 null。 */
export function containerUptimeLabel(
  container: DockerContainerSummary,
  t: (key: string) => string,
): string | null {
  if (!container.running) return null;
  const segments = parseDockerUptime(container.statusText);
  if (!segments) return null;
  return formatDockerUptime(segments, t);
}

export function networkRowLabel(network: DockerNetworkSummary): string {
  return network.name || network.id.slice(0, 12) || "—";
}

export function volumeRowLabel(volume: DockerVolumeSummary): string {
  return volume.name || "—";
}