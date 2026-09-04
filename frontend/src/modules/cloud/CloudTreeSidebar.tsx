import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/i18n";
import { ContextMenu, type ContextMenuItem } from "@/components/ui/ContextMenu";
import { Button } from "@/components/ui/Button";
import { IconPlus } from "@/components/ui/Icons";
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
  type TreeRowMouseEvent,
} from "@/components/ui/sidebar-tree";
import { hasSidebarTreeSearch, sidebarTreeSearchMatches } from "@/lib/sidebarTreeSearch";
import { usePersistedServerTreeExpanded } from "../server/panel/usePersistedServerTreeExpanded";
import { ServerTreeIcon, serverTreeNodeClassName } from "../server/panel/serverTreeIcons";
import { pluginDisplayName } from "../plugins/pluginDisplayName";
import { usePluginRuntimeStore } from "@/stores/pluginRuntimeStore";
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
import { cloudListSlotKey } from "./cloudInventory";
import { cloudListRefreshKey, useCloudInventoryStore } from "../../stores/cloudInventoryStore";
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
  onNodeContextMenu: CloudTreeContextHandler;
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

  useEffect(() => {
    if (!expanded) return;
    void useCloudInventoryStore
      .getState()
      .ensureList(account.id, capabilityId, queryRegions, { quiet: true })
      .catch(() => undefined);
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

  const label = cloudCapabilityLabel(t, capabilityId, account.pluginId);

  return (
    <>
      <SidebarTreeNode
        depth={1}
        module="cloud"
        nodeType="cloud-capability"
        treeKey={capKey}
        label={label}
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
  const [ctxTarget, setCtxTarget] = useState<CloudTreeCtxTarget | null>(null);
  const saveConn = useConnectionStore((s) => s.save);
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
    return accounts.filter((account) => sidebarTreeSearchMatches(searchQuery, account.name));
  }, [accounts, searchQuery]);

  const ctxItems: ContextMenuItem[] = useMemo(() => {
    if (!ctxTarget) return [];
    const items: ContextMenuItem[] = [];
    if (ctxTarget.kind === "account") {
      const consoleUrl = cloudAccountConsoleUrl(ctxTarget.account.pluginId);
      if (consoleUrl) {
        items.push({
          id: "openConsole",
          label: t("cloud.actions.openConsole"),
          onClick: () => {
            void openExternal(consoleUrl);
          },
        });
      }
      if (onEditAccount) {
        items.push({
          id: "edit",
          label: t("common.edit"),
          onClick: () => onEditAccount(ctxTarget.account),
        });
      }
      if (onDeleteAccount) {
        items.push({
          id: "delete",
          label: t("common.delete"),
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
  }, [ctxTarget, liveRegionIds, onDeleteAccount, onEditAccount, onNavigate, saveConn, selectedRegions, t]);

  return (
    <VerticalSplitSidebarSection
      title={section?.title ?? t("server.cloud.sidebar.title")}
      expanded={section?.expanded ?? true}
      onToggle={section?.onToggle ?? (() => {})}
      actions={
        onCreateAccount ? (
          <Button
            type="button"
            variant="icon"
            title={t("server.cloud.sidebar.addAccount")}
            aria-label={t("server.cloud.sidebar.addAccount")}
            onClick={onCreateAccount}
          >
            <IconPlus size={14} />
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
                  icon={<ServerTreeIcon kind={cloudBrandKind(account.pluginId)} />}
                  prefix={<StatusDot status={accountStatus} title={accountStatusTitle} />}
                  className={serverTreeNodeClassName(cloudBrandKind(account.pluginId))}
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
                  onContextMenu={(event) => handleNodeContextMenu(event, { kind: "account", account })}
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
                  onNodeContextMenu={handleNodeContextMenu}
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
