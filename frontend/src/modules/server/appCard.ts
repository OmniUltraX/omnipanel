import type { ServerInstalledApp } from "./serverApp";

const MAX_PORT_TAGS = 4;

export function getAppPortTags(app: ServerInstalledApp): string[] {
  const tags: string[] = [];
  if (app.version) tags.push(`v${app.version}`);

  if (app.portTags?.length) {
    const visible = app.portTags.slice(0, MAX_PORT_TAGS);
    tags.push(...visible.map((port) => `:${port}`));
    const rest = app.portTags.length - visible.length;
    if (rest > 0) tags.push(`+${rest}`);
    return tags;
  }

  if (app.httpPort) tags.push(`HTTP ${app.httpPort}`);
  if (app.httpsPort) tags.push(`HTTPS ${app.httpsPort}`);
  return tags;
}

export function getAppStatus(app: ServerInstalledApp): string {
  return app.status || app.appStatus || "-";
}

export function getAppDisplayName(app: ServerInstalledApp): string {
  return app.appName || app.name || app.appKey || "-";
}

export function getAppInstanceName(app: ServerInstalledApp): string | null {
  const displayName = getAppDisplayName(app);
  const instance = app.serviceName || app.name;
  if (!instance || instance === displayName) return null;
  return instance;
}

export function getAppDescription(app: ServerInstalledApp): string | null {
  return app.description || app.message || null;
}

export function formatAppPorts(app: ServerInstalledApp): string {
  if (app.portTags?.length) return app.portTags.join(", ");
  const parts: string[] = [];
  if (app.httpPort) parts.push(`HTTP ${app.httpPort}`);
  if (app.httpsPort) parts.push(`HTTPS ${app.httpsPort}`);
  return parts.length > 0 ? parts.join(" / ") : "-";
}

export function getAppStatusClass(status?: string): string {
  if (!status) return "muted";
  const normalized = status.trim();
  const lower = normalized.toLowerCase();
  if (normalized === "Running" || lower === "running" || lower === "up" || lower === "active") {
    return "success";
  }
  if (normalized.includes("Err") || normalized.includes("Error") || normalized === "UnHealthy") {
    return "danger";
  }
  if (normalized === "Stopped" || lower === "stopped" || lower === "exited" || lower === "down") {
    return "muted";
  }
  return "warning";
}
