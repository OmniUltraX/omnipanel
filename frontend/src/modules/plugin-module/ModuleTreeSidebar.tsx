import { useMemo, useState } from "react";
import { Button } from "../../components/ui/Button";
import { IconPlus } from "../../components/ui/Icons";
import { Select, type SelectOption } from "../../components/ui/form/Select";
import { ScopedSearch } from "../../components/ui/search";
import {
  VerticalSplitSidebar,
  VerticalSplitSidebarSection,
  usePersistedVerticalSplitSections,
} from "../../components/ui/sidebar/VerticalSplitSidebar";
import {
  SidebarTreeEmpty,
  SidebarTreeNode,
  SidebarTreeRoot,
} from "../../components/ui/sidebar-tree";
import { useI18n } from "../../i18n";
import type { Connection } from "../../ipc/bindings";
import { hasSidebarTreeSearch, sidebarTreeSearchMatches } from "../../lib/sidebarTreeSearch";
import { ServerTreeIcon, serverTreeNodeClassName, type ServerTreeIconKind } from "../server/panel/serverTreeIcons";
import { connectionHostPort } from "./serviceConnections";
import {
  makeModuleTreeKey,
  type ModuleDockOpenMode,
  type ModuleSidebarNavTarget,
} from "./moduleWorkspaceTabs";

type SectionKey = "connections";

function capabilityIcon(id: string): ServerTreeIconKind {
  if (id === "namespace") return "databases";
  if (id === "config") return "certificates";
  if (id === "discovery") return "apps";
  if (id === "cluster") return "server";
  return "apps";
}

