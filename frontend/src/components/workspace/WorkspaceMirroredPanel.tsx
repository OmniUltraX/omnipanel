import { useLayoutEffect, useState } from "react";
import { useI18n } from "../../i18n";
import { TerminalTabDockPane } from "../../modules/terminal/TerminalTabDockPane";
import { DatabaseTabDockPane } from "../../modules/database/workspace/DatabaseTabDockPane";
import { WorkspaceEmptyPage } from "../../components/ui/workspace/WorkspaceEmptyPage";
import { Button } from "../ui/primitives/Button";
import type { WorkspaceDockTabHostContext } from "./WorkspaceDockTabPanel";
import type { WorkspaceDockTab } from "../../stores/workspaceBottomDockStore";
import { ensureTerminalTabFromSnapshot } from "../../lib/workspaceTabActions";
import type { TerminalTabSnapshot } from "../../stores/workspaceTabStore";
import { WorkspaceFilesMirrorPanel } from "./WorkspaceFilesMirrorPanel";

interface WorkspaceMirroredPanelProps {
  tab: WorkspaceDockTab;
  isActive: boolean;
  hostContext?: WorkspaceDockTabHostContext;
}

function resolveMirrorSideDockScope(
  tabId: string,
  hostContext: WorkspaceDockTabHostContext,
): string {
  if (hostContext === "taskbar-subwindow") {
    return `workspace-taskbar-mirror-side-${tabId}`;
  }
  return `workspace-bottom-mirror-side-${tabId}`;
}

function resolveMirroredTerminalId(originPanelId: string): string {
  const payloadPrefix = "ws-payload:terminal:";
  if (originPanelId.startsWith(payloadPrefix)) {
    return originPanelId.slice(payloadPrefix.length);
  }
  if (originPanelId.includes(":")) {
    return originPanelId.slice(originPanelId.lastIndexOf(":") + 1);
  }
  return originPanelId;
}

/** 从其他模块拖入底部工作区后的镜像面板内容 */
export function WorkspaceMirroredPanel({
  tab,
  isActive,
  hostContext = "workspace-dock",
}: WorkspaceMirroredPanelProps) {
  const { t } = useI18n();
  const [terminalTabId, setTerminalTabId] = useState<string | null>(null);

  // 独立窗口等新上下文中 terminalStore 可能为空：按镜像信息补齐 tab，避免空白。
  useLayoutEffect(() => {
    if (tab.originScope !== "terminal" || !tab.originPanelId) {
      setTerminalTabId(null);
      return;
    }
    const id = resolveMirroredTerminalId(tab.originPanelId);
    const snapshot: TerminalTabSnapshot =
      tab.payload?.module === "terminal"
        ? { ...tab.payload, id }
        : {
            module: "terminal",
            id,
            label: tab.label || id,
            sessionType: "local",
            resourceId: "local-terminal",
            shellLabel: "Shell",
            cwd: "~/",
            purpose: "",
          };
    ensureTerminalTabFromSnapshot(snapshot);
    setTerminalTabId(id);
  }, [tab.originScope, tab.originPanelId, tab.label, tab.payload]);

  if (tab.originScope === "terminal" && tab.originPanelId) {
    if (!terminalTabId) return null;
    return (
      <div className="workspace-terminal-mirror">
        <TerminalTabDockPane
          tabId={terminalTabId}
          isActive={isActive}
          sideDockScope={resolveMirrorSideDockScope(tab.originPanelId, hostContext)}
        />
      </div>
    );
  }

  if (tab.originScope === "database" && tab.originPanelId) {
    return (
      <DatabaseTabDockPane tabId={tab.originPanelId} isActive={isActive} />
    );
  }

  if (tab.originScope === "files-browser" && tab.originPanelId) {
    return (
      <WorkspaceFilesMirrorPanel
        originPanelId={tab.originPanelId}
        isActive={isActive}
      />
    );
  }

  if (tab.originScope === "docker" && tab.originPanelId) {
    return (
      <div className="workspace-payload-fallback">
        <WorkspaceEmptyPage
          title={t("routes.docker")}
          prompt={t("shell.workspacePanel.payloadUnavailable", { module: t("routes.docker") })}
          actions={
            <Button variant="primary" size="sm" onClick={() => window.location.assign("/module/docker")}>
              {t("shell.workspacePanel.openSourceModule")}
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="workspace-mirror-placeholder">
      <p>{t("shell.workspacePanel.mirroredUnknown")}</p>
      <span className="workspace-mirror-placeholder__meta">{tab.label}</span>
    </div>
  );
}
