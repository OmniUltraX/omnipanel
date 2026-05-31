import type { WorkspaceResource } from "../../../lib/resourceRegistry";
import type { LaunchPreset } from "../types";

export function envBadgeClass(resource: WorkspaceResource | null) {
  if (resource?.environment === "prod") return "badge badge-danger";
  if (resource?.environment === "staging") return "badge badge-warn";
  if (resource?.environment === "dev") return "badge badge-success";
  return "badge badge-muted";
}

export function presetBadgeClass(tone: LaunchPreset["tone"]) {
  if (tone === "warn") return "badge badge-warn";
  if (tone === "success") return "badge badge-success";
  return "badge badge-accent";
}
