import { useEffect } from "react";
import {
  usePersistedVerticalSplitSections,
  VerticalSplitSidebar,
} from "../../../components/ui/sidebar/VerticalSplitSidebar";
import { useI18n } from "../../../i18n";
import type { ServerEntry } from "./serverConnection";
import { useServerSidebarLinkage } from "./ServerSidebarLinkageContext";
import { ServerPanelTreeSidebar } from "./ServerPanelTreeSidebar";

const SECTION_STORAGE_KEY = "omnipanel-server-panel-sidebar-sections";

type SectionKey = "servers";

export interface ServerPanelSidebarProps {
  servers: ServerEntry[];
  onCreateServer?: () => void;
  onEditServer?: (server: ServerEntry) => void;
  onDeleteServer?: (serverId: string) => void;
}

export function ServerPanelSidebar({
  servers,
  onCreateServer,
  onEditServer,
  onDeleteServer,
}: ServerPanelSidebarProps) {
  const { t } = useI18n();
  const { activeServerId, activeNavKey, onNavigate } = useServerSidebarLinkage();
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
      <ServerPanelTreeSidebar
        servers={servers}
        activeServerId={activeServerId}
        activeNavKey={activeNavKey}
        onNavigate={onNavigate}
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
