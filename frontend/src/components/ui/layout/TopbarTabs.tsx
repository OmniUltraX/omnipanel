import { useCallback, useState } from "react";
import { ContextMenu } from "../menu/ContextMenu";
import { TopbarTabAddButton } from "./TopbarTabAddButton";
import { buildTabCloseMenuItems, type TabContextMenuAction } from "../menu/contextMenuItems";
import { useI18n } from "../../../i18n";
import { SegmentTabIcon } from "../../dock/SegmentTabIcon";
import type {
  TopbarHandlers,
  TopbarTabDef,
  TopbarTabMode,
} from "../../../stores/topbarStore";

function tabStatusClass(status?: string) {
  if (status === "connected" || status === "online") return "online";
  if (status === "connecting") return "connecting";
  if (status === "offline") return "offline";
  return "idle";
}

export interface TopbarTabsProps {
  tabs: TopbarTabDef[];
  tabMode: TopbarTabMode;
  showAddTab: boolean;
  addTabTitle?: string;
  handlers: TopbarHandlers;
}

export function TopbarTabs({ tabs, tabMode, showAddTab, addTabTitle, handlers }: TopbarTabsProps) {
  const { t } = useI18n();
  const isSession = tabMode === "session";
  const hasAddMenu = (handlers.addMenuItems?.length ?? 0) > 0;
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; tabId: string; index: number } | null>(null);

  const addTitle =
    addTabTitle ||
    (tabMode === "connection" ? t("shell.topbar.newConnection") : t("shell.topbar.newTab"));

  const handleContextAction = useCallback(
    (action: TabContextMenuAction) => {
      if (!ctxMenu || !handlers.onClose) return;
      if (action === "rename") {
        setCtxMenu(null);
        return;
      }
      const idx = tabs.findIndex((tab) => tab.id === ctxMenu.tabId);
      if (idx < 0) {
        setCtxMenu(null);
        return;
      }
      if (action === "close") {
        handlers.onClose(ctxMenu.tabId);
      } else if (action === "closeLeft") {
        for (let i = idx - 1; i >= 0; i--) handlers.onClose(tabs[i].id);
      } else if (action === "closeRight") {
        for (let i = tabs.length - 1; i > idx; i--) handlers.onClose(tabs[i].id);
      } else if (action === "closeOthers") {
        for (let i = tabs.length - 1; i >= 0; i--) {
          if (i !== idx) handlers.onClose(tabs[i].id);
        }
      } else if (action === "closeAll") {
        for (let i = tabs.length - 1; i >= 0; i--) handlers.onClose(tabs[i].id);
      }
      setCtxMenu(null);
    },
    [ctxMenu, handlers, tabs],
  );

  if (tabs.length === 0) return null;

  return (
    <>
      <div className={`topbar-tabs topbar-tabs--${tabMode}`} data-tauri-drag-region>
        {tabs.map((tab, idx) => (
          <button
            key={tab.id}
            type="button"
            className={`topbar-tab${tab.active ? " active" : ""}`}
            onClick={() => handlers.onSelect?.(tab.id)}
            onContextMenu={(e) => {
              if (!isSession) return;
              e.preventDefault();
              setCtxMenu({ x: e.clientX, y: e.clientY, tabId: tab.id, index: idx });
            }}
          >
            {isSession && tab.status && <span className={`topbar-tab-dot ${tabStatusClass(tab.status)}`} />}
            {tabMode === "segment" && tab.icon && <SegmentTabIcon icon={tab.icon} />}
            <span>{tab.label}</span>
            {tab.badge && (
              <span className={`badge badge-${tab.badge.tone ?? "muted"}`} style={{ marginLeft: 4 }}>
                {tab.badge.text}
              </span>
            )}
            {isSession && tab.closable !== false && handlers.onClose && (
              <span
                className="close"
                onClick={(event) => {
                  event.stopPropagation();
                  handlers.onClose?.(tab.id);
                }}
              >
                &times;
              </span>
            )}
          </button>
        ))}
        {showAddTab && (handlers.onAdd || hasAddMenu) && (
          <TopbarTabAddButton
            title={addTitle}
            menuItems={handlers.addMenuItems}
            onAdd={handlers.onAdd}
            onMenuSelect={handlers.onAddMenuSelect}
          />
        )}
      </div>

      {ctxMenu && isSession && (
        <ContextMenu
          items={buildTabCloseMenuItems(
            t,
            tabs.length,
            Math.max(0, tabs.findIndex((tab) => tab.id === ctxMenu.tabId)),
            handleContextAction,
          )}
          position={{ x: ctxMenu.x, y: ctxMenu.y }}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </>
  );
}
