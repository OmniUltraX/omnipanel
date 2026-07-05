import { useEffect } from "react";
import {
  usePersistedVerticalSplitSections,
  VerticalSplitSidebar,
} from "../../../components/ui/sidebar/VerticalSplitSidebar";
import { ServerSidebar } from "../../../components/workspace/ServerSidebar";
import { useI18n } from "../../../i18n";
import type { ServerEntry } from "./serverConnection";
import { useServerSidebarLinkage } from "./ServerSidebarLinkageContext";
import type { ServerPanelDockOpenMode } from "./serverPanelWorkspaceTabs";

const SECTION_STORAGE_KEY = "omnipanel-server-panel-sidebar-sections";

type SectionKey = "servers";

export interface ServerPanelSidebarProps {
  servers: ServerEntry[];
  onSelectServer: (serverId: string, mode?: ServerPanelDockOpenMode) => void;
  onCreateServer?: () => void;
  onEditServer?: (server: ServerEntry) => void;
  onDeleteServer?: (serverId: string) => void;
}

export function ServerPanelSidebar({
  servers,
  onSelectServer,
  onCreateServer,
  onEditServer,
  onDeleteServer,
}: ServerPanelSidebarProps) {
  const { t } = useI18n();
  const { activeServerId } = useServerSidebarLinkage();
  const { sections, toggleSection, setSectionExpanded } = usePersistedVerticalSplitSections<SectionKey>(
    SECTION_STORAGE_KEY,
    { servers: true },
  );

  useEffect(() => {
    if (!activeServerId) {
      return;
    }
    setSectionExpanded("servers", true);
  }, [activeServerId, setSectionExpanded]);

  return (
    <VerticalSplitSidebar className="server-panel-sidebar">
      <ServerSidebar
        servers={servers}
        activeServerId={activeServerId}
        onSelectServer={onSelectServer}
        onCreateServer={onCreateServer}
        onEditServer={onEditServer}
        onDeleteServer={onDeleteServer}
        section={{
          title: t("server.sidebar.title"),
          expanded: sections.servers,
          onToggle: () => toggleSection("servers"),
        }}
      />
    </VerticalSplitSidebar>
  );
}
