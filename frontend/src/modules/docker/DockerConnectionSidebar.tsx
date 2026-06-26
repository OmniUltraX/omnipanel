import { useEffect } from "react";
import {
  usePersistedVerticalSplitSections,
  VerticalSplitSidebar,
} from "../../components/ui/VerticalSplitSidebar";
import { useI18n } from "../../i18n";
import { DockerSidebar } from "../../components/workspace/DockerSidebar";
import type { DockerConnectionInfo } from "../../ipc/bindings";
import { useDockerSidebarLinkage } from "./DockerSidebarLinkageContext";
import type { DockerConnectionDockOpenMode } from "./dockerConnectionWorkspaceTabs";

const SECTION_STORAGE_KEY = "omnipanel-docker-connection-sidebar-sections";

type SectionKey = "connections";

export interface DockerConnectionSidebarProps {
  connections: DockerConnectionInfo[];
  loading?: boolean;
  scanning?: boolean;
  onSelectConnection: (connectionId: string, mode?: DockerConnectionDockOpenMode) => void;
  onCreate: () => void;
  onScan?: () => void;
  onEditConnection?: (connection: DockerConnectionInfo) => void;
  onDeleteConnection?: (connectionId: string) => void;
}

export function DockerConnectionSidebar({
  connections,
  loading,
  scanning,
  onSelectConnection,
  onCreate,
  onScan,
  onEditConnection,
  onDeleteConnection,
}: DockerConnectionSidebarProps) {
  const { t } = useI18n();
  const { activeConnectionId } = useDockerSidebarLinkage();
  const { sections, toggleSection, setSectionExpanded } = usePersistedVerticalSplitSections<SectionKey>(
    SECTION_STORAGE_KEY,
    { connections: true },
  );

  useEffect(() => {
    if (!activeConnectionId) {
      return;
    }
    setSectionExpanded("connections", true);
  }, [activeConnectionId, setSectionExpanded]);

  return (
    <VerticalSplitSidebar className="docker-connection-sidebar">
      <DockerSidebar
        connections={connections}
        activeConnectionId={activeConnectionId}
        loading={loading}
        scanning={scanning}
        onSelectConnection={onSelectConnection}
        onCreate={onCreate}
        onScan={onScan}
        onEditConnection={onEditConnection}
        onDeleteConnection={onDeleteConnection}
        section={{
          title: t("docker.sidebar.connections"),
          expanded: sections.connections,
          onToggle: () => toggleSection("connections"),
        }}
      />
    </VerticalSplitSidebar>
  );
}
