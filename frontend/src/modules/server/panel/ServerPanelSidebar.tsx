import { useEffect, useState } from "react";
import {
  usePersistedVerticalSplitSections,
  VerticalSplitSidebar,
} from "../../../components/ui/sidebar/VerticalSplitSidebar";
import { ScopedSearch } from "../../../components/ui/search";
import { useI18n } from "../../../i18n";
import type { ServerEntry } from "./serverConnection";
import { useServerSidebarLinkage } from "./ServerSidebarLinkageContext";
import { ServerPanelTreeSidebar } from "./ServerPanelTreeSidebar";
import { CloudTreeSidebar } from "../cloud/CloudTreeSidebar";
import type { CloudAccount } from "../cloud/cloudForm";
import type { CloudSidebarNavigate } from "../cloud/cloudSidebarNav";

const SECTION_STORAGE_KEY = "omnipanel-server-panel-sidebar-sections";
/** 与数据库 / SSH 侧栏一致：次要段 autoSize 高度持久化 */
const SIZE_STORAGE_KEY = "omnipanel-server-panel-sidebar-sizes";

type SectionKey = "servers" | "cloud";

export interface ServerPanelSidebarProps {
  servers: ServerEntry[];
  cloudAccounts: CloudAccount[];
  onCreateServer?: () => void;
  onEditServer?: (server: ServerEntry) => void;
  onDeleteServer?: (serverIds: string | string[]) => void;
  onCreateCloud?: () => void;
  onEditCloud?: (account: CloudAccount) => void;
  onDeleteCloud?: (accountIds: string | string[]) => void;
  onNavigateCloud?: CloudSidebarNavigate;
  activeCloudAccountId?: string | null;
  activeCloudNavKey?: string | null;
}

export function ServerPanelSidebar({
  servers,
  cloudAccounts,
  onCreateServer,
  onEditServer,
  onDeleteServer,
  onCreateCloud,
  onEditCloud,
  onDeleteCloud,
  onNavigateCloud,
  activeCloudAccountId = null,
  activeCloudNavKey = null,
}: ServerPanelSidebarProps) {
  const { t } = useI18n();
  const { activeServerId, activeNavKey, onNavigate } = useServerSidebarLinkage();
  const [searchQuery, setSearchQuery] = useState("");
  const { sections, toggleSection, setSectionExpanded } = usePersistedVerticalSplitSections<SectionKey>(
    SECTION_STORAGE_KEY,
    { servers: true, cloud: true },
  );

  useEffect(() => {
    if (!activeServerId) {
      return;
    }
    setSectionExpanded("servers", true);
  }, [activeServerId, setSectionExpanded]);

  useEffect(() => {
    if (!activeCloudAccountId) {
      return;
    }
    setSectionExpanded("cloud", true);
  }, [activeCloudAccountId, setSectionExpanded]);

  return (
    <VerticalSplitSidebar className="server-panel-sidebar">
      <ScopedSearch
        className="server-tree-scoped-search"
        value={searchQuery}
        onChange={setSearchQuery}
        placeholder={t("server.sidebar.search")}
      >
        <ServerPanelTreeSidebar
          servers={servers}
          activeServerId={activeServerId}
          activeNavKey={activeNavKey}
          searchQuery={searchQuery}
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
        <CloudTreeSidebar
          accounts={cloudAccounts}
          activeAccountId={activeCloudAccountId}
          activeNavKey={activeCloudNavKey}
          searchQuery={searchQuery}
          onNavigate={onNavigateCloud ?? (() => {})}
          onCreateAccount={onCreateCloud}
          onEditAccount={onEditCloud}
          onDeleteAccount={onDeleteCloud}
          section={{
            title: t("server.cloud.sidebar.title"),
            expanded: sections.cloud,
            onToggle: () => toggleSection("cloud"),
            // 与数据库「查询/同步」、SSH「隧道/密钥」一致：按内容自适应，可拖拽并持久化
            autoSize: true,
            autoSizePersist: { storageKey: SIZE_STORAGE_KEY, id: "cloud" },
          }}
        />
      </ScopedSearch>
    </VerticalSplitSidebar>
  );
}
