import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/i18n";
import { ContextMenu, type ContextMenuItem } from "@/components/ui/ContextMenu";
import { Button } from "@/components/ui/Button";
import { MultiSelect } from "@/components/ui/form/MultiSelect";
import { StatusDot, type StatusDotStatus } from "@/components/ui/primitives/StatusDot";
import {
  VerticalSplitSidebarSection,
  type VerticalSplitSidebarSectionConfig,
} from "@/components/ui/VerticalSplitSidebar";
import {
  SidebarTreeEmpty,
  SidebarTreeNode,
  SidebarTreeRoot,
  SidebarTreeSelectionProvider,
  resolveSidebarTreeDeleteTargets,
} from "@/components/ui/sidebar-tree";
import { hasSidebarTreeSearch, sidebarTreeSearchMatches } from "@/lib/sidebarTreeSearch";
import { usePersistedServerTreeExpanded } from "../server/panel/usePersistedServerTreeExpanded";
import { ServerTreeIcon, serverTreeNodeClassName } from "../server/panel/serverTreeIcons";
import { usePluginRuntimeStore } from "@/stores/pluginRuntimeStore";
import { capabilityI18nKey, type CloudAccount } from "./cloudForm";
import { cloudCapabilitiesForPlugin, isGlobalCloudCapability } from "./cloudCapabilities";
import { makeCloudTreeKey, type CloudSidebarNavTarget } from "./cloudWorkspaceTabs";
import { filterCloudResourceRows, resolveCloudQueryRegions } from "./cloudResourceApi";
import { cloudListSlotKey } from "./cloudInventory";
import { cloudListRefreshKey, useCloudInventoryStore } from "../../stores/cloudInventoryStore";
import { cloudRegionLabel } from "./cloudForm";
import type { CloudDockOpenMode } from "./cloudWorkspaceTabs";

export type CloudSidebarNavigate = (target: CloudSidebarNavTarget, mode?: CloudDockOpenMode) => void;

/** 账户任意资源清单拉取失败 → offline（红）；存在成功记录 → online；否则 idle。 */
function accountStatusDotStatus(
  listEntries: Array<{ error?: string | null; fetchedAt?: number }>,
): StatusDotStatus {
  if (listEntries.some((entry) => entry.error)) return "offline";
  if (listEntries.some((entry) => entry.fetchedAt)) return "online";
  return "idle";
}

type CloudAccountBranchProps = {
  account: CloudAccount;
  accountExpanded: boolean;
  activeNavKey: string | null;
  searchQuery: string;
  selectedRegions: string[];
  liveRegionIds: string[];
  ensureExpanded: (key: string) => void;
  isExpanded: (key: string) => boolean;
  toggle: (key: string) => void;
  onNavigate: CloudSidebarNavigate;
};

function CloudAccountBranch({
  account,
  accountExpanded,
  activeNavKey,
  searchQuery,
  selectedRegions,
  liveRegionIds,
  ensureExpanded,
  isExpanded,
  toggle,
  onNavigate,
}: CloudAccountBranchProps) {
  const { t } = useI18n();
  usePluginRuntimeStore((s) => s.items);
  usePluginRuntimeStore((s) => s.hydrated);
  const capabilities = cloudCapabilitiesForPlugin(account.pluginId);
  const nameMatch =
    !hasSidebarTreeSearch(searchQuery) ||
    sidebarTreeSearchMatches(searchQuery, account.name) ||
    sidebarTreeSearchMatches(searchQuery, t("server.cloud.providers.aliyun"));

  const visibleCaps = useMemo(() => {
    if (!hasSidebarTreeSearch(searchQuery) || nameMatch) return capabilities;
    return capabilities.filter((cap) =>
      sidebarTreeSearchMatches(searchQuery, t(capabilityI18nKey(cap.id))),
    );
  }, [capabilities, nameMatch, searchQuery, t]);

  if (!accountExpanded) return null;
  if (hasSidebarTreeSearch(searchQuery) && !nameMatch && visibleCaps.length === 0) {
    return null;
  }

  return (
    <div className="server-tree-children">
      {visibleCaps.map((cap) => {
        const capKey = makeCloudTreeKey({ kind: "capability", accountId: account.id, capability: cap.id });
        return (
          <CloudCapabilityBranch
            key={cap.id}
            account={account}
            capabilityId={cap.id}
            global={isGlobalCloudCapability(cap)}
            capKey={capKey}
            expanded={isExpanded(capKey)}
            activeNavKey={activeNavKey}
            searchQuery={searchQuery}
            selectedRegions={selectedRegions}
            liveRegionIds={liveRegionIds}
            ensureExpanded={ensureExpanded}
            toggle={toggle}
            onNavigate={onNavigate}
          />
        );
      })}
    </div>
  );
}

