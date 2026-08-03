import type { ServerPanelDockOpenMode } from "../panel/serverPanelWorkspaceTabs";

export type CloudResourceTab = "oss" | "swas" | "domains" | "ecs" | "certs";

export const CLOUD_RESOURCE_TABS: CloudResourceTab[] = [
  "ecs",
  "swas",
  "oss",
  "domains",
  "certs",
];

/** 侧栏导航：账户（实例）→ 地区；资源类型在右侧 Tab。 */
export type CloudSidebarNavTarget = {
  accountId: string;
  region?: string;
};

export type CloudSidebarNavigate = (
  target: CloudSidebarNavTarget,
  mode?: ServerPanelDockOpenMode,
) => void;

export function makeCloudTreeKey(accountId: string, region?: string): string {
  if (region) return `cloud:${accountId}:${region}`;
  return `cloud:${accountId}`;
}
