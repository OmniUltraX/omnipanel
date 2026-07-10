import { useEffect } from "react";
import {
  usePersistedVerticalSplitSections,
  VerticalSplitSidebar,
} from "../../components/ui/sidebar/VerticalSplitSidebar";
import { useI18n } from "../../i18n";
import type { DockerConnectionInfo } from "../../ipc/bindings";
import { DockerPanelTreeSidebar } from "./DockerPanelTreeSidebar";
import { useDockerSidebarLinkage } from "./DockerSidebarLinkageContext";
import type { DockerConnectionDockOpenMode } from "./dockerConnectionWorkspaceTabs";
import type { DockerSidebarNavigate } from "./dockerSidebarNav";

const SECTION_STORAGE_KEY = "omnipanel-docker-connection-sidebar-sections";

type SectionKey = "connections";

export interface DockerConnectionSidebarProps {
  connections: DockerConnectionInfo[];
  loading?: boolean;
  scanning?: boolean;
  onNavigate: DockerSidebarNavigate;
  onCreate: () => void;
  onScan?: () => void;
  onEditConnection?: (connection: DockerConnectionInfo) => void;
  onDeleteConnection?: (connectionId: string) => void;
}

export function DockerConnectionSidebar({
  connections,
  loading,
  scanning,
  onNavigate,
  onCreate,
  onScan,
  onEditConnection,
  onDeleteConnection,
}: DockerConnectionSidebarProps) {
  const { t } = useI18n();
  const { activeConnectionId, activeNavKey } = useDockerSidebarLinkage();
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
      <DockerPanelTreeSidebar
        connections={connections}
        activeConnectionId={activeConnectionId}
        activeNavKey={activeNavKey}
        loading={loading}
        scanning={scanning}
        onNavigate={onNavigate}
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

/** @deprecated 使用 onNavigate 回调 */
export type DockerConnectionSidebarSelect = (
  connectionId: string,
  mode?: DockerConnectionDockOpenMode,
) => void;
