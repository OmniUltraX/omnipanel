import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/i18n";
import { ContextMenu, type ContextMenuItem } from "@/components/ui/menu";
import { contextMenuIcons } from "@/components/ui/menu/contextMenuIcons";
import { WorkbenchActionButton } from "@/components/ui/primitives/WorkbenchActionButton";
import { IconPlus } from "@/components/ui/Icons";
import { MultiSelect } from "@/components/ui/form/MultiSelect";
import {
  ModuleSidebarSection,
  ModuleSidebarTreeToolbar,
  SidebarCountBadge,
  SidebarStatusDot,
  usePersistedTreeExpanded,
} from "@/components/ui/module-sidebar";
import { type VerticalSplitSidebarSectionConfig } from "@/components/ui/sidebar/VerticalSplitSidebar";
import {
  SidebarTreeEmpty,
  SidebarTreeNode,
  SidebarTreeRoot,
  SidebarTreeSelectionProvider,
  resolveSidebarTreeDeleteTargets,
  type TreeRowMouseEvent,
} from "@/components/ui/sidebar-tree";
import { hasSidebarTreeSearch, sidebarTreeSearchMatches } from "@/lib/sidebarTreeSearch";
import { afterPaintIdle } from "@/lib/yieldToMain";
import { ServerTreeIcon, serverTreeNodeClassName } from "../server/panel/serverTreeIcons";
import { pluginDisplayName } from "../plugins/pluginDisplayName";
import { isPluginActivated, usePluginRuntimeStore } from "@/stores/pluginRuntimeStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { showToast } from "@/stores/toastStore";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { cloudAccountConsoleUrl, cloudBrandKind, cloudCapabilityLabel, type CloudAccount } from "./cloudForm";
import { cloudCapabilitiesForPlugin, isGlobalCloudCapability } from "./cloudCapabilities";
import {
  capabilityHasDeclaredAction,
  makeCloudTreeKey,
  type CloudDockOpenMode,
  type CloudSidebarNavTarget,
} from "./cloudWorkspaceTabs";
import { cloudRowField, filterCloudResourceRows, resolveCloudQueryRegions } from "./cloudResourceApi";
import { cloudListSlotKey, cloudAccountStatusDot, cloudAccountStatusError } from "./cloudInventory";
import { cloudAccountRefreshKey, cloudListRefreshKey, useCloudInventoryStore } from "../../stores/cloudInventoryStore";
import { cloudRegionLabel } from "./cloudForm";
import { copyCloudText } from "./cloudDetailUi";
import { addCloudInstanceToSsh } from "./cloudResourceLinks";
import type { CloudResourceRow } from "../../ipc/bindings";
import { formatIpcError } from "../../ipc/result";

type CloudTreeCtxTarget =
  | { kind: "account"; account: CloudAccount }
  | { kind: "capability"; account: CloudAccount; capabilityId: string }
  | { kind: "resource"; account: CloudAccount; capabilityId: string; row: CloudResourceRow };

type CloudTreeContextHandler = (event: TreeRowMouseEvent, target: CloudTreeCtxTarget) => void;

async function refreshCloudAccountTree(
  account: CloudAccount,
  selectedRegions: string[],
  liveRegionIds: string[],
  opts: { force?: boolean; quiet?: boolean } = {},
): Promise<void> {
  if (!isPluginActivated(account.pluginId)) return;
  const store = useCloudInventoryStore.getState();
  const quiet = opts.quiet ?? true;
  await store.ensureAccount(account.id, { force: opts.force, quiet }).catch(() => null);
  await store.ensureRegions(account.id, { force: opts.force, quiet }).catch(() => []);
  const caps = cloudCapabilitiesForPlugin(account.pluginId);
  await Promise.all(
    caps.map((cap) => {
      const regions = isGlobalCloudCapability(cap)
        ? []
        : resolveCloudQueryRegions(selectedRegions, liveRegionIds, account.regions);
      return store
        .ensureList(account.id, cap.id, regions, { force: opts.force, quiet })
        .catch(() => []);
    }),
  );
}

