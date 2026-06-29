import { useEffect } from "react";
import {
  usePersistedVerticalSplitSections,
  VerticalSplitSidebar,
} from "../../../components/ui/VerticalSplitSidebar";
import { useI18n } from "../../../i18n";
import { HostListPanel } from "../../../components/workspace/HostListPanel";
import type { WorkspaceResource } from "../../../lib/resourceRegistry";
import { useSshSidebarLinkage } from "./SshSidebarLinkageContext";
import type { HostDockOpenMode } from "./workspaceTabs";

const SECTION_STORAGE_KEY = "omnipanel-ssh-host-sidebar-sections";

type SectionKey = "hosts";

export interface SshHostSidebarProps {
  resources: WorkspaceResource[];
  onSelectHost: (hostId: string, mode?: HostDockOpenMode) => void;
}

export function SshHostSidebar({ resources, onSelectHost }: SshHostSidebarProps) {
  const { t } = useI18n();
  const { activeHostId } = useSshSidebarLinkage();
  const { sections, toggleSection, setSectionExpanded } = usePersistedVerticalSplitSections<SectionKey>(
    SECTION_STORAGE_KEY,
    { hosts: true },
  );

  useEffect(() => {
    if (!activeHostId) {
      return;
    }
    setSectionExpanded("hosts", true);
  }, [activeHostId, setSectionExpanded]);

  return (
    <VerticalSplitSidebar className="ssh-host-sidebar">
      <HostListPanel
        resources={resources}
        activeHostId={activeHostId}
        onSelectHost={onSelectHost}
        section={{
          title: t("ssh.sidebar.title"),
          expanded: sections.hosts,
          onToggle: () => toggleSection("hosts"),
        }}
      />
    </VerticalSplitSidebar>
  );
}
