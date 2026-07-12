import type { DockerContainerSummary } from "../../ipc/bindings";

export type ContainerLifecyclePhase = "running" | "stopped" | "transitional";

const TRANSITIONAL_STATE_KEYWORDS = [
  "restarting",
  "starting",
  "stopping",
  "pausing",
  "unpausing",
  "removing",
  "dead",
];

export function getContainerLifecyclePhase(
  container: DockerContainerSummary,
  actionPending: boolean,
): ContainerLifecyclePhase {
  if (actionPending) return "transitional";
  const state = container.state.trim().toLowerCase();
  const status = container.statusText.trim().toLowerCase();
  if (TRANSITIONAL_STATE_KEYWORDS.some((keyword) => state.includes(keyword) || status.includes(keyword))) {
    return "transitional";
  }
  if (container.running) return "running";
  return "stopped";
}

export function lifecycleStatusLabel(
  container: DockerContainerSummary,
  phase: ContainerLifecyclePhase,
  t: (key: string) => string,
): string {
  if (phase === "transitional") {
    const text = container.statusText?.trim();
    if (text) return text;
    return t("docker.dockPanel.statusTransition");
  }
  return phase === "running" ? t("docker.dockPanel.statusRunning") : t("docker.dockPanel.statusStopped");
}

export type DockerContainerLifecycleAction = "start" | "stop" | "restart" | "remove";
