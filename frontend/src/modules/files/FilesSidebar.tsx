import { useEffect, useMemo, type MouseEvent } from "react";
import { Button } from "../../components/ui/Button";
import {
  usePersistedVerticalSplitSections,
  VerticalSplitSidebar,
  VerticalSplitSidebarSection,
} from "../../components/ui/VerticalSplitSidebar";
import { useI18n } from "../../i18n";
import type { FileManagerConnectionInfo } from "../../ipc/bindings";
import type { FileProtocol } from "./FileConnectionDialog";
import {
  ConnProtocolIcon,
  IconQuickDesktop,
  IconQuickDocuments,
  IconQuickDownloads,
  IconQuickHome,
} from "./FilesPanelIcons";
import {
  fileSidebarSectionForProtocol,
  groupFileConnectionsByProtocol,
  LOCAL_CONNECTION_ID,
  type FileSidebarProtocolSection,
} from "./utils";

const SECTION_STORAGE_KEY = "omnipanel-files-sidebar-sections-v2";

type SectionKey = FileSidebarProtocolSection;

const SECTION_PROTOCOL: Partial<Record<SectionKey, FileProtocol>> = {
  s3: "s3",
  remote: "sftp",
};

function ConnectionList({
  items,
  activeId,
  emptyLabel,
  compact,
  onSelectConnection,
  onConnContextMenu,
}: {
  items: FileManagerConnectionInfo[];
  activeId: string;
  emptyLabel: string;
  compact?: boolean;
  onSelectConnection: (conn: FileManagerConnectionInfo) => void;
  onConnContextMenu: (e: MouseEvent, conn: FileManagerConnectionInfo) => void;
}) {
  if (items.length === 0) {
    return <p className="fm-conn-empty">{emptyLabel}</p>;
  }
  return (
    <div className={`fm-connections${compact ? " fm-connections--compact" : ""}`}>
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
  );
}

export interface FilesSidebarProps {
  connections: FileManagerConnectionInfo[];
  activeId: string;
  quickPaths: { home: string; desktop: string; documents: string; downloads: string } | null;
  onSelectConnection: (conn: FileManagerConnectionInfo) => void;
  onConnContextMenu: (e: MouseEvent, conn: FileManagerConnectionInfo) => void;
  onAddConnection: (protocol?: FileProtocol) => void;
  onQuickNavigate: (path: string) => void;
}

export function FilesSidebar({
  connections,
  activeId,
  quickPaths,
  onSelectConnection,
  onConnContextMenu,
  onAddConnection,
  onQuickNavigate,
}: FilesSidebarProps) {
  const { t } = useI18n();
  const { sections, toggleSection, setSectionExpanded } = usePersistedVerticalSplitSections<SectionKey>(
    SECTION_STORAGE_KEY,
    { local: true, s3: true, remote: true },
  );
  const connectionsByProtocol = useMemo(
    () => groupFileConnectionsByProtocol(connections),
    [connections],
  );
  const showQuickPaths = activeId === LOCAL_CONNECTION_ID && quickPaths;

  const activeConn = useMemo(
    () => connections.find((conn) => conn.id === activeId),
    [activeId, connections],
  );

  useEffect(() => {
    if (!activeConn) return;
    setSectionExpanded(fileSidebarSectionForProtocol(activeConn.protocol), true);
  }, [activeConn, setSectionExpanded]);

  const sectionDefs: {
    key: SectionKey;
    title: string;
    items: FileManagerConnectionInfo[];
    canAdd: boolean;
  }[] = [
    {
      key: "local",
      title: t("files.sidebar.local"),
      items: connectionsByProtocol.local,
      canAdd: false,
    },
    {
      key: "s3",
      title: t("files.sidebar.s3"),
      items: connectionsByProtocol.s3,
      canAdd: true,
    },
    {
      key: "remote",
      title: t("files.sidebar.remote"),
      items: connectionsByProtocol.remote,
      canAdd: true,
    },
  ];

  const renderAddAction = (sectionKey: SectionKey) => {
    const protocol = SECTION_PROTOCOL[sectionKey];
    if (!protocol) return null;
    return (
      <div className="schema-toolbar schema-toolbar--inline">
        <Button
          variant="icon"
          title={t("files.sidebar.add")}
          onClick={() => onAddConnection(protocol)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </Button>
      </div>
    );
  };

  return (
    <VerticalSplitSidebar className="fm-sidebar">
      {sectionDefs.map(({ key, title, items, canAdd }) => (
        <VerticalSplitSidebarSection
          key={key}
          title={title}
          expanded={sections[key]}
          onToggle={() => toggleSection(key)}
          actions={canAdd ? renderAddAction(key) : undefined}
        >
          <ConnectionList
            items={items}
            activeId={activeId}
            emptyLabel={t("files.sidebar.emptySection")}
            onSelectConnection={onSelectConnection}
            onConnContextMenu={onConnContextMenu}
            compact={key === "local"}
          />
          {key === "local" ? (
            <div className="fm-quick-subsection">
              <div className="fm-quick-subsection-title">{t("files.sidebar.quickPaths")}</div>
              <div className="fm-quick-section">
                {showQuickPaths ? (
                  [
                    { label: t("files.quick.home"), path: quickPaths.home, icon: <IconQuickHome /> },
                    { label: t("files.quick.desktop"), path: quickPaths.desktop, icon: <IconQuickDesktop /> },
                    { label: t("files.quick.documents"), path: quickPaths.documents, icon: <IconQuickDocuments /> },
                    { label: t("files.quick.downloads"), path: quickPaths.downloads, icon: <IconQuickDownloads /> },
                  ].map((item) => (
                    <div key={item.label} className="fm-quick-item" onClick={() => onQuickNavigate(item.path)}>
                      {item.icon}
                      {item.label}
                    </div>
                  ))
                ) : (
                  <p className="fm-quick-section-hint">{t("files.sidebar.quickPathsHint")}</p>
                )}
              </div>
            </div>
          ) : null}
        </VerticalSplitSidebarSection>
      ))}
    </VerticalSplitSidebar>
  );
}