function CloudCapabilityBranch({
  account,
  capabilityId,
  global,
  capKey,
  expanded,
  activeNavKey,
  searchQuery,
  selectedRegions,
  liveRegionIds,
  ensureExpanded,
  toggle,
  onNavigate,
}: {
  account: CloudAccount;
  capabilityId: string;
  global: boolean;
  capKey: string;
  expanded: boolean;
  activeNavKey: string | null;
  searchQuery: string;
  selectedRegions: string[];
  liveRegionIds: string[];
  ensureExpanded: (key: string) => void;
  toggle: (key: string) => void;
  onNavigate: CloudSidebarNavigate;
}) {
  const { t } = useI18n();
  const queryRegions = useMemo(
    () => (global ? [] : resolveCloudQueryRegions(selectedRegions, liveRegionIds, account.regions)),
    [account.regions, global, liveRegionIds, selectedRegions],
  );
  const listSlot = cloudListSlotKey(capabilityId, queryRegions);
  const listRefreshKey = cloudListRefreshKey(account.id, capabilityId, queryRegions);
  const listEntry = useCloudInventoryStore((s) => s.byAccount[account.id]?.lists[listSlot]);
  const refreshing = useCloudInventoryStore((s) => Boolean(s.refreshingKeys[listRefreshKey]));
  const rows = listEntry?.rows ?? null;

  useEffect(() => {
    if (!expanded) return;
    void useCloudInventoryStore.getState().ensureList(account.id, capabilityId, queryRegions, {
      quiet: true,
    });
  }, [account.id, capabilityId, expanded, queryRegions]);

  const instances = useMemo(() => {
    const list = filterCloudResourceRows(rows ?? [], selectedRegions, global);
    if (!hasSidebarTreeSearch(searchQuery)) return list;
    return list.filter(
      (row) =>
        sidebarTreeSearchMatches(searchQuery, row.name) ||
        sidebarTreeSearchMatches(searchQuery, row.id),
    );
  }, [global, rows, searchQuery, selectedRegions]);

  const label = t(capabilityI18nKey(capabilityId));

  return (
    <>
      <SidebarTreeNode
        depth={1}
        module="cloud"
        nodeType="cloud-capability"
        treeKey={capKey}
        label={label}
        icon={<ServerTreeIcon kind="aliyun" />}
        className={serverTreeNodeClassName("aliyun")}
        hasChildren
        expanded={expanded}
        active={activeNavKey === capKey}
        onToggle={() => toggle(capKey)}
        onSelect={() => {
          ensureExpanded(makeCloudTreeKey({ kind: "account", accountId: account.id }));
          onNavigate({ kind: "capability", accountId: account.id, capability: capabilityId }, "preview");
        }}
        onActivate={() => {
          ensureExpanded(makeCloudTreeKey({ kind: "account", accountId: account.id }));
          onNavigate(
            { kind: "capability", accountId: account.id, capability: capabilityId },
            "permanent",
          );
        }}
      />
      {expanded ? (
        <div className="server-tree-children">
          {refreshing && rows == null ? (
            <SidebarTreeEmpty className="cloud-tree-status">
              <span className="cloud-tree-status__spinner" aria-hidden />
              {t("cloud.tree.loading")}
            </SidebarTreeEmpty>
          ) : instances.length === 0 ? (
            <SidebarTreeEmpty className="cloud-tree-status">{t("cloud.tree.emptyInstances")}</SidebarTreeEmpty>
          ) : (
            instances.map((row) => {
              const itemKey = makeCloudTreeKey({
                kind: "resource",
                accountId: account.id,
                capability: capabilityId,
                resourceId: row.id,
              });
              return (
                <SidebarTreeNode
                  key={row.id}
                  depth={2}
                  module="cloud"
                  nodeType="cloud-instance"
                  treeKey={itemKey}
                  label={row.name || row.id}
                  afterLabel={
                    !global && row.regionId ? (
                      <span className="badge badge-muted">{cloudRegionLabel(row.regionId)}</span>
                    ) : null
                  }
                  icon={<ServerTreeIcon kind="server" />}
                  className={serverTreeNodeClassName("server")}
                  hasChildren={false}
                  expanded={false}
                  active={activeNavKey === itemKey}
                  onToggle={() => {}}
                  onSelect={() =>
                    onNavigate(
                      {
                        kind: "resource",
                        accountId: account.id,
                        capability: capabilityId,
                        resourceId: row.id,
                        regionId: row.regionId,
                      },
                      "preview",
                    )
                  }
                  onActivate={() =>
                    onNavigate(
                      {
                        kind: "resource",
                        accountId: account.id,
                        capability: capabilityId,
                        resourceId: row.id,
                        regionId: row.regionId,
                      },
                      "permanent",
                    )
                  }
                />
              );
            })
          )}
        </div>
      ) : null}
    </>
  );
}

