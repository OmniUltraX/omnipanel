import { useCallback, type MouseEvent } from "react";

import { appConfirm } from "../../../lib/appConfirm";
import { isWorkspaceBuiltinTab } from "../../../lib/workspaceBuiltinPanels";
import type { WorkspaceDockTab } from "../../../stores/workspaceBottomDockStore";
import {
  resolveWorkspaceTabPreview,
  type WorkspacePreviewKind,
} from "../../../lib/workspaceTabPreview";
import { useI18n } from "../../../i18n";

export function PreviewKindIcon({ kind }: { kind: WorkspacePreviewKind }) {
  const props = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    width: 40,
    height: 40,
    "aria-hidden": true,
  } as const;

  if (kind === "terminal" || kind === "docker-terminal") {
    return (
      <svg {...props}>
        <rect x="3" y="4" width="18" height="14" rx="2" />
        <path d="M7 9l3 3-3 3M11 15h5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (kind === "database-sql") {
    return (
      <svg {...props}>
        <path d="M8 4h8l2 2v14H6V6l2-2z" />
        <path d="M14 4v4h4M8 12h8M8 16h5" strokeLinecap="round" />
      </svg>
    );
  }
  if (kind === "database-table") {
    return (
      <svg {...props}>
        <rect x="4" y="5" width="16" height="14" rx="1.5" />
        <path d="M4 10h16M9 5v14M15 5v14" />
      </svg>
    );
  }
  if (kind === "docker-logs") {
    return (
      <svg {...props}>
        <path d="M12 3c4 0 7 2 7 5v8c0 3-3 5-7 5S5 19 5 16V8c0-3 3-5 7-5z" />
        <circle cx="9" cy="11" r="1" fill="currentColor" stroke="none" />
        <circle cx="15" cy="11" r="1" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  if (kind === "board") {
    return (
      <svg {...props}>
        <rect x="4" y="4" width="7" height="7" rx="1.5" />
        <rect x="13" y="4" width="7" height="7" rx="1.5" />
        <rect x="4" y="13" width="7" height="7" rx="1.5" />
        <rect x="13" y="13" width="7" height="7" rx="1.5" />
      </svg>
    );
  }
  if (kind === "ai") {
    return (
      <svg {...props}>
        <path d="M12 2a4 4 0 014 4v1a4 4 0 01-8 0V6a4 4 0 014-4z" />
        <path d="M8 14a4 4 0 008 0" />
        <path d="M12 17v4M8 21h8" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg {...props}>
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <path d="M8 10h8M8 14h5" strokeLinecap="round" />
    </svg>
  );
}

export interface WorkspacePreviewPanelTileProps {
  tab: WorkspaceDockTab;
  workspaceId: string;
  onRemove?: (workspaceId: string, tabId: string) => void;
}

/** 120px 图标 + 底部标题；非内置面板可删�?*/
export function WorkspacePreviewPanelTile({
  tab,
  workspaceId,
  onRemove,
}: WorkspacePreviewPanelTileProps) {
  const { t } = useI18n();
  const preview = resolveWorkspaceTabPreview(tab);
  const removable = !isWorkspaceBuiltinTab(tab) && Boolean(onRemove);

  const handleRemove = useCallback(
    async (event: MouseEvent) => {
      event.stopPropagation();
      if (!onRemove) return;
      const ok = await appConfirm(
        t("shell.workspacePreview.confirmRemovePanel", { name: preview.title }),
        t("shell.workspacePreview.confirmRemoveTitle"),
      );
      if (!ok) return;
      onRemove(workspaceId, tab.id);
    },
    [onRemove, preview.title, t, tab.id, workspaceId],
  );

  return (
    <div
      className={`workspace-preview__panel-tile${removable ? " workspace-preview__panel-tile--removable" : ""}`}
      role="listitem"
      title={preview.title}
    >
      <div className="workspace-preview__panel-icon-box" data-kind={preview.kind}>
        <PreviewKindIcon kind={preview.kind} />
        {removable ? (
          <button
            type="button"
            className="workspace-preview__panel-remove"
            title={t("shell.workspacePreview.removePanel")}
            aria-label={t("shell.workspacePreview.removePanel")}
            onClick={(event) => void handleRemove(event)}
          >
            ×
          </button>
        ) : null}
      </div>
      <span className="workspace-preview__panel-label">{preview.title}</span>
    </div>
  );
}

/** 空槽占位 */
export function WorkspacePreviewPanelTileEmpty() {
  return (
    <div
      className="workspace-preview__panel-tile workspace-preview__panel-tile--empty"
      role="listitem"
      aria-hidden
    >
      <div className="workspace-preview__panel-icon-box workspace-preview__panel-icon-box--empty" />
      <span className="workspace-preview__panel-label workspace-preview__panel-label--empty" />
    </div>
  );
}
