import { useNavigate } from "react-router-dom";
import { useI18n } from "../../i18n";
import { Button } from "../ui/Button";
import { WorkspaceEmptyPage } from "../ui/WorkspaceEmptyPage";
import { TerminalTabDockPane } from "../../modules/terminal/TerminalTabDockPane";
import { DatabaseTabDockPane } from "../../modules/database/DatabaseTabDockPane";
import { DockerWorkspaceTabPane } from "../../modules/docker/DockerWorkspaceTabPane";
import { getMirroredDbTabSnapshot } from "../../stores/dbWorkspaceMirrorStore";
import type { WorkspaceDockTab } from "../../stores/workspaceBottomDockStore";
import { ensureTerminalTabFromSnapshot } from "../../lib/workspaceTabActions";

interface WorkspacePayloadPanelProps {
  tab: WorkspaceDockTab;
  isActive: boolean;
}

function PayloadFallback({
  module,
  label,
  path,
}: {
  module: string;
  label: string;
  path: string;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();

  return (
    <WorkspaceEmptyPage
      title={label}
      prompt={t("shell.workspacePanel.payloadUnavailable", { module })}
      className="workspace-payload-fallback"
      actions={
        <Button variant="primary" size="sm" onClick={() => navigate(path)}>
          {t("shell.workspacePanel.openSourceModule")}
        </Button>
      }
    />
  );
}

/** 工作区 Dock 中由快照物化的 payload 面板 */
export function WorkspacePayloadPanel({ tab, isActive }: WorkspacePayloadPanelProps) {
  const payload = tab.payload;
  if (!payload) {
    return null;
  }

  if (payload.module === "terminal") {
    const tabId = ensureTerminalTabFromSnapshot(payload);
    return (
      <div className="workspace-terminal-mirror">
        <TerminalTabDockPane tabId={tabId} isActive={isActive} />
      </div>
    );
  }

  if (payload.module === "database") {
    const mirror = getMirroredDbTabSnapshot(payload.id);
    if (mirror) {
      return <DatabaseTabDockPane tabId={payload.id} isActive={isActive} />;
    }
    return (
      <PayloadFallback module="database" label={payload.label} path="/database" />
    );
  }

  if (payload.module === "docker") {
    return <DockerWorkspaceTabPane snapshot={payload} isActive={isActive} />;
  }

  return (
    <PayloadFallback
      module={String((payload as { module: string }).module)}
      label={(payload as { label: string }).label}
      path="/"
    />
  );
}
