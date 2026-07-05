import { useCallback, useMemo } from "react";
import { useI18n } from "../../i18n";
import { WorkspaceEmptyPage } from "../ui/workspace/WorkspaceEmptyPage";
import type { WorkspaceInfo } from "../../stores/workspaceStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import {
  useWorkspaceBottomDockStore,
  type WorkspaceDockClosedEntry,
} from "../../stores/workspaceBottomDockStore";
import { reopenWorkspaceDockTab } from "../../lib/workspaceTabActions";

interface WorkspaceDockEmptyProps {
  workspace: WorkspaceInfo;
  /** 半屏/嵌入式工作区使用紧凑空态，避免大 Banner 占满可视区域 */
  compact?: boolean;
}

const EMPTY_RECENT_CLOSED: WorkspaceDockClosedEntry[] = [];

/** 工程工作区无 Tab 时的空页面，展示最近关闭的面板列表 */
export function WorkspaceDockEmpty({ workspace, compact = false }: WorkspaceDockEmptyProps) {
  const { t } = useI18n();
  const workspaceId = workspace.id;
  const recentClosed = useWorkspaceBottomDockStore(
    (state) => state.recentClosedByWorkspace[workspaceId] ?? EMPTY_RECENT_CLOSED,
  );

  const handleReopen = useCallback(
    (closedAt: number) => {
      const entry = useWorkspaceBottomDockStore
        .getState()
        .recentClosedByWorkspace[workspaceId]?.find((item) => item.closedAt === closedAt);
      if (!entry) return;
      const resolvedWorkspace =
        useWorkspaceStore.getState().workspaces.find((item) => item.id === workspaceId) ??
        workspace;
      reopenWorkspaceDockTab(workspaceId, resolvedWorkspace, entry);
    },
    [workspace, workspaceId],
  );

  const actionItems = useMemo(
    () =>
      [...recentClosed]
        .sort((a, b) => b.closedAt - a.closedAt)
        .map((entry) => ({
          id: String(entry.closedAt),
          label: entry.tab.label,
          meta: new Date(entry.closedAt).toLocaleString(),
          onClick: () => handleReopen(entry.closedAt),
        })),
    [handleReopen, recentClosed],
  );

  if (compact) {
    return (
      <div className="workspace-dock-empty workspace-dock-empty--compact">
        <div className="workspace-dock-empty__card">
          {actionItems.length > 0 ? (
            <div className="workspace-dock-empty__recent">
              <div className="workspace-dock-empty__recent-title">
                {t("shell.workspacePanel.recentClosed")}
              </div>
              <div className="workspace-dock-empty__recent-list">
                {actionItems.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="workspace-dock-empty__recent-item"
                    onClick={item.onClick}
                  >
                    <span>{item.label}</span>
                    <small>{item.meta}</small>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <p className="workspace-dock-empty__prompt">
              {t("shell.workspacePanel.welcomePrompt")}
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <WorkspaceEmptyPage
      title={workspace.name}
      prompt={t("shell.workspacePanel.welcomePrompt")}
      actionList={
        actionItems.length > 0
          ? {
              title: t("shell.workspacePanel.recentClosed"),
              items: actionItems,
            }
          : undefined
      }
    />
  );
}
