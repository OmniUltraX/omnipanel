import { useCallback } from "react";
import { resolveResourceById } from "../../stores/connectionStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { TerminalView } from "../../modules/terminal/TerminalView";
import { useI18n } from "../../i18n";
import type { WorkspaceDockTab } from "../../stores/workspaceBottomDockStore";

interface WorkspaceMirroredPanelProps {
  tab: WorkspaceDockTab;
}

/** 从其他模块拖入底部工作区后的镜像面板内容 */
export function WorkspaceMirroredPanel({ tab }: WorkspaceMirroredPanelProps) {
  const { t } = useI18n();

  if (tab.originScope === "terminal" && tab.originPanelId) {
    return <WorkspaceTerminalMirror tabId={tab.originPanelId} />;
  }

  if (tab.originScope === "database" && tab.originPanelId) {
    return (
      <div className="workspace-mirror-placeholder">
        <p>{t("shell.workspacePanel.mirroredDatabase")}</p>
        <span className="workspace-mirror-placeholder__meta">{tab.label}</span>
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

function WorkspaceTerminalMirror({ tabId }: { tabId: string }) {
  const { t } = useI18n();
  const tab = useTerminalStore((state) =>
    state.tabs.find((item) => item.id === tabId),
  );
  const resource = resolveResourceById(tab?.session.resourceId ?? null);
  const onSenderChange = useCallback(() => {}, []);

  if (!tab) {
    return (
      <div className="workspace-mirror-placeholder">
        <p>{t("shell.workspacePanel.mirroredMissing")}</p>
      </div>
    );
  }

  return (
    <div className="workspace-terminal-mirror">
      <TerminalView
        sessionId={tab.id}
        resource={resource}
        startup={tab.startup ?? []}
        active
        onSenderChange={onSenderChange}
      />
    </div>
  );
}
