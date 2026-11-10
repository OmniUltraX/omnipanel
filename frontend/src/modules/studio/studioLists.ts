import type { DevWatchInfo, PluginListItem, StudioProject } from "../../ipc/bindings";
import { asPluginList } from "../plugins/pluginCenterTypes";

/** IPC `plugin_dev_status` 在 Web 未注册时会 soft-degrade 成 `{}`。 */
export function asDevWatchList(value: unknown): DevWatchInfo[] {
  return asPluginList<DevWatchInfo>(value);
}

/** 只保留正在监听的条目；非数组不会抛 `filter is not a function`。 */
export function watchingDevItems(devList: unknown): DevWatchInfo[] {
  return asDevWatchList(devList).filter((item) => Boolean(item && item.watching));
}

export function studioProjectFiles(project: { files?: unknown } | null | undefined): string[] {
  return asPluginList<string>(project?.files);
}

export function asStudioProjectList(value: unknown): StudioProject[] {
  const out: StudioProject[] = [];
  for (const item of asPluginList<unknown>(value)) {
    if (!item || typeof item !== "object") continue;
    const row = item as StudioProject;
    out.push({
      ...row,
      files: studioProjectFiles(row),
    });
  }
  return out;
}

export function asPluginIdSet(value: unknown): Set<string> {
  const ids = new Set<string>();
  for (const item of asPluginList<PluginListItem>(value)) {
    if (item && typeof item.id === "string" && item.id) ids.add(item.id);
  }
  return ids;
}
