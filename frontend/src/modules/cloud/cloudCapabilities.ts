import { ALIYUN_CLOUD_TABS, type AliyunCloudTab } from "../../../../plugins/cloud-aliyun/src/index";
import type { CloudResourceTab } from "../server/cloud/cloudSidebarNav";

export function cloudTabsForProvider(provider: string | null | undefined): CloudResourceTab[] {
  const raw = (provider ?? "").trim().toLowerCase();
  if (raw === "aliyun" || raw === "omni.cloud.aliyun") {
    return [...ALIYUN_CLOUD_TABS] as CloudResourceTab[];
  }
  return [];
}

export type { AliyunCloudTab };