export function ModuleTreeSidebar({
  moduleKey,
  services,
  capabilities,
  capabilityLabel,
  activeNavKey,
  activeConnectionId,
  hasNamespaceFilter,
  namespaceValue,
  namespaceOptions,
  onNamespaceChange,
  scanBusy,
  onNavigate,
  onCreate,
  onScan,
  onEdit,
  onDelete,
}: {
  moduleKey: string;
  services: Connection[];
  capabilities: Array<{ id: string }>;
  capabilityLabel: (id: string) => string;
  activeNavKey: string | null;
  activeConnectionId: string | null;
  hasNamespaceFilter: boolean;
  namespaceValue: string;
  namespaceOptions: SelectOption[];
  onNamespaceChange: (value: string) => void;
  scanBusy?: boolean;
  onNavigate: (target: ModuleSidebarNavTarget, mode?: ModuleDockOpenMode) => void;
  onCreate: () => void;
  onScan: () => void;
  onEdit: (connection: Connection) => void;
  onDelete: (connection: Connection) => void;
}) {
  const { t } = useI18n();
  const [searchQuery, setSearchQuery] = useState("");
  const { sections, toggleSection } = usePersistedVerticalSplitSections<SectionKey>(
    `omnipanel-module-sidebar-${moduleKey}`,
    { connections: true },
  );
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const isExpanded = (key: string) => expanded.has(key);
  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const ensureExpanded = (key: string) => {
    setExpanded((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
  };

  const visible = useMemo(() => {
    if (!hasSidebarTreeSearch(searchQuery)) return services;
    return services.filter(
      (conn) =>
        sidebarTreeSearchMatches(searchQuery, conn.name, connectionHostPort(conn)) ||
        capabilities.some((cap) => sidebarTreeSearchMatches(searchQuery, capabilityLabel(cap.id))),
    );
  }, [capabilities, capabilityLabel, searchQuery, services]);

  return (
    <VerticalSplitSidebar className="module-host-sidebar">
      <ScopedSearch
        className="server-tree-scoped-search"
        value={searchQuery}
        onChange={setSearchQuery}
        placeholder={t("moduleHost.sidebarSearch")}
      >
        <VerticalSplitSidebarSection
          title={t("moduleHost.connections")}
          expanded={sections.connections}
          onToggle={() => toggleSection("connections")}
          actions={
            <>
              <Button
                type="button"
                variant="icon"
                title={t("moduleHost.scan")}
                aria-label={t("moduleHost.scan")}
                disabled={scanBusy}
                onClick={onScan}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
                  <circle cx="7" cy="7" r="4.2" />
                  <path d="M10.2 10.2L14 14" />
                </svg>
              </Button>
              <Button
                type="button"
                variant="icon"
                title={t("moduleHost.newConnection")}
                aria-label={t("moduleHost.newConnection")}
                onClick={onCreate}
              >
                <IconPlus size={14} />
              </Button>
            </>
          }
        >
          <SidebarTreeRoot>
            {visible.length === 0 ? (
              <SidebarTreeEmpty>{t("moduleHost.emptyHint")}</SidebarTreeEmpty>
            ) : (
              visible.map((conn) => {
                const overviewKey = makeModuleTreeKey({
                  connectionId: conn.id,
                  capabilityId: "overview",
                });
                const open = isExpanded(overviewKey);
                const active = activeConnectionId === conn.id;
                return (
                  <div key={conn.id}>
                    <SidebarTreeNode
                      depth={0}
                      module="module"
                      nodeType="module-connection"
                      treeKey={overviewKey}
                      label={conn.name}
                      icon={<ServerTreeIcon kind="server" />}
                      className={serverTreeNodeClassName("server")}
                      hasChildren={capabilities.length > 0}
                      expanded={open}
                      active={activeNavKey === overviewKey || active}
                      trailing={
                        hasNamespaceFilter && active ? (
                          <div
                            className="cloud-tree-region-filter"
                            onClick={(event) => event.stopPropagation()}
                            onPointerDown={(event) => event.stopPropagation()}
                            onDoubleClick={(event) => event.stopPropagation()}
                          >
                            <Select
                              size="sm"
                              searchable
                              value={namespaceValue}
                              options={namespaceOptions}
                              onChange={onNamespaceChange}
                              aria-label={t("moduleHost.namespaceSwitcher")}
                              panelMinWidth={220}
                            />
                          </div>
                        ) : null
                      }
                      onToggle={() => toggle(overviewKey)}
                      onSelect={() => {
                        ensureExpanded(overviewKey);
                        onNavigate({ connectionId: conn.id, capabilityId: "overview" }, "preview");
                      }}
                      onActivate={() => {
                        ensureExpanded(overviewKey);
                        onNavigate({ connectionId: conn.id, capabilityId: "overview" }, "permanent");
                      }}
                      onRename={() => onEdit(conn)}
                      renameLabel={t("moduleHost.editConnection")}
                      onDelete={() => onDelete(conn)}
                      deleteLabel={t("common.delete")}
                    />
                    {open ? (
                      <div className="server-tree-children">
                        {capabilities.map((cap) => {
                          const capKey = makeModuleTreeKey({
                            connectionId: conn.id,
                            capabilityId: cap.id,
                          });
                          const icon = capabilityIcon(cap.id);
                          return (
                            <SidebarTreeNode
                              key={cap.id}
                              depth={1}
                              module="module"
                              nodeType="module-capability"
                              treeKey={capKey}
                              label={capabilityLabel(cap.id)}
                              icon={<ServerTreeIcon kind={icon} />}
                              className={serverTreeNodeClassName(icon)}
                              hasChildren={false}
                              expanded={false}
                              active={activeNavKey === capKey}
                              onToggle={() => undefined}
                              onSelect={() => {
                                ensureExpanded(overviewKey);
                                onNavigate(
                                  { connectionId: conn.id, capabilityId: cap.id },
                                  "preview",
                                );
                              }}
                              onActivate={() => {
                                ensureExpanded(overviewKey);
                                onNavigate(
                                  { connectionId: conn.id, capabilityId: cap.id },
                                  "permanent",
                                );
                              }}
                            />
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </SidebarTreeRoot>
        </VerticalSplitSidebarSection>
      </ScopedSearch>
    </VerticalSplitSidebar>
  );
}
