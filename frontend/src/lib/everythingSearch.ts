import { commands } from "../ipc/bindings";
import { unwrapCommand } from "../ipc/result";
import { PLUGIN_ID_EVERYTHING } from "../stores/pluginRuntimeStore";

/** 与 `plugins/addon-everything/plugin.json` 的 methods[].name 一致。 */
export const EVERYTHING_SEARCH_METHOD = "omni_everything_search";

export type EverythingHit = {
  path: string;
  isFolder: boolean;
};

export function everythingBrowsePath(path: string, isFolder: boolean): string {
  if (isFolder) return path;
  const trimmed = path.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (idx <= 0) return path;
  if (idx === 2 && trimmed[1] === ":") return trimmed.slice(0, idx + 1);
  return trimmed.slice(0, idx);
}

export async function searchEverything(
  query: string,
  maxResults: number,
): Promise<EverythingHit[]> {
  const value = await unwrapCommand(
    commands.pluginInvoke(PLUGIN_ID_EVERYTHING, EVERYTHING_SEARCH_METHOD, {
      query,
      max_results: maxResults,
    } as never),
  );
  const hits = Array.isArray(value) ? value : [];
  return hits.flatMap((hit) => {
    const rec = hit && typeof hit === "object" ? (hit as { path?: unknown; isFolder?: unknown }) : {};
    const path = typeof rec.path === "string" ? rec.path : "";
    if (!path) return [];
    return [{ path, isFolder: rec.isFolder === true }];
  });
}
