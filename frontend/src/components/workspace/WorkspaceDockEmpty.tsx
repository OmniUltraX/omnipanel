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
  /** 半屏/嵌入式工作区：与全屏相同布局，仅限制高度并可滚动 */
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

  return (
    <WorkspaceEmptyPage
      className={compact ? "workspace-empty-page--embedded" : undefined}
      hideBranding={compact}
      title={workspace.name}
      prompt={
        compact && actionItems.length > 0
          ? undefined
          : t("shell.workspacePanel.welcomePrompt")
      }
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
