import type { MouseEvent } from "react";
import { useI18n } from "../../i18n";
import type { FileManagerConnectionInfo } from "../../ipc/bindings";
import {
  ConnProtocolIcon,
  IconLocalConn,
  IconQuickDesktop,
  IconQuickDocuments,
  IconQuickDownloads,
  IconQuickHome,
  IconS3Conn,
} from "./FilesPanelIcons";
import { LOCAL_CONNECTION_ID } from "./utils";

function groupTitleIcon(group: string, protocol?: string) {
  if (group.includes("S3") || protocol === "s3") return <IconS3Conn />;
  if (group.includes("本地") || protocol === "local") return <IconLocalConn />;
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="8" cy="8" r="6" />
      <path d="M2 8h12M8 2c2 2 2 6 0 8s-2 4-2 4" />
    </svg>
  );
}

export interface FilesSidebarProps {
  groupedConnections: [string, FileManagerConnectionInfo[]][];
  activeId: string;
  quickPaths: { home: string; desktop: string; documents: string; downloads: string } | null;
  onSelectConnection: (conn: FileManagerConnectionInfo) => void;
  onConnContextMenu: (e: MouseEvent, conn: FileManagerConnectionInfo) => void;
  onAddConnection: () => void;
  onQuickNavigate: (path: string) => void;
}

export function FilesSidebar({
  groupedConnections,
  activeId,
  quickPaths,
  onSelectConnection,
  onConnContextMenu,
  onAddConnection,
  onQuickNavigate,
}: FilesSidebarProps) {
  const { t } = useI18n();

  return (
    <aside className="fm-sidebar">
      <div className="fm-sidebar-header">
        <h3>{t("files.sidebar.title")}</h3>
        <button type="button" title={t("files.sidebar.add")} onClick={onAddConnection}>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M8 3v10M3 8h10" />
          </svg>
        </button>
      </div>
      <div className="fm-connections">
        {groupedConnections.map(([group, items]) => (
          <div key={group} className="fm-conn-group">
            <div className="fm-conn-group-title">
              {groupTitleIcon(group, items[0]?.protocol)}
              {group}
            </div>
            {items.map((conn) => (
              <div
                key={conn.id}
                className={`fm-conn-item${conn.id === activeId ? " active" : ""}`}
                onClick={() => onSelectConnection(conn)}
                onContextMenu={(e) => onConnContextMenu(e, conn)}
              >
                <ConnProtocolIcon protocol={conn.protocol} />
                <span className="conn-name">{conn.name}</span>
                <span className={`conn-status ${conn.status === "online" ? "online" : "offline"}`} />
              </div>
            ))}
          </div>
        ))}
      </div>
      {activeId === LOCAL_CONNECTION_ID && quickPaths && (
        <div className="fm-quick-section">
          {[
            { label: t("files.quick.home"), path: quickPaths.home, icon: <IconQuickHome /> },
            { label: t("files.quick.desktop"), path: quickPaths.desktop, icon: <IconQuickDesktop /> },
            { label: t("files.quick.documents"), path: quickPaths.documents, icon: <IconQuickDocuments /> },
            { label: t("files.quick.downloads"), path: quickPaths.downloads, icon: <IconQuickDownloads /> },
          ].map((item) => (
            <div key={item.label} className="fm-quick-item" onClick={() => onQuickNavigate(item.path)}>
              {item.icon}
              {item.label}
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}
