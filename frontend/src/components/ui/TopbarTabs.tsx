import { useCallback, useState } from "react";
import { ContextMenu } from "./ContextMenu";
import { TopbarTabAddButton } from "./TopbarTabAddButton";
import { buildTabCloseMenuItems, type TabContextMenuAction } from "./contextMenuItems";
import { useI18n } from "../../i18n";
import type {
  TopbarHandlers,
  TopbarTabDef,
  TopbarTabMode,
} from "../../stores/topbarStore";

function tabStatusClass(status?: string) {
  if (status === "connected" || status === "online") return "online";
  if (status === "connecting") return "connecting";
  if (status === "offline") return "offline";
  return "idle";
}

function SegmentTabIcon({ icon }: { icon: TopbarTabDef["icon"] }) {
  if (!icon) return null;
  const props = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, width: 12, height: 12 };
  switch (icon) {
    case "monitor":
      return (
        <svg {...props}>
          <path d="M3 3v18h18" />
          <path d="m19 9-5 5-4-4-3 3" />
        </svg>
      );
    case "processes":
      return (
        <svg {...props}>
          <rect x="3" y="3" width="7" height="7" />
          <rect x="14" y="3" width="7" height="7" />
          <rect x="3" y="14" width="7" height="7" />
          <rect x="14" y="14" width="7" height="7" />
        </svg>
      );
    case "services":
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="3" />
          <path d="M12 1v6M12 17v6M4.22 4.22l4.24 4.24M15.54 15.54l4.24 4.24M1 12h6M17 12h6M4.22 19.78l4.24-4.24M15.54 8.46l4.24-4.24" />
        </svg>
      );
    case "logs":
      return (
        <svg {...props}>
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
          <path d="M14 2v6h6" />
        </svg>
      );
    default:
      return null;
  }
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
