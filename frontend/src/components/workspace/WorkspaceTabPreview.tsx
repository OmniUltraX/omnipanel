import { useSyncExternalStore } from "react";
import type { WorkspaceDockTab } from "../../stores/workspaceBottomDockStore";
import {
  getMirroredDbTabVersion,
  subscribeMirroredDbTab,
} from "../../stores/dbWorkspaceMirrorStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { resolveWorkspaceTabPreview } from "../../lib/workspaceTabPreview";

interface WorkspaceTabPreviewProps {
  tab: WorkspaceDockTab;
  active?: boolean;
  compact?: boolean;
}

function usePreviewRevision(tab: WorkspaceDockTab): number {
  const terminalVersion = useTerminalStore((s) => {
    const id =
      tab.originScope === "terminal" && tab.originPanelId
        ? tab.originPanelId
        : tab.payload?.module === "terminal"
          ? tab.payload.id
          : null;
    if (!id) return 0;
    const t = s.tabs.find((item) => item.id === id);
    return t?.terminal ? t.terminal.buffer.active.length : 0;
  });

  const dbVersion = useSyncExternalStore(
    (onStoreChange) => {
      const id =
        tab.originScope === "database" && tab.originPanelId
          ? tab.originPanelId
          : tab.payload?.module === "database"
            ? tab.payload.id
            : null;
      if (!id) return () => undefined;
      return subscribeMirroredDbTab(id, onStoreChange);
    },
    () => {
      const id =
        tab.originScope === "database" && tab.originPanelId
          ? tab.originPanelId
          : tab.payload?.module === "database"
            ? tab.payload.id
            : null;
      return id ? getMirroredDbTabVersion(id) : 0;
    },
    () => 0,
  );

  return terminalVersion + dbVersion;
}

export function WorkspaceTabPreview({ tab, active, compact }: WorkspaceTabPreviewProps) {
  usePreviewRevision(tab);
  const preview = resolveWorkspaceTabPreview(tab);

  return (
    <div
      className={`ws-tab-preview${active ? " ws-tab-preview--active" : ""}${compact ? " ws-tab-preview--compact" : ""}`}
      data-kind={preview.kind}
    >
      <div className="ws-tab-preview__head">
        <span className="ws-tab-preview__source">{preview.source}</span>
        {preview.status ? (
          <span className={`ws-tab-preview__status ws-tab-preview__status--${preview.status}`}>
            {preview.status}
          </span>
        ) : null}
      </div>
      <div className="ws-tab-preview__title">{preview.title}</div>
      {!compact ? (
        <pre className="ws-tab-preview__body" aria-hidden>
          {preview.lines.join("\n")}
        </pre>
      ) : (
        <span className="ws-tab-preview__hint">{preview.lines[0] ?? preview.title}</span>
      )}
    </div>
  );
}
