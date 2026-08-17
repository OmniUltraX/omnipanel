import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  usePersistedVerticalSplitSections,
  usePersistedVerticalSplitSizes,
  VerticalSplitSidebar,
  VerticalSplitSidebarSection,
} from "../../../components/ui/sidebar/VerticalSplitSidebar";
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
const SIZE_STORAGE_KEY = "omnipanel-ssh-host-sidebar-sizes";

const SECTION_MIN_BODY = 72;
const SECTION_MAX_BODY = 480;
const SECTION_DEFAULT_BODY = 160;

type SectionKey = "hosts" | "tunnels" | "keys";
type SizedSectionKey = "hosts" | "tunnels";

function clampBodyHeight(value: number): number {
  return Math.max(SECTION_MIN_BODY, Math.min(SECTION_MAX_BODY, Math.round(value)));
}

export interface SshHostSidebarProps {
  resources: WorkspaceResource[];
  onSelectHost: (hostId: string, mode?: HostDockOpenMode) => void;
  selectionMode?: boolean;
  selectedIds?: string[];
  /** 标签筛选 moduleKey，默认 ssh */
  tagModuleKey?: string;
}

export function SshHostSidebar({
  resources,
  onSelectHost,
  selectionMode = false,
  selectedIds = [],
  tagModuleKey = "ssh",
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
  const { sizes, setSize, isUserSized } = usePersistedVerticalSplitSizes<SizedSectionKey>(SIZE_STORAGE_KEY);
  const hostsMeasureRef = useRef<HTMLDivElement>(null);
  const tunnelsMeasureRef = useRef<HTMLDivElement>(null);
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

  useLayoutEffect(() => {
    if (!sections.hosts || isUserSized("hosts")) return;
    const el = hostsMeasureRef.current;
    if (!el) return;
    const next = clampBodyHeight(el.scrollHeight || SECTION_DEFAULT_BODY);
    if (sizes.hosts !== next) setSize("hosts", next);
  }, [
    hostCount,
    isUserSized,
    resources.length,
    sections.hosts,
    setSize,
    sizes.hosts,
  ]);

  useLayoutEffect(() => {
    if (!sections.tunnels || isUserSized("tunnels")) return;
    const el = tunnelsMeasureRef.current;
    if (!el) return;
    const next = clampBodyHeight(el.scrollHeight || SECTION_DEFAULT_BODY);
    if (sizes.tunnels !== next) setSize("tunnels", next);
  }, [isUserSized, sections.tunnels, setSize, sizes.tunnels, tunnelCount]);

  const hostsBodyHeight = sizes.hosts ?? SECTION_DEFAULT_BODY;
  const tunnelsBodyHeight = sizes.tunnels ?? SECTION_DEFAULT_BODY;

  return (
    <VerticalSplitSidebar className="ssh-host-sidebar">
      <VerticalSplitSidebarSection
        title={t("ssh.sidebar.title")}
        expanded={sections.hosts}
        onToggle={() => toggleSection("hosts")}
        bodyHeightPx={sections.hosts ? hostsBodyHeight : undefined}
        onBodyHeightChange={
          sections.hosts
            ? (height) => setSize("hosts", clampBodyHeight(height), { user: true })
            : undefined
        }
        resizePlacement="bottom"
        minBodyHeightPx={SECTION_MIN_BODY}
        maxBodyHeightPx={SECTION_MAX_BODY}
        actions={
          <>
            {hostHeaderActions}
            <span className="badge badge-muted">{hostCount}</span>
          </>
        }
      >
        <div ref={hostsMeasureRef} className="vsplit-sidebar-section__measure">
          <HostListPanel
            resources={resources}
            activeHostId={activeHostId}
            onSelectHost={handleSelectHost}
            embedded
            selectionMode={selectionMode}
            selectedIds={selectedIds}
            onToggleSelect={toggleHost}
            onHeaderMetaChange={handleHostHeaderMetaChange}
            tagModuleKey={tagModuleKey}
          />
        </div>
      </VerticalSplitSidebarSection>

      <VerticalSplitSidebarSection
        title={t("ssh.tabs.tunnels")}
        expanded={sections.tunnels}
        keepMounted
        bodyHeightPx={sections.tunnels ? tunnelsBodyHeight : undefined}
        onBodyHeightChange={
          sections.tunnels
            ? (height) => setSize("tunnels", clampBodyHeight(height), { user: true })
            : undefined
        }
        minBodyHeightPx={SECTION_MIN_BODY}
        maxBodyHeightPx={SECTION_MAX_BODY}
        resizePlacement="bottom"
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
        <div ref={tunnelsMeasureRef} className="vsplit-sidebar-section__measure">
          <TunnelsSidebarPanel
            sshResources={resources}
            onCountChange={setTunnelCount}
            onHeaderMetaChange={handleTunnelHeaderMetaChange}
            onEnsureExpanded={ensureTunnelsExpanded}
          />
        </div>
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
