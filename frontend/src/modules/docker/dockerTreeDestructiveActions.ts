import { appConfirm } from "@/lib/appConfirm";
import { useDockerPanelDockStore } from "@/stores/dockerPanelDockStore";
import { invalidateComposeProjectMeta, getComposeProjectMeta, runComposeAction } from "./dockerComposeApi";
import { runDockerContainerAction } from "./dockerContainerActions";
import { refreshDockerConnectionSidebarCache } from "./hooks/useDockerConnectionResources";

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** 侧栏 / 面板共用：确认后删除容器并清理 Tab、刷新侧栏。 */
export async function confirmAndRemoveDockerContainer(options: {
  connectionId: string;
  containerId: string;
  containerName: string;
  t: Translate;
}): Promise<boolean> {
  const { connectionId, containerId, containerName, t } = options;
  const confirmed = await appConfirm(
    t("docker.dockPanel.removeContainerConfirm", { name: containerName }),
    t("docker.dockPanel.removeContainer"),
    { kind: "warning", confirmLabel: t("docker.dockPanel.removeContainer") },
  );
  if (!confirmed) return false;
  await runDockerContainerAction(connectionId, containerId, "remove");
  useDockerPanelDockStore.getState().removeContainerTabs(connectionId, containerId);
  refreshDockerConnectionSidebarCache(connectionId);
  return true;
}

/** 侧栏 / 面板共用：确认后 Compose down 并清理 Tab、meta、侧栏。 */
export async function confirmAndDownComposeProject(options: {
  connectionId: string;
  project: string;
  t: Translate;
}): Promise<boolean> {
  const { connectionId, project, t } = options;
  const confirmed = await appConfirm(
    t("docker.composePanel.downConfirm", { project }),
    t("docker.composePanel.down"),
    { kind: "warning", confirmLabel: t("docker.composePanel.down") },
  );
  if (!confirmed) return false;

  const meta = await getComposeProjectMeta(connectionId, project);
  const configFile = meta?.configFiles?.split(",")[0]?.trim() || null;
  const result = await runComposeAction(connectionId, "down", {
    project,
    workingDir: meta?.workingDir ?? null,
    configFile,
    services: [],
    detached: true,
  });
  if (result.exitCode !== 0) {
    const detail = [result.stderrExcerpt, result.stdoutExcerpt].filter(Boolean).join("\n");
    throw new Error(detail || t("docker.composePanel.actionFailed"));
  }
  invalidateComposeProjectMeta(connectionId, project);
  useDockerPanelDockStore.getState().removeComposeTabs(connectionId, project);
  refreshDockerConnectionSidebarCache(connectionId);
  return true;
}
