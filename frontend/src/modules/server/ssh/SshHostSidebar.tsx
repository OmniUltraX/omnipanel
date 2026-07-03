import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  usePersistedVerticalSplitSections,
  VerticalSplitSidebar,
  VerticalSplitSidebarSection,
} from "../../../components/ui/VerticalSplitSidebar";
import { useI18n } from "../../../i18n";
import { HostListPanel } from "../../../components/workspace/HostListPanel";
import type { WorkspaceResource } from "../../../lib/resourceRegistry";
import { useSshActiveHostStore } from "./stores/sshActiveHostStore";
import type { HostDockOpenMode } from "./workspaceTabs";
import { useSshSelectionStore } from "./stores/sshSelectionStore";
import { useSshWorkspaceNavStore } from "./stores/sshWorkspaceNavStore";
import { TunnelsSidebarPanel } from "./components/TunnelsSidebarPanel";
import { KeysSidebarPanel } from "./components/KeysSidebarPanel";

const SECTION_STORAGE_KEY = "omnipanel-ssh-host-sidebar-sections";

type SectionKey = "hosts" | "tunnels" | "keys";

export interface SshHostSidebarProps {
  resources: WorkspaceResource[];
  onSelectHost: (hostId: string, mode?: HostDockOpenMode) => void;
  selectionMode?: boolean;
  selectedIds?: string[];
}

export function SshHostSidebar({
  resources,
  onSelectHost,
  selectionMode = false,
  selectedIds = [],
}: SshHostSidebarProps) {
  const { t } = useI18n();
  const activeHostId = useSshActiveHostStore((s) => s.activeHostId);
  const selectHostNav = useSshWorkspaceNavStore((s) => s.selectHost);
  const setSection = useSshWorkspaceNavStore((s) => s.setSection);
  const toggleHost = useSshSelectionStore((s) => s.toggleHost);
  const { sections, toggleSection, setSectionExpanded } = usePersistedVerticalSplitSections<SectionKey>(
    SECTION_STORAGE_KEY,
    { hosts: true, tunnels: true, keys: false },
  );
  const [hostHeaderActions, setHostHeaderActions] = useState<ReactNode>(null);
  const [tunnelHeaderActions, setTunnelHeaderActions] = useState<ReactNode>(null);
  const [keyHeaderActions, setKeyHeaderActions] = useState<ReactNode>(null);
  const [hostCount, setHostCount] = useState(resources.length);
  const [tunnelCount, setTunnelCount] = useState(0);
  const [keyCount, setKeyCount] = useState(0);

  const handleHostHeaderMetaChange = useCallback((meta: { count: number; actions: ReactNode }) => {
    setHostCount(meta.count);
    setHostHeaderActions(meta.actions);
  }, []);

  const handleTunnelHeaderMetaChange = useCallback((meta: { count: number; actions: ReactNode }) => {
    setTunnelCount(meta.count);
    setTunnelHeaderActions(meta.actions);
  }, []);

  const handleKeyHeaderMetaChange = useCallback((meta: { count: number; actions: ReactNode }) => {
    setKeyCount(meta.count);
    setKeyHeaderActions(meta.actions);
  }, []);

  const ensureTunnelsExpanded = useCallback(() => {
    setSectionExpanded("tunnels", true);
    setSection("tunnels");
  }, [setSection, setSectionExpanded]);

  const ensureKeysExpanded = useCallback(() => {
    setSectionExpanded("keys", true);
    setSection("keys");
  }, [setSection, setSectionExpanded]);

  const handleSelectHost = useCallback(
    (hostId: string, mode?: HostDockOpenMode) => {
      selectHostNav();
      onSelectHost(hostId, mode);
    },
    [onSelectHost, selectHostNav],
  );

  useEffect(() => {
    setHostCount(resources.length);
  }, [resources.length]);

  useEffect(() => {
    if (!activeHostId) {
      return;
    }
    setSectionExpanded("hosts", true);
  }, [activeHostId, setSectionExpanded]);

  return (
    <VerticalSplitSidebar className="ssh-host-sidebar">
      <VerticalSplitSidebarSection
        title={t("ssh.sidebar.title")}
        expanded={sections.hosts}
        onToggle={() => toggleSection("hosts")}
        actions={
          <>
            {hostHeaderActions}
            <span className="badge badge-muted">{hostCount}</span>
          </>
        }
      >
        <HostListPanel
          resources={resources}
          activeHostId={activeHostId}
          onSelectHost={handleSelectHost}
          embedded
          selectionMode={selectionMode}
          selectedIds={selectedIds}
          onToggleSelect={toggleHost}
          onHeaderMetaChange={handleHostHeaderMetaChange}
        />
      </VerticalSplitSidebarSection>

      <VerticalSplitSidebarSection
        title={t("ssh.tabs.tunnels")}
        expanded={sections.tunnels}
        keepMounted
        onToggle={() => {
          toggleSection("tunnels");
          setSection("tunnels");
        }}
        actions={
          <>
            {tunnelHeaderActions}
            <span className="badge badge-muted">{tunnelCount}</span>
          </>
        }
      >
        <TunnelsSidebarPanel
          sshResources={resources}
          onCountChange={setTunnelCount}
          onHeaderMetaChange={handleTunnelHeaderMetaChange}
          onEnsureExpanded={ensureTunnelsExpanded}
        />
      </VerticalSplitSidebarSection>

      <VerticalSplitSidebarSection
        title={t("ssh.tabs.keys")}
        expanded={sections.keys}
        keepMounted
        onToggle={() => {
          toggleSection("keys");
          setSection("keys");
        }}
        actions={
          <>
            {keyHeaderActions}
            <span className="badge badge-muted">{keyCount}</span>
          </>
        }
      >
        <KeysSidebarPanel
          onCountChange={setKeyCount}
          onHeaderMetaChange={handleKeyHeaderMetaChange}
          onEnsureExpanded={ensureKeysExpanded}
        />
      </VerticalSplitSidebarSection>
    </VerticalSplitSidebar>
  );
}
