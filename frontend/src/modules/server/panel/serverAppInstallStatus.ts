import type { OnePanelInstalledApp } from "@/lib/onepanel";

export type AppInstallDisplayState = "available" | "installing" | "installed" | "failed";

const IN_PROGRESS = new Set([
  "installing",
  "upgrading",
  "rebuilding",
  "uninstalling",
]);

const FAILED = new Set(["installerr", "upgradeerr", "error"]);

function normalizeAppStatus(status?: string | null): string {
  return (status ?? "").trim().toLowerCase();
}

export function readInstalledAppStatus(item: OnePanelInstalledApp): string {
  return (item.status ?? item.appStatus ?? "").trim();
}

export function isAppInstallInProgress(status?: string | null): boolean {
  const lower = normalizeAppStatus(status);
  if (!lower) return false;
  if (IN_PROGRESS.has(lower)) return true;
  return (
    lower.endsWith("ing") &&
    (lower.includes("install") || lower.includes("upgrade") || lower.includes("rebuild"))
  );
}

export function isAppInstallFailed(status?: string | null): boolean {
  const lower = normalizeAppStatus(status);
  if (!lower) return false;
  if (FAILED.has(lower)) return true;
  return lower.includes("err") || lower.includes("失败") || lower.includes("错误");
}

export function resolveAppInstallDisplayState(status?: string | null): AppInstallDisplayState {
  if (isAppInstallInProgress(status)) return "installing";
  if (isAppInstallFailed(status)) return "failed";
  if (normalizeAppStatus(status)) return "installed";
  return "available";
}

export function findInstalledAppForMarket(
  app: { key?: string; name?: string },
  installedApps: OnePanelInstalledApp[],
): OnePanelInstalledApp | undefined {
  const key = (app.key || "").trim().toLowerCase();
  const name = (app.name || "").trim().toLowerCase();
  return installedApps.find((item) => {
    const appKey = (item.appKey ?? "").trim().toLowerCase();
    const appName = (item.appName ?? "").trim().toLowerCase();
    const itemName = (item.name ?? "").trim().toLowerCase();
    if (key && (appKey === key || itemName === key)) return true;
    if (name && (appName === name || itemName === name)) return true;
    return false;
  });
}
