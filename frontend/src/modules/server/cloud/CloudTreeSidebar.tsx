import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/i18n";
import { ContextMenu, type ContextMenuItem } from "@/components/ui/ContextMenu";
import { Button } from "@/components/ui/Button";
import {
  VerticalSplitSidebarSection,
  type VerticalSplitSidebarSectionConfig,
} from "@/components/ui/VerticalSplitSidebar";
import {
  SidebarTreeNode,
  SidebarTreeRoot,
  SidebarTreeSelectionProvider,
  resolveSidebarTreeDeleteTargets,
} from "@/components/ui/sidebar-tree";
import { hasSidebarTreeSearch, sidebarTreeSearchMatches } from "@/lib/sidebarTreeSearch";
import { usePersistedServerTreeExpanded } from "../panel/usePersistedServerTreeExpanded";
import { ServerTreeIcon, serverTreeNodeClassName } from "../panel/serverTreeIcons";
import { cloudRegionLabel, type CloudAccount } from "./cloudForm";
import { makeCloudTreeKey, type CloudSidebarNavigate } from "./cloudSidebarNav";

type CloudAccountBranchProps = {
  account: CloudAccount;
  accountExpanded: boolean;
  activeNavKey: string | null;
  searchQuery: string;
  ensureExpanded: (key: string) => void;
  onNavigate: CloudSidebarNavigate;
};

/** 第二级：地区（叶子节点，资源类型在右侧 Tab）。 */
function CloudAccountBranch({
  account,
  accountExpanded,
  activeNavKey,
  searchQuery,
  ensureExpanded,
  onNavigate,
}: CloudAccountBranchProps) {
  const { t } = useI18n();
  const providerLabel = t(`server.cloud.providers.${account.provider}`);
  const nameMatch =
    !hasSidebarTreeSearch(searchQuery) ||
    sidebarTreeSearchMatches(searchQuery, account.name) ||
    sidebarTreeSearchMatches(searchQuery, providerLabel);

  const regions = useMemo(() => {
    const all = account.regions.map((region) => ({
      region,
      label: cloudRegionLabel(region),
    }));
    if (!hasSidebarTreeSearch(searchQuery) || nameMatch) {
      return all;
    }
    return all.filter(
      (item) =>
        sidebarTreeSearchMatches(searchQuery, item.label) ||
        sidebarTreeSearchMatches(searchQuery, item.region),
    );
  }, [account.regions, nameMatch, searchQuery]);

  useEffect(() => {
    if (!hasSidebarTreeSearch(searchQuery)) return;
    ensureExpanded(makeCloudTreeKey(account.id));
  }, [account.id, ensureExpanded, searchQuery]);

  if (!accountExpanded) return null;
  if (hasSidebarTreeSearch(searchQuery) && !nameMatch && regions.length === 0) {
    return null;
  }

  return (
    <div className="server-tree-children">
      {regions.map((item) => {
        const regionKey = makeCloudTreeKey(account.id, item.region);
        return (
          <SidebarTreeNode
            key={item.region}
            depth={1}
            module="server"
            nodeType="cloud-region"
            treeKey={regionKey}
            label={item.label}
            icon={<ServerTreeIcon kind="server" />}
            className={serverTreeNodeClassName("server")}
            hasChildren={false}
            expanded={false}
            active={activeNavKey === regionKey}
            onToggle={() => {}}
            onActivate={() => {
              ensureExpanded(makeCloudTreeKey(account.id));
              onNavigate({ accountId: account.id, region: item.region }, "permanent");
            }}
          />
        );
      })}
    </div>
  );
}

export interface CloudTreeSidebarProps {
  accounts: CloudAccount[];
  activeAccountId: string | null;
  activeNavKey: string | null;
  searchQuery?: string;
  onNavigate: CloudSidebarNavigate;
  onCreateAccount?: () => void;
  onEditAccount?: (account: CloudAccount) => void;
  onDeleteAccount?: (accountIds: string | string[]) => void;
  section?: VerticalSplitSidebarSectionConfig;
}