export type CloudSidebarNavigate = (target: CloudSidebarNavTarget, mode?: CloudDockOpenMode) => void;

type CloudAccountBranchProps = {
  account: CloudAccount;
  accountExpanded: boolean;
  live: boolean;
  activeNavKey: string | null;
  searchQuery: string;
  selectedRegions: string[];
  liveRegionIds: string[];
  ensureExpanded: (key: string) => void;
  isExpanded: (key: string) => boolean;
  toggle: (key: string) => void;
  onNavigate: CloudSidebarNavigate;
  onNodeContextMenu: CloudTreeContextHandler;
};

function CloudAccountBranch({
  account,
  accountExpanded,
  live,
  activeNavKey,
  searchQuery,
  selectedRegions,
  liveRegionIds,
  ensureExpanded,
  isExpanded,
  toggle,
  onNavigate,
  onNodeContextMenu,
}: CloudAccountBranchProps) {
  const { t } = useI18n();
  usePluginRuntimeStore((s) => s.items);
  usePluginRuntimeStore((s) => s.hydrated);
  const capabilities = cloudCapabilitiesForPlugin(account.pluginId);
  const nameMatch =
    !hasSidebarTreeSearch(searchQuery) ||
    sidebarTreeSearchMatches(searchQuery, account.name) ||
    sidebarTreeSearchMatches(searchQuery, pluginDisplayName(account.pluginId, t));

  useEffect(() => {
    if (!live || !accountExpanded || !isPluginActivated(account.pluginId)) return;
    void useCloudInventoryStore
      .getState()
      .ensureAccount(account.id, { quiet: true })
      .catch(() => undefined);
  }, [account.id, account.pluginId, accountExpanded, live]);

  const visibleCaps = useMemo(() => {
    if (!hasSidebarTreeSearch(searchQuery) || nameMatch) return capabilities;
    return capabilities.filter((cap) =>
      sidebarTreeSearchMatches(searchQuery, cloudCapabilityLabel(t, cap.id, account.pluginId)),
    );
  }, [account.pluginId, capabilities, nameMatch, searchQuery, t]);

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
            live={live}
            expanded={isExpanded(capKey)}
            activeNavKey={activeNavKey}
            searchQuery={searchQuery}
            selectedRegions={selectedRegions}
            liveRegionIds={liveRegionIds}
            ensureExpanded={ensureExpanded}
            toggle={toggle}
            onNavigate={onNavigate}
            onNodeContextMenu={onNodeContextMenu}
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
  live,
  activeNavKey,
  searchQuery,
  selectedRegions,
  liveRegionIds,
  ensureExpanded,
  toggle,
  onNavigate,
  onNodeContextMenu,
}: {
  account: CloudAccount;
  capabilityId: string;
  global: boolean;
  capKey: string;
  expanded: boolean;
  live: boolean;
  activeNavKey: string | null;
  searchQuery: string;
  selectedRegions: string[];
  liveRegionIds: string[];
  ensureExpanded: (key: string) => void;
  toggle: (key: string) => void;
  onNavigate: CloudSidebarNavigate;
  onNodeContextMenu: CloudTreeContextHandler;
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

  // 账户展开后错峰预拉清单（数量徽标）；悬停预挂壳 / 非 live 不打接口
  useEffect(() => {
    if (!live || !isPluginActivated(account.pluginId)) return;
    const cancel = afterPaintIdle(() => {
      void useCloudInventoryStore
        .getState()
        .ensureList(account.id, capabilityId, queryRegions, { quiet: true })
        .catch(() => undefined);
    }, 400);
    return cancel;
  }, [account.id, account.pluginId, capabilityId, live, queryRegions]);

  const regionRows = useMemo(
    () => filterCloudResourceRows(rows ?? [], selectedRegions, global),
    [global, rows, selectedRegions],
  );

  const instances = useMemo(() => {
    if (!hasSidebarTreeSearch(searchQuery)) return regionRows;
    return regionRows.filter(
      (row) =>
        sidebarTreeSearchMatches(searchQuery, row.name) ||
        sidebarTreeSearchMatches(searchQuery, row.id),
    );
  }, [regionRows, searchQuery]);

  const label = cloudCapabilityLabel(t, capabilityId, account.pluginId);
  const countBadge =
    rows == null ? (refreshing ? "…" : null) : String(regionRows.length);

  return (
    <>
      <SidebarTreeNode
        depth={1}
        module="cloud"
        nodeType="cloud-capability"
        treeKey={capKey}
        label={label}
        afterLabel={
          countBadge != null ? <SidebarCountBadge count={countBadge} /> : null
        }
        icon={<ServerTreeIcon kind={cloudBrandKind(account.pluginId)} />}
        className={serverTreeNodeClassName(cloudBrandKind(account.pluginId))}
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
        onContextMenu={(event) =>
          onNodeContextMenu(event, { kind: "capability", account, capabilityId })
        }
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
                      <span className="sidebar-tag-chip badge badge-muted">{cloudRegionLabel(row.regionId)}</span>
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
                  onContextMenu={(event) =>
                    onNodeContextMenu(event, { kind: "resource", account, capabilityId, row })
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
  /** 模块未激活（保活/悬停预挂壳）时不打云厂商。 */
  live?: boolean;
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
  live = true,
  section,
}: CloudTreeSidebarProps) {
  const { t } = useI18n();
  const pluginItems = usePluginRuntimeStore((s) => s.items);
  usePluginRuntimeStore((s) => s.hydrated);
  const inventoryByAccount = useCloudInventoryStore((s) => s.byAccount);
  const refreshingKeys = useCloudInventoryStore((s) => s.refreshingKeys);
  const refreshConnections = useConnectionStore((s) => s.refresh);
  const connectionsLoading = useConnectionStore((s) => s.loading);
  const saveConn = useConnectionStore((s) => s.save);
  // storageKey 沿用旧 key，用户现有展开态不断（与服务器面板共用同一份展开表）。
  const { isExpanded, toggle, ensureExpanded, setAllExpanded } = usePersistedTreeExpanded(
    "omnipanel-server-tree-expanded.v1",
  );
  const [ctxPos, setCtxPos] = useState<{ x: number; y: number } | null>(null);
  const [ctxTarget, setCtxTarget] = useState<CloudTreeCtxTarget | null>(null);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const selectedIdsRef = useRef<ReadonlySet<string>>(new Set());
  const handleSelectedIdsChange = useCallback((ids: ReadonlySet<string>) => {
    selectedIdsRef.current = ids;
  }, []);
  const handleNodeContextMenu = useCallback<CloudTreeContextHandler>((event, target) => {
    event.preventDefault();
    setCtxTarget(target);
    setCtxPos({ x: event.clientX, y: event.clientY });
  }, []);

  const visibleAccounts = useMemo(() => {
    if (!hasSidebarTreeSearch(searchQuery)) return accounts;
    return accounts.filter(
      (account) =>
        sidebarTreeSearchMatches(searchQuery, account.name) ||
        sidebarTreeSearchMatches(searchQuery, pluginDisplayName(account.pluginId, t)),
    );
  }, [accounts, searchQuery, t]);

  const accountKeys = useMemo(
    () => visibleAccounts.map((account) => makeCloudTreeKey({ kind: "account", accountId: account.id })),
    [visibleAccounts],
  );
  const expandableKeys = useMemo(
    () =>
      visibleAccounts.flatMap((account) => {
        const accountKey = makeCloudTreeKey({ kind: "account", accountId: account.id });
        const capKeys = cloudCapabilitiesForPlugin(account.pluginId).map((cap) =>
          makeCloudTreeKey({ kind: "capability", accountId: account.id, capability: cap.id }),
        );
        return [accountKey, ...capKeys];
      }),
    [pluginItems, visibleAccounts],
  );
  const orderedKeys = useMemo(
    () =>
      visibleAccounts.flatMap((account) => {
        const accountKey = makeCloudTreeKey({ kind: "account", accountId: account.id });
        const capKeys = cloudCapabilitiesForPlugin(account.pluginId).map((cap) =>
          makeCloudTreeKey({ kind: "capability", accountId: account.id, capability: cap.id }),
        );
        return [accountKey, ...capKeys];
      }),
    [pluginItems, visibleAccounts],
  );
  const expandAllDisabled =
    expandableKeys.length === 0 || expandableKeys.every((key) => isExpanded(key));
  const collapseAllDisabled =
    expandableKeys.length === 0 || expandableKeys.every((key) => !isExpanded(key));

  const handleRefreshAccount = useCallback(
    (account: CloudAccount, force = true) => {
      void refreshCloudAccountTree(
        account,
        selectedRegions,
        account.id === activeAccountId ? liveRegionIds : [],
        { force, quiet: true },
      ).catch((err) => showToast(formatIpcError(err)));
    },
    [activeAccountId, liveRegionIds, selectedRegions],
  );

  const handleRefreshAll = useCallback(() => {
    void (async () => {
      setRefreshingAll(true);
      try {
        await refreshConnections();
        await Promise.all(
          accounts.map((account) =>
            refreshCloudAccountTree(
              account,
              selectedRegions,
              account.id === activeAccountId ? liveRegionIds : [],
              { force: true, quiet: true },
            ),
          ),
        );
      } catch (err) {
        showToast(formatIpcError(err));
      } finally {
        setRefreshingAll(false);
      }
    })();
  }, [accounts, activeAccountId, liveRegionIds, refreshConnections, selectedRegions]);

  const activatedPluginKey = useMemo(
    () =>
      pluginItems
        .filter((item) => item.enabled && item.activated)
        .map((item) => item.id)
        .sort()
        .join(","),
    [pluginItems],
  );
  const accountIdsKey = useMemo(() => accounts.map((account) => account.id).join(","), [accounts]);

  const prevActivatedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!live) return;
    const prev = prevActivatedRef.current;
    const next = new Set(
      pluginItems
        .filter((item) => item.enabled && item.activated)
        .map((item) => item.id),
    );
    const cancel = afterPaintIdle(() => {
      for (const account of accounts) {
        if (!isPluginActivated(account.pluginId)) continue;
        const justActivated = prev.size > 0 && !prev.has(account.pluginId) && next.has(account.pluginId);
        const snap = useCloudInventoryStore.getState().getAccountInventory(account.id).snapshot;
        if (!justActivated && snap && !snap.error) continue;
        void useCloudInventoryStore
          .getState()
          .ensureAccount(account.id, { force: justActivated, quiet: true })
          .catch(() => undefined);
      }
      prevActivatedRef.current = next;
    }, 200);
    return cancel;
  }, [accountIdsKey, accounts, activatedPluginKey, live, pluginItems]);

  useEffect(() => {
    if (!hasSidebarTreeSearch(searchQuery)) return;
    for (const key of accountKeys) ensureExpanded(key);
  }, [accountKeys, ensureExpanded, searchQuery]);

  useEffect(() => {
    if (!activeAccountId) return;
    ensureExpanded(makeCloudTreeKey({ kind: "account", accountId: activeAccountId }));
  }, [activeAccountId, ensureExpanded]);

  const ctxItems: ContextMenuItem[] = useMemo(() => {
    if (!ctxTarget) return [];
    const items: ContextMenuItem[] = [];
    if (ctxTarget.kind === "account") {
      items.push({
        id: "refresh",
        label: t("cloud.sidebar.refreshAccount"),
        icon: contextMenuIcons.refresh,
        onClick: () => handleRefreshAccount(ctxTarget.account, true),
      });
      const consoleUrl = cloudAccountConsoleUrl(ctxTarget.account.pluginId);
      if (consoleUrl) {
        items.push({
          id: "openConsole",
          label: t("cloud.actions.openConsole"),
          icon: contextMenuIcons.openExternal,
          onClick: () => {
            void openExternal(consoleUrl);
          },
        });
      }
      if (onEditAccount) {
        items.push({
          id: "edit",
          label: t("common.edit"),
          icon: contextMenuIcons.edit,
          onClick: () => onEditAccount(ctxTarget.account),
        });
      }
      if (onDeleteAccount) {
        items.push({
          id: "delete",
          label: t("common.delete"),
          icon: contextMenuIcons.delete,
          danger: true,
          onClick: () => onDeleteAccount(ctxTarget.account.id),
        });
      }
      return items;
    }
    if (ctxTarget.kind === "capability") {
      items.push({
        id: "refresh",
        label: t("cloud.tree.refresh"),
        icon: contextMenuIcons.refresh,
        onClick: () => {
          const cap = cloudCapabilitiesForPlugin(ctxTarget.account.pluginId).find(
            (item) => item.id === ctxTarget.capabilityId,
          );
          const regions = isGlobalCloudCapability(cap)
            ? []
            : resolveCloudQueryRegions(
                selectedRegions,
                liveRegionIds,
                ctxTarget.account.regions,
              );
          void useCloudInventoryStore
            .getState()
            .ensureList(ctxTarget.account.id, ctxTarget.capabilityId, regions, { force: true })
            .catch((err) => showToast(formatIpcError(err)));
        },
      });
      return items;
    }
    const { account, capabilityId, row } = ctxTarget;
    const cap = cloudCapabilitiesForPlugin(account.pluginId).find((item) => item.id === capabilityId);
    items.push({
      id: "openDetail",
      label: t("cloud.tree.openDetail"),
      icon: contextMenuIcons.open,
      onClick: () =>
        onNavigate(
          {
            kind: "resource",
            accountId: account.id,
            capability: capabilityId,
            resourceId: row.id,
            regionId: row.regionId,
          },
          "permanent",
        ),
    });
    items.push({
      id: "copyId",
      label: t("cloud.tree.copyId"),
      icon: contextMenuIcons.copy,
      onClick: () => {
        void copyCloudText(row.id).then((ok) => {
          if (ok) showToast(t("common.copied"));
        });
      },
    });
    const publicIp = cloudRowField(row.fields, "publicIp");
    if (publicIp) {
      items.push({
        id: "copyIp",
        label: t("cloud.tree.copyIp"),
        icon: contextMenuIcons.copy,
        onClick: () => {
          void copyCloudText(publicIp).then((ok) => {
            if (ok) showToast(t("common.copied"));
          });
        },
      });
    }
    if (capabilityHasDeclaredAction(cap?.actions, "addSsh")) {
      items.push({
        id: "addSsh",
        label: t("server.cloud.actions.addSsh"),
        icon: contextMenuIcons.connect,
        onClick: () => {
          void (async () => {
            try {
              await addCloudInstanceToSsh(
                account,
                capabilityId,
                {
                  id: row.id,
                  name: row.name,
                  publicIp,
                  privateIp: cloudRowField(row.fields, "privateIp"),
                },
                saveConn,
              );
              showToast(t("server.cloud.actions.addedSsh", { name: row.name || row.id }));
            } catch (err) {
              if (String(err).includes("NO_HOST")) showToast(t("server.cloud.actions.noHost"));
              else showToast(formatIpcError(err));
            }
          })();
        },
      });
    }
    return items;
  }, [
    ctxTarget,
    handleRefreshAccount,
    liveRegionIds,
    onDeleteAccount,
    onEditAccount,
    onNavigate,
    saveConn,
    selectedRegions,
    t,
  ]);

  const addAccountButton = onCreateAccount ? (
    <WorkbenchActionButton
      icon
      title={t("server.cloud.sidebar.addAccount")}
      aria-label={t("server.cloud.sidebar.addAccount")}
      onClick={onCreateAccount}
    >
      <IconPlus size={12} />
    </WorkbenchActionButton>
  ) : null;

  const treeBody = (
    <>
      <SidebarTreeSelectionProvider
        orderedKeys={orderedKeys}
        onSelectedIdsChange={handleSelectedIdsChange}
      >
        <SidebarTreeRoot>
          {visibleAccounts.length === 0 ? (
            <SidebarTreeEmpty>
              {hasSidebarTreeSearch(searchQuery)
                ? t("cloud.sidebar.noResults")
                : t("cloud.sidebar.empty")}
            </SidebarTreeEmpty>
          ) : (
            visibleAccounts.map((account) => {
              const accountKey = makeCloudTreeKey({ kind: "account", accountId: account.id });
              const expanded = isExpanded(accountKey);
              const pluginReady = isPluginActivated(account.pluginId);
              const accountCaps = cloudCapabilitiesForPlugin(account.pluginId);
              const inventory = inventoryByAccount[account.id];
              const accountRefreshing = Boolean(
                refreshingKeys[cloudAccountRefreshKey(account.id)],
              );
              const accountStatus = cloudAccountStatusDot(
                inventory,
                accountRefreshing,
                pluginReady,
              );
              const failedMessage = pluginReady ? cloudAccountStatusError(inventory) : null;
              const accountStatusTitle = !pluginReady
                ? t("cloud.sidebar.pluginMissing")
                : accountRefreshing
                  ? t("common.statusConnecting")
                  : failedMessage
                    ? `${t("common.statusOffline")}：${failedMessage}`
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
                    afterLabel={
                      <span className="sidebar-tag-chip badge badge-muted">
                        {pluginDisplayName(account.pluginId, t)}
                      </span>
                    }
                    icon={<ServerTreeIcon kind={cloudBrandKind(account.pluginId)} />}
                    prefix={<SidebarStatusDot status={accountStatus} title={accountStatusTitle} />}
                    className={serverTreeNodeClassName(cloudBrandKind(account.pluginId))}
                    hasChildren={accountCaps.length > 0}
                    expanded={expanded}
                    active={activeNavKey === accountKey || activeAccountId === account.id}
                    trailing={
                      activeAccountId === account.id &&
                      accountCaps.some((cap) => !isGlobalCloudCapability(cap)) ? (
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
                    onContextMenu={(event) => handleNodeContextMenu(event, { kind: "account", account })}
                    onRefresh={
                      pluginReady ? () => handleRefreshAccount(account, true) : undefined
                    }
                    refreshing={accountRefreshing}
                    refreshDisabled={connectionsLoading || refreshingAll}
                    refreshTitle={t("cloud.sidebar.refreshAccount")}
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
                    live={live}
                    activeNavKey={activeNavKey}
                    searchQuery={searchQuery}
                    selectedRegions={selectedRegions}
                    liveRegionIds={account.id === activeAccountId ? liveRegionIds : []}
                    ensureExpanded={ensureExpanded}
                    isExpanded={isExpanded}
                    toggle={toggle}
                    onNavigate={onNavigate}
                    onNodeContextMenu={handleNodeContextMenu}
                  />
                </div>
              );
            })
          )}
        </SidebarTreeRoot>
      </SidebarTreeSelectionProvider>
      {ctxPos && ctxItems.length > 0 ? (
        <ContextMenu items={ctxItems} position={ctxPos} onClose={() => setCtxPos(null)} />
      ) : null}
    </>
  );

  return (
    <ModuleSidebarSection
      title={section?.title ?? t("server.cloud.sidebar.title")}
      expanded={section?.expanded ?? true}
      onToggle={section?.onToggle ?? (() => {})}
      count={accounts.length}
      actions={addAccountButton}
      toolbar={
        <ModuleSidebarTreeToolbar
          onRefresh={handleRefreshAll}
          onExpandAll={() => setAllExpanded(expandableKeys, true)}
          onCollapseAll={() => setAllExpanded(expandableKeys, false)}
          refreshing={refreshingAll}
          refreshDisabled={connectionsLoading || refreshingAll || accounts.length === 0}
          expandDisabled={expandAllDisabled}
          collapseDisabled={collapseAllDisabled}
        />
      }
    >
      {treeBody}
    </ModuleSidebarSection>
  );
}
