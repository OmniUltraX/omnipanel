import { useLayoutEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useI18n } from "../../i18n";
import { Button } from "../ui/primitives/Button";
import { WorkspaceEmptyPage } from "../ui/workspace/WorkspaceEmptyPage";
import { TerminalTabDockPane } from "../../modules/terminal/TerminalTabDockPane";
import { DatabaseTabDockPane } from "../../modules/database/workspace/DatabaseTabDockPane";
import type { WorkspaceDockTab } from "../../stores/workspaceBottomDockStore";
import { ensureTerminalTabFromSnapshot } from "../../lib/workspaceTabActions";
import { isModuleRouteSnapshot } from "../../lib/workspaceModuleRoutes";
import { WorkspaceModuleRoutePanel } from "./WorkspaceModuleRoutePanel";
import { WorkspaceComponentPanel } from "./WorkspaceComponentPanel";
import { isComponentSnapshot } from "../../lib/workspaceComponentTypes";

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
  const { t } = useI18n();
  const payload = tab.payload;
  const [terminalTabId, setTerminalTabId] = useState<string | null>(null);

  // useLayoutEffect：拖入后首帧即挂载终端，避免空白等待一帧以上
  useLayoutEffect(() => {
    if (!payload || payload.module !== "terminal") {
      setTerminalTabId(null);
      return;
    }
    const id = ensureTerminalTabFromSnapshot(payload);
    setTerminalTabId(id);
  }, [payload]);

  if (!payload) {
    return null;
  }

  if (payload.module === "terminal") {
    if (!terminalTabId) return null;
    return (
      <div className="workspace-terminal-mirror">
        <TerminalTabDockPane tabId={terminalTabId} isActive={isActive} />
      </div>
    );
  }

  if (payload.module === "database") {
    return <DatabaseTabDockPane tabId={payload.id} isActive={isActive} />;
  }

  if (payload.module === "docker") {
    return (
      <PayloadFallback module="docker" label={t("routes.docker")} path="/module/docker" />
    );
  }

  if (isModuleRouteSnapshot(payload)) {
    return <WorkspaceModuleRoutePanel snapshot={payload} />;
  }

  if (isComponentSnapshot(payload)) {
    return <WorkspaceComponentPanel snapshot={payload} />;
  }

  return (
    <PayloadFallback
      module={String((payload as { module: string }).module)}
      label={(payload as { label: string }).label}
      path="/"
    />
  );
}