export function CloudTreeSidebar({
  accounts,
  activeAccountId,
  activeNavKey,
  searchQuery = "",
  onNavigate,
  onCreateAccount,
  onEditAccount,
  onDeleteAccount,
  section,
}: CloudTreeSidebarProps) {
  const { t } = useI18n();
  const { isExpanded, toggle, ensureExpanded } = usePersistedServerTreeExpanded();
  const [ctxPos, setCtxPos] = useState<{ x: number; y: number } | null>(null);
  const [ctxAccount, setCtxAccount] = useState<CloudAccount | null>(null);
  const selectedIdsRef = useRef<ReadonlySet<string>>(new Set());
  const handleSelectedIdsChange = useCallback((ids: ReadonlySet<string>) => {
    selectedIdsRef.current = ids;
  }, []);

  useEffect(() => {
    if (!activeAccountId) return;
    ensureExpanded(makeCloudTreeKey(activeAccountId));
  }, [activeAccountId, ensureExpanded]);

  useEffect(() => {
    if (!activeNavKey) return;
    // cloud:account(:region)? → 展开账户
    const parts = activeNavKey.split(":");
    if (parts[0] !== "cloud" || parts.length < 2) return;
    ensureExpanded(makeCloudTreeKey(parts[1]!));
  }, [activeNavKey, ensureExpanded]);

  const sortedAccounts = useMemo(
    () => [...accounts].sort((a, b) => a.name.localeCompare(b.name)),
    [accounts],
  );

  useEffect(() => {
    if (!hasSidebarTreeSearch(searchQuery)) return;
    for (const account of sortedAccounts) {
      ensureExpanded(makeCloudTreeKey(account.id));
    }
  }, [ensureExpanded, searchQuery, sortedAccounts]);

  const accountKeyById = useMemo(() => {
    const map = new Map<string, string>();
    for (const account of accounts) {
      map.set(makeCloudTreeKey(account.id), account.id);
    }
    return map;
  }, [accounts]);

  const ctxItems: ContextMenuItem[] = [
    {
      id: "edit",
      label: t("server.sidebar.edit"),
      onClick: () => ctxAccount && onEditAccount?.(ctxAccount),
    },
    {
      id: "delete",
      label: t("server.sidebar.delete"),
      danger: true,
      onClick: () => {
        if (!ctxAccount || !onDeleteAccount) return;
        const clickedKey = makeCloudTreeKey(ctxAccount.id);
        const keys = resolveSidebarTreeDeleteTargets(clickedKey, selectedIdsRef.current, {
          filter: (id) => accountKeyById.has(id),
        });
        const ids = keys
          .map((key) => accountKeyById.get(key))
          .filter((id): id is string => Boolean(id));
        if (ids.length === 0) return;
        onDeleteAccount(ids.length === 1 ? ids[0]! : ids);
      },
    },
  ];

  const addButton = (
    <div className="schema-toolbar schema-toolbar--inline">
      <Button
        type="button"
        variant="icon"
        className="server-sidebar-add"
        title={t("server.cloud.sidebar.addAccount")}
        onClick={onCreateAccount}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </Button>
    </div>
  );

  const body = (
    <>
      <SidebarTreeSelectionProvider onSelectedIdsChange={handleSelectedIdsChange}>
        <SidebarTreeRoot className="server-sidebar-body">
          {sortedAccounts.length === 0 ? (
            <div className="empty-state compact">{t("common.noResources")}</div>
          ) : (
            sortedAccounts.map((account) => {
              const accountKey = makeCloudTreeKey(account.id);
              const accountExpanded = isExpanded(accountKey);
              const regionSelected =
                activeNavKey != null && activeNavKey.startsWith(`${accountKey}:`);
              return (
                <div key={account.id} className="server-tree-server">
                  <SidebarTreeNode
                    depth={0}
                    module="server"
                    nodeType="cloud"
                    treeKey={accountKey}
                    icon={<ServerTreeIcon kind="aliyun" />}
                    className={serverTreeNodeClassName("aliyun")}
                    label={
                      <span className="server-tree-server-label">
                        <span className="server-tree-server-name">{account.name}</span>
                        <span className="badge badge-muted server-item__type-tag">
                          {t(`server.cloud.providers.${account.provider}`)}
                        </span>
                      </span>
                    }
                    hasChildren
                    expanded={accountExpanded}
                    active={
                      activeNavKey === accountKey ||
                      (!regionSelected && activeAccountId === account.id)
                    }
                    onToggle={() => toggle(accountKey)}
                    onActivate={() => {
                      ensureExpanded(accountKey);
                      const firstRegion = account.regions[0];
                      onNavigate(
                        firstRegion
                          ? { accountId: account.id, region: firstRegion }
                          : { accountId: account.id },
                        "permanent",
                      );
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setCtxPos({ x: event.clientX, y: event.clientY });
                      setCtxAccount(account);
                    }}
                  />
                  <CloudAccountBranch
                    account={account}
                    accountExpanded={accountExpanded}
                    activeNavKey={activeNavKey}
                    searchQuery={searchQuery}
                    ensureExpanded={ensureExpanded}
                    onNavigate={onNavigate}
                  />
                </div>
              );
            })
          )}
        </SidebarTreeRoot>
      </SidebarTreeSelectionProvider>
      {ctxPos ? (
        <ContextMenu
          items={ctxItems}
          position={ctxPos}
          onClose={() => {
            setCtxPos(null);
            setCtxAccount(null);
          }}
        />
      ) : null}
    </>
  );

  if (!section) {
    return body;
  }

  return (
    <div className="server-sidebar">
      <VerticalSplitSidebarSection
        {...section}
        actions={
          <>
            <span className="badge badge-muted">{accounts.length}</span>
            {addButton}
          </>
        }
      >
        {body}
      </VerticalSplitSidebarSection>
    </div>
  );
}