export interface CloudTreeSidebarProps {
  accounts: CloudAccount[];
  activeAccountId: string | null;
  activeNavKey: string | null;
  searchQuery?: string;
  selectedRegions: string[];
  liveRegionIds: string[];
  regionOptions: { value: string; label: string }[];
  onSelectedRegionsChange: (values: string[]) => void;
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
  selectedRegions,
  liveRegionIds,
  regionOptions,
  onSelectedRegionsChange,
  onNavigate,
  onCreateAccount,
  onEditAccount,
  onDeleteAccount,
  section,
}: CloudTreeSidebarProps) {
  const { t } = useI18n();
  usePluginRuntimeStore((s) => s.items);
  usePluginRuntimeStore((s) => s.hydrated);
  const inventoryByAccount = useCloudInventoryStore((s) => s.byAccount);
  const { isExpanded, toggle, ensureExpanded } = usePersistedServerTreeExpanded();
  const [ctxPos, setCtxPos] = useState<{ x: number; y: number } | null>(null);
  const [ctxAccount, setCtxAccount] = useState<CloudAccount | null>(null);
  const selectedIdsRef = useRef<ReadonlySet<string>>(new Set());
  const handleSelectedIdsChange = useCallback((ids: ReadonlySet<string>) => {
    selectedIdsRef.current = ids;
  }, []);

  const visibleAccounts = useMemo(() => {
    if (!hasSidebarTreeSearch(searchQuery)) return accounts;
    return accounts.filter((account) => sidebarTreeSearchMatches(searchQuery, account.name));
  }, [accounts, searchQuery]);

  const ctxItems: ContextMenuItem[] = useMemo(() => {
    if (!ctxAccount) return [];
    const items: ContextMenuItem[] = [];
    if (onEditAccount) {
      items.push({
        id: "edit",
        label: t("common.edit"),
        onClick: () => onEditAccount(ctxAccount),
      });
    }
    if (onDeleteAccount) {
      items.push({
        id: "delete",
        label: t("common.delete"),
        danger: true,
        onClick: () => onDeleteAccount(ctxAccount.id),
      });
    }
    return items;
  }, [ctxAccount, onDeleteAccount, onEditAccount, t]);

  return (
    <VerticalSplitSidebarSection
      title={section?.title ?? t("server.cloud.sidebar.title")}
      expanded={section?.expanded ?? true}
      onToggle={section?.onToggle ?? (() => {})}
      actions={
        onCreateAccount ? (
          <Button type="button" size="sm" variant="ghost" onClick={onCreateAccount}>
            {t("server.cloud.sidebar.addAccount")}
          </Button>
        ) : null
      }
    >
      <SidebarTreeSelectionProvider onSelectedIdsChange={handleSelectedIdsChange}>
        <SidebarTreeRoot>
          {visibleAccounts.map((account) => {
            const accountKey = makeCloudTreeKey({ kind: "account", accountId: account.id });
            const expanded = isExpanded(accountKey);
            const listEntries = Object.values(inventoryByAccount[account.id]?.lists ?? {});
            const accountStatus = accountStatusDotStatus(listEntries);
            const failedEntry = listEntries.find((entry) => entry.error);
            const accountStatusTitle = failedEntry
              ? `${t("common.statusOffline")}：${failedEntry.error}`
              : accountStatus === "online"
                ? t("common.statusOnline")
                : t("common.statusIdle");
            return (
              <div key={account.id}>
                <SidebarTreeNode
                  depth={0}
                  module="cloud"
                  nodeType="cloud-account"
                  treeKey={accountKey}
                  label={account.name}
                  icon={<ServerTreeIcon kind="aliyun" />}
                  prefix={<StatusDot status={accountStatus} title={accountStatusTitle} />}
                  className={serverTreeNodeClassName("aliyun")}
                  hasChildren
                  expanded={expanded}
                  active={activeNavKey === accountKey || activeAccountId === account.id}
                  trailing={
                    activeAccountId === account.id &&
                    cloudCapabilitiesForPlugin(account.pluginId).some((cap) => !isGlobalCloudCapability(cap)) ? (
                      <div
                        className="cloud-tree-region-filter"
                        onClick={(event) => event.stopPropagation()}
                        onPointerDown={(event) => event.stopPropagation()}
                        onDoubleClick={(event) => event.stopPropagation()}
                      >
                        <MultiSelect
                          size="sm"
                          values={selectedRegions}
                          options={regionOptions}
                          onChange={onSelectedRegionsChange}
                          emptyMeansAll
                          searchable
                          panelMinWidth={280}
                          aria-label={t("cloud.filter.allRegions")}
                          placeholder={t("cloud.filter.allRegions")}
                          formatDisplayLabel={(labels, all) =>
                            all || labels.length === 0
                              ? t("cloud.filter.allRegions")
                              : t("server.cloud.create.regionsSelected", { count: String(labels.length) })
                          }
                        />
                      </div>
                    ) : null
                  }
                  onToggle={() => toggle(accountKey)}
                  onSelect={() =>
                    onNavigate({ kind: "account", accountId: account.id }, "preview")
                  }
                  onActivate={() =>
                    onNavigate({ kind: "account", accountId: account.id }, "permanent")
                  }
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setCtxAccount(account);
                    setCtxPos({ x: event.clientX, y: event.clientY });
                  }}
                  onDelete={
                    onDeleteAccount
                      ? () => {
                          const keys = resolveSidebarTreeDeleteTargets(
                            accountKey,
                            selectedIdsRef.current,
                            { filter: (id) => id.startsWith("cloud:") && !id.slice(6).includes(":") },
                          );
                          const ids = keys.map((key) => key.replace(/^cloud:/, ""));
                          if (ids.length === 0) return;
                          onDeleteAccount(ids.length === 1 ? ids[0]! : ids);
                        }
                      : undefined
                  }
                />
                <CloudAccountBranch
                  account={account}
                  accountExpanded={expanded}
                  activeNavKey={activeNavKey}
                  searchQuery={searchQuery}
                  selectedRegions={selectedRegions}
                  liveRegionIds={account.id === activeAccountId ? liveRegionIds : []}
                  ensureExpanded={ensureExpanded}
                  isExpanded={isExpanded}
                  toggle={toggle}
                  onNavigate={onNavigate}
                />
              </div>
            );
          })}
        </SidebarTreeRoot>
      </SidebarTreeSelectionProvider>
      {ctxPos && ctxItems.length > 0 ? (
        <ContextMenu items={ctxItems} position={ctxPos} onClose={() => setCtxPos(null)} />
      ) : null}
    </VerticalSplitSidebarSection>
  );
}
