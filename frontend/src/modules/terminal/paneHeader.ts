import type { WorkspaceResource } from "../../lib/resourceRegistry";

/** 终端面板标题：资源名优先，否则回退到自定义标题。 */
export function formatPaneHeaderTitle(
  resource: WorkspaceResource | null,
  fallback?: { title?: string },
): string {
  if (resource?.name) return resource.name;
  return fallback?.title ?? "";
}
