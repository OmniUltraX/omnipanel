import { useCallback, useEffect, useState } from "react";
import { Button } from "../../components/ui/primitives/Button";
import { CodeEditor } from "../../components/ui/content/CodeEditor";
import { FormDialog } from "../../components/ui/form/FormDialog";
import { TextInput } from "../../components/ui/form/TextInput";
import { getEnvLabel, useI18n } from "../../i18n";
import { connectionHostPort } from "./serviceConnections";
import type { Connection } from "../../ipc/bindings";
import { isKnownModuleCapability } from "../../lib/moduleCapabilities";
import { isProdEnvTag } from "../../lib/envTag";
import { DbTablesPanelGrid } from "../database/workspace/DbTablesPanelGrid";
import { invokeModuleMethod } from "./moduleInvoke";
import {
  isPublicNamespace,
  type ModuleNamespaceRow,
} from "./useModuleNamespaces";

type NavKind = "overview" | string;

export function ModuleCapabilityWorkbench({
  pluginId,
  connection,
  capabilityId,
  namespaceId,
  namespaces,
  capabilities,
  capabilityLabel,
  onOpenCapability,
  onNamespacesReload,
  unauthWarning,
}: {
  pluginId: string;
  connection: Connection;
  capabilityId: NavKind;
  namespaceId: string;
  namespaces: ModuleNamespaceRow[];
  capabilities: Array<{ id: string }>;
  capabilityLabel: (id: string) => string;
  onOpenCapability?: (capabilityId: string) => void;
  onNamespacesReload?: () => Promise<void>;
  unauthWarning?: boolean;
}) {
  if (capabilityId === "overview") {
    return (
      <OverviewPane
        pluginId={pluginId}
        connection={connection}
        namespaceId={namespaceId}
        namespaces={namespaces}
        capabilities={capabilities}
        capabilityLabel={capabilityLabel}
        onOpenCapability={onOpenCapability}
        unauthWarning={unauthWarning}
      />
    );
  }
  if (capabilityId === "config") {
    return <ConfigPane pluginId={pluginId} connection={connection} namespaceId={namespaceId} />;
  }
  if (capabilityId === "namespace") {
    return (
      <NamespacePane
        pluginId={pluginId}
        connection={connection}
        items={namespaces}
        onReload={onNamespacesReload}
      />
    );
  }
  if (capabilityId === "discovery") {
    return <DiscoveryPane pluginId={pluginId} connection={connection} namespaceId={namespaceId} />;
  }
  if (capabilityId === "cluster") {
    return <ClusterPane pluginId={pluginId} connection={connection} />;
  }
  return <UnknownPane capabilityId={capabilityId} known={isKnownModuleCapability(capabilityId)} />;
}

function isCancelled(err: unknown): boolean {
  return err instanceof Error && err.message === "cancelled";
}

function OverviewPane({
  pluginId,
  connection,
  namespaceId,
  namespaces,
  capabilities,
  capabilityLabel,
  onOpenCapability,
  unauthWarning,
}: {
  pluginId: string;
  connection: Connection;
  namespaceId: string;
  namespaces: ModuleNamespaceRow[];
  capabilities: Array<{ id: string }>;
  capabilityLabel: (id: string) => string;
  onOpenCapability?: (capabilityId: string) => void;
  unauthWarning?: boolean;
}) {
  const { t } = useI18n();
  const [info, setInfo] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    invokeModuleMethod<Record<string, unknown>>(pluginId, "getServerInfo", {}, { connection })
      .then((row) => {
        if (!cancelled) setInfo(row);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [pluginId, connection]);
  const env = connection.envTag;
  const envText =
    env === "prod" || env === "staging" || env === "dev" || env === "local" || env === "unknown"
      ? getEnvLabel(env)
      : env;
  return (
    <div className="cloud-overview">
      <header className="db-tables-panel-header db-connection-info-header">
        <span className="db-tables-panel-header-label">{connection.name}</span>
        <div className="db-tables-panel-header-tags">
          <span className="db-tables-panel-header-tag">{envText}</span>
          <span className="db-tables-panel-header-tag">{connectionHostPort(connection) || "—"}</span>
          <span className="db-tables-panel-header-tag">
            {namespaceId || t("moduleHost.namespacePublic")}
          </span>
        </div>
      </header>
      <div className="cloud-overview__body">
        {unauthWarning || (isProdEnvTag(connection.envTag) && info?.auth === "none") ? (
          <p className="cloud-overview__test cloud-overview__test--err">{t("moduleHost.unauthProd")}</p>
        ) : null}
        {error ? <p className="cloud-overview__test cloud-overview__test--err">{error}</p> : null}
        <section className="cloud-overview__section">
          <h3 className="cloud-overview__title">{t("moduleHost.overview")}</h3>
          <div className="cloud-overview__facts">
            <div className="cloud-overview__fact">
              <span className="cloud-overview__fact-label">{t("moduleHost.dialect")}</span>
              <span className="cloud-overview__fact-value">{String(info?.dialect ?? "—")}</span>
            </div>
            <div className="cloud-overview__fact">
              <span className="cloud-overview__fact-label">{t("moduleHost.auth")}</span>
              <span className="cloud-overview__fact-value">{String(info?.auth ?? "—")}</span>
            </div>
            <div className="cloud-overview__fact">
              <span className="cloud-overview__fact-label">{t("moduleHost.version")}</span>
              <span className="cloud-overview__fact-value">{String(info?.version ?? "—")}</span>
            </div>
            <div className="cloud-overview__fact">
              <span className="cloud-overview__fact-label">{t("moduleHost.nodes")}</span>
              <span className="cloud-overview__fact-value">
                {String(info?.healthyNodes ?? "—")} / {String(info?.nodeCount ?? "—")}
              </span>
            </div>
          </div>
        </section>
        {capabilities.length > 0 ? (
          <section className="cloud-overview__section">
            <h3 className="cloud-overview__title">{t("moduleHost.capabilities")}</h3>
            <div className="cloud-overview__grid">
              {capabilities.map((cap) => (
                <button
                  key={cap.id}
                  type="button"
                  className="cloud-overview__card"
                  onClick={() => onOpenCapability?.(cap.id)}
                >
                  <span className="cloud-overview__card-label">{capabilityLabel(cap.id)}</span>
                  <strong className="cloud-overview__card-value">
                    {cap.id === "namespace" ? String(namespaces.length) : "—"}
                  </strong>
                  <span className="cloud-overview__card-hint">{t("moduleHost.openCapability")}</span>
                </button>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

function ConfigPane({
  pluginId,
  connection,
  namespaceId,
}: {
  pluginId: string;
  connection: Connection;
  namespaceId: string;
}) {
  const { t } = useI18n();
  const [keyword, setKeyword] = useState("");
  const [items, setItems] = useState<Array<{ dataId: string; group: string; type?: string }>>([]);
  const [selected, setSelected] = useState<{ dataId: string; group: string } | null>(null);
  const [content, setContent] = useState("");
  const [history, setHistory] = useState<Array<{ nid: string; lastModified: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ dataId: "", group: "DEFAULT_GROUP", type: "text" });

  const nsArgs = useCallback(
    (extra: Record<string, unknown> = {}) => ({ ...extra, namespaceId }),
    [namespaceId],
  );

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const result = await invokeModuleMethod<{
        items?: Array<{ dataId: string; group: string; type?: string }>;
      }>(pluginId, "listConfigs", nsArgs({ keyword }), { connection });
      setItems(result.items ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [pluginId, connection, keyword, nsArgs]);

  useEffect(() => {
    void reload();
    setSelected(null);
    setContent("");
    setHistory([]);
  }, [reload]);

  const openConfig = async (row: { dataId: string; group: string }) => {
    setSelected(row);
    try {
      const result = await invokeModuleMethod<{ content?: string }>(
        pluginId,
        "getConfig",
        nsArgs({ dataId: row.dataId, group: row.group }),
        { connection },
      );
      setContent(result.content ?? "");
      const hist = await invokeModuleMethod<{ items?: Array<{ nid: string; lastModified: string }> }>(
        pluginId,
        "listConfigHistory",
        nsArgs({ dataId: row.dataId, group: row.group }),
        { connection },
      );
      setHistory(hist.items ?? []);
      setError(null);
    } catch (err) {
      if (!isCancelled(err)) setError(err instanceof Error ? err.message : String(err));
    }
  };

  const runWrite = async (method: string, args: Record<string, unknown>, title: string, message: string) => {
    try {
      await invokeModuleMethod(pluginId, method, nsArgs(args), { connection, title, message });
      await reload();
      if (selected && method !== "deleteConfig") await openConfig(selected);
      if (method === "deleteConfig") {
        setSelected(null);
        setContent("");
      }
    } catch (err) {
      if (!isCancelled(err)) setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="cloud-resource-list module-host-split">
      <div className="module-host-col">
        <header className="db-tables-panel-header db-connection-info-header">
          <span className="db-tables-panel-header-label">{t("moduleHost.capability.config")}</span>
          <div className="db-tables-panel-header-tags">
            <span className="db-tables-panel-header-tag">
              {loading ? "…" : t("moduleHost.listCount", { count: String(items.length) })}
            </span>
          </div>
          <div className="db-tables-panel-header-actions">
            <TextInput
              className="cloud-resource-list__search"
              value={keyword}
              onChange={setKeyword}
              placeholder={t("moduleHost.search")}
              clearable
              copyable={false}
              size="sm"
            />
            <Button type="button" size="sm" variant="ghost" onClick={() => void reload()}>
              {t("common.refresh")}
            </Button>
            <Button type="button" size="sm" variant="primary" onClick={() => setCreating(true)}>
              {t("moduleHost.newConfig")}
            </Button>
          </div>
        </header>
        {error ? <p className="form-hint cloud-resource-list__error">{error}</p> : null}
        {!loading && items.length === 0 ? (
          <div className="cloud-resource-list__empty">
            <p>{t("moduleHost.emptyList")}</p>
          </div>
        ) : (
          <div className="cloud-resource-list__body">
            <DbTablesPanelGrid
              columns={[
                { id: "dataId", header: t("moduleHost.dataId"), nameCell: true, render: (row) => row.dataId },
                { id: "group", header: t("moduleHost.group"), render: (row) => row.group },
                { id: "type", header: t("moduleHost.type"), render: (row) => row.type || "—" },
              ]}
              rows={items}
              rowKey={(row) => `${row.group}/${row.dataId}`}
              selectedRowKey={selected ? `${selected.group}/${selected.dataId}` : null}
              onRowClick={(row) => void openConfig(row)}
              virtualizeRows
            />
          </div>
        )}
      </div>
      <div className="module-host-editor">
        {selected ? (
          <>
            <header className="db-tables-panel-header db-connection-info-header">
              <span className="db-tables-panel-header-label">
                {selected.dataId}
              </span>
              <div className="db-tables-panel-header-tags">
                <span className="db-tables-panel-header-tag">{selected.group}</span>
              </div>
              <div className="db-tables-panel-header-actions">
              <Button
                type="button"
                size="sm"
                variant="primary"
                onClick={() =>
                  void runWrite(
                    "publishConfig",
                    { ...selected, content },
                    t("moduleHost.publish"),
                    t("moduleHost.publishConfirm"),
                  )
                }
              >
                {t("moduleHost.publish")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="danger"
                onClick={() =>
                  void runWrite(
                    "deleteConfig",
                    selected,
                    t("moduleHost.delete"),
                    t("moduleHost.deleteConfirm"),
                  )
                }
              >
                {t("moduleHost.delete")}
              </Button>
              </div>
            </header>
            <div className="module-host-editor-body">
            <CodeEditor value={content} onChange={setContent} language="yaml" height="100%" />
            {history.length > 0 ? (
              <div className="module-host-history-wrap">
                <h4 className="cloud-overview__title">{t("moduleHost.history")}</h4>
                <ul className="module-host-history">
                  {history.map((item) => (
                    <li key={item.nid}>
                      <span>{item.lastModified || item.nid}</span>
                      <Button
                        type="button"
                        size="sm"
                        onClick={() =>
                          void runWrite(
                            "rollbackConfig",
                            { ...selected, nid: item.nid },
                            t("moduleHost.rollback"),
                            t("moduleHost.rollbackConfirm"),
                          )
                        }
                      >
                        {t("moduleHost.rollback")}
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            </div>
          </>
        ) : (
          <div className="cloud-resource-list__empty">
            <p>{t("moduleHost.pickConfig")}</p>
          </div>
        )}
      </div>
      <FormDialog
        open={creating}
        onClose={() => setCreating(false)}
        title={t("moduleHost.newConfig")}
        primaryAction={{
          label: t("common.save"),
          onClick: () => {
            if (!draft.dataId.trim() || !draft.group.trim()) return;
            setCreating(false);
            setSelected({ dataId: draft.dataId.trim(), group: draft.group.trim() });
            setContent("");
            void runWrite(
              "publishConfig",
              { ...draft, content: "" },
              t("moduleHost.publish"),
              t("moduleHost.publishConfirm"),
            ).then(() => openConfig({ dataId: draft.dataId.trim(), group: draft.group.trim() }));
          },
        }}
      >
        <label className="module-host-field">
          <span>{t("moduleHost.dataId")}</span>
          <TextInput value={draft.dataId} onChange={(dataId) => setDraft((cur) => ({ ...cur, dataId }))} />
        </label>
        <label className="module-host-field">
          <span>{t("moduleHost.group")}</span>
          <TextInput value={draft.group} onChange={(group) => setDraft((cur) => ({ ...cur, group }))} />
        </label>
        <label className="module-host-field">
          <span>{t("moduleHost.type")}</span>
          <TextInput value={draft.type} onChange={(type) => setDraft((cur) => ({ ...cur, type }))} />
        </label>
      </FormDialog>
    </div>
  );
}

function NamespacePane({
  pluginId,
  connection,
  items,
  onReload,
}: {
  pluginId: string;
  connection: Connection;
  items: ModuleNamespaceRow[];
  onReload?: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<ModuleNamespaceRow | "new" | null>(null);
  const [draft, setDraft] = useState({ namespaceId: "", name: "", description: "" });

  const openCreate = () => {
    setDraft({ namespaceId: "", name: "", description: "" });
    setEditor("new");
  };
  const openEdit = (row: ModuleNamespaceRow) => {
    setDraft({
      namespaceId: row.namespaceId,
      name: row.name,
      description: row.description ?? "",
    });
    setEditor(row);
  };

  const persist = async () => {
    if (!draft.name.trim()) return;
    const creating = editor === "new";
    try {
      await invokeModuleMethod(
        pluginId,
        creating ? "createNamespace" : "updateNamespace",
        {
          namespaceId: draft.namespaceId.trim(),
          name: draft.name.trim(),
          description: draft.description.trim(),
        },
        {
          connection,
          title: creating ? t("moduleHost.newNamespace") : t("moduleHost.editNamespace"),
          message: creating ? t("moduleHost.createNamespaceConfirm") : t("moduleHost.updateNamespaceConfirm"),
        },
      );
      setEditor(null);
      setError(null);
      await onReload?.();
    } catch (err) {
      if (!isCancelled(err)) setError(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async (row: ModuleNamespaceRow) => {
    if (isPublicNamespace(row.namespaceId)) return;
    try {
      await invokeModuleMethod(
        pluginId,
        "deleteNamespace",
        { namespaceId: row.namespaceId },
        {
          connection,
          title: t("moduleHost.delete"),
          message: t("moduleHost.deleteNamespaceConfirm", { name: row.name || row.namespaceId }),
        },
      );
      setError(null);
      await onReload?.();
    } catch (err) {
      if (!isCancelled(err)) setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="cloud-resource-list">
      <header className="db-tables-panel-header db-connection-info-header">
        <span className="db-tables-panel-header-label">{t("moduleHost.capability.namespace")}</span>
        <div className="db-tables-panel-header-tags">
          <span className="db-tables-panel-header-tag">
            {t("moduleHost.listCount", { count: String(items.length) })}
          </span>
        </div>
        <div className="db-tables-panel-header-actions">
          <Button type="button" size="sm" variant="primary" onClick={openCreate}>
            {t("moduleHost.newNamespace")}
          </Button>
        </div>
      </header>
      {error ? <p className="form-hint cloud-resource-list__error">{error}</p> : null}
      {items.length === 0 ? (
        <div className="cloud-resource-list__empty">
          <p>{t("moduleHost.emptyList")}</p>
        </div>
      ) : (
      <div className="cloud-resource-list__body">
        <DbTablesPanelGrid
          columns={[
            {
              id: "name",
              header: t("moduleHost.field.name"),
              nameCell: true,
              render: (row) => row.name || t("moduleHost.namespacePublic"),
            },
            {
              id: "namespaceId",
              header: t("moduleHost.field.namespaceId"),
              render: (row) => row.namespaceId || "public",
            },
            {
              id: "configCount",
              header: t("moduleHost.configCount"),
              render: (row) => row.configCount ?? "—",
            },
            {
              id: "actions",
              header: t("moduleHost.actions"),
              variant: "actions",
              render: (row) => (
                <div className="module-host-row-actions">
                  <Button type="button" size="sm" onClick={() => openEdit(row)}>
                    {t("common.edit")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="danger"
                    disabled={isPublicNamespace(row.namespaceId)}
                    title={
                      isPublicNamespace(row.namespaceId)
                        ? t("moduleHost.cannotDeletePublic")
                        : undefined
                    }
                    onClick={() => void remove(row)}
                  >
                    {t("common.delete")}
                  </Button>
                </div>
              ),
            },
          ]}
          rows={items}
          rowKey={(row) => row.namespaceId || "public"}
          virtualizeRows
        />
      </div>
      )}
      <FormDialog
        open={editor !== null}
        onClose={() => setEditor(null)}
        title={editor === "new" ? t("moduleHost.newNamespace") : t("moduleHost.editNamespace")}
        primaryAction={{ label: t("common.save"), onClick: () => void persist() }}
      >
        <label className="module-host-field">
          <span>{t("moduleHost.field.name")}</span>
          <TextInput value={draft.name} onChange={(name) => setDraft((cur) => ({ ...cur, name }))} />
        </label>
        <label className="module-host-field">
          <span>{t("moduleHost.field.namespaceId")}</span>
          <TextInput
            value={draft.namespaceId}
            onChange={(namespaceId) => setDraft((cur) => ({ ...cur, namespaceId }))}
            disabled={editor !== "new"}
          />
        </label>
        <label className="module-host-field">
          <span>{t("moduleHost.namespaceDesc")}</span>
          <TextInput
            value={draft.description}
            onChange={(description) => setDraft((cur) => ({ ...cur, description }))}
          />
        </label>
      </FormDialog>
    </div>
  );
}

function DiscoveryPane({
  pluginId,
  connection,
  namespaceId,
}: {
  pluginId: string;
  connection: Connection;
  namespaceId: string;
}) {
  const { t } = useI18n();
  const [services, setServices] = useState<Array<{ serviceName: string }>>([]);
  const [instances, setInstances] = useState<
    Array<{ ip: string; port: number; healthy?: boolean; weight?: number; enabled?: boolean }>
  >([]);
  const [serviceName, setServiceName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const nsArgs = useCallback(
    (extra: Record<string, unknown> = {}) => ({ ...extra, namespaceId }),
    [namespaceId],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    invokeModuleMethod<{ items?: Array<{ serviceName: string }> }>(
      pluginId,
      "listServices",
      nsArgs(),
      { connection },
    )
      .then((row) => {
        if (cancelled) return;
        setServices(row.items ?? []);
        setServiceName("");
        setInstances([]);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setServices([]);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pluginId, connection, nsArgs]);

  const openService = async (name: string) => {
    setServiceName(name);
    try {
      const row = await invokeModuleMethod<{ items?: typeof instances }>(
        pluginId,
        "listInstances",
        nsArgs({ serviceName: name }),
        { connection },
      );
      setInstances(row.items ?? []);
      setError(null);
    } catch (err) {
      if (!isCancelled(err)) setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="cloud-resource-list module-host-split">
      <div className="module-host-col">
        <header className="db-tables-panel-header db-connection-info-header">
          <span className="db-tables-panel-header-label">{t("moduleHost.service")}</span>
          <div className="db-tables-panel-header-tags">
            <span className="db-tables-panel-header-tag">
              {loading ? "…" : t("moduleHost.listCount", { count: String(services.length) })}
            </span>
          </div>
          <div className="db-tables-panel-header-actions">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => void openService(serviceName)}
              disabled={!serviceName}
            >
              {t("common.refresh")}
            </Button>
          </div>
        </header>
        {error ? <p className="form-hint cloud-resource-list__error">{error}</p> : null}
        {!loading && services.length === 0 ? (
          <div className="cloud-resource-list__empty">
            <p>{t("moduleHost.emptyList")}</p>
          </div>
        ) : (
        <div className="cloud-resource-list__body">
          <DbTablesPanelGrid
            columns={[
              {
                id: "serviceName",
                header: t("moduleHost.service"),
                nameCell: true,
                render: (row) => row.serviceName,
              },
            ]}
            rows={services}
            rowKey={(row) => row.serviceName}
            selectedRowKey={serviceName || null}
            onRowClick={(row) => void openService(row.serviceName)}
            virtualizeRows
          />
        </div>
        )}
      </div>
      <div className="module-host-col">
        <header className="db-tables-panel-header db-connection-info-header">
          <span className="db-tables-panel-header-label">{t("moduleHost.instances")}</span>
          <div className="db-tables-panel-header-tags">
            {serviceName ? <span className="db-tables-panel-header-tag">{serviceName}</span> : null}
            <span className="db-tables-panel-header-tag">
              {t("moduleHost.listCount", { count: String(instances.length) })}
            </span>
          </div>
        </header>
        {!serviceName ? (
          <div className="cloud-resource-list__empty">
            <p>{t("moduleHost.emptyList")}</p>
          </div>
        ) : (
        <div className="cloud-resource-list__body">
          <DbTablesPanelGrid
            columns={[
              { id: "ip", header: "IP", nameCell: true, render: (row) => row.ip },
              { id: "port", header: t("moduleHost.port"), render: (row) => row.port },
              {
                id: "healthy",
                header: t("moduleHost.healthy"),
                render: (row) => (row.healthy ? t("moduleHost.healthyOk") : t("moduleHost.healthyDown")),
              },
              { id: "weight", header: t("moduleHost.weight"), render: (row) => row.weight ?? 1 },
              {
                id: "actions",
                header: t("moduleHost.actions"),
                variant: "actions",
                render: (row) => (
                  <Button
                    type="button"
                    size="sm"
                    onClick={() =>
                      void invokeModuleMethod(
                        pluginId,
                        "updateInstance",
                        nsArgs({
                          serviceName,
                          ip: row.ip,
                          port: row.port,
                          enabled: !row.enabled,
                          weight: row.weight ?? 1,
                        }),
                        {
                          connection,
                          title: t("moduleHost.updateInstance"),
                          message: t("moduleHost.updateInstanceConfirm"),
                        },
                      )
                        .then(() => openService(serviceName))
                        .catch((err: unknown) => {
                          if (!isCancelled(err)) {
                            setError(err instanceof Error ? err.message : String(err));
                          }
                        })
                    }
                  >
                    {row.enabled === false ? t("moduleHost.enable") : t("moduleHost.disable")}
                  </Button>
                ),
              },
            ]}
            rows={instances}
            rowKey={(row) => `${row.ip}:${row.port}`}
            virtualizeRows
          />
        </div>
        )}
      </div>
    </div>
  );
}

function ClusterPane({ pluginId, connection }: { pluginId: string; connection: Connection }) {
  const { t } = useI18n();
  const [items, setItems] = useState<Array<{ address: string; state?: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    invokeModuleMethod<{ items?: Array<{ address: string; state?: string }> }>(
      pluginId,
      "listNodes",
      {},
      { connection },
    )
      .then((row) => {
        setItems(row.items ?? []);
        setError(null);
      })
      .catch((err: unknown) => {
        setItems([]);
        setError(err instanceof Error ? err.message : String(err));
      });
  }, [pluginId, connection]);
  return (
    <div className="cloud-resource-list">
      <header className="db-tables-panel-header db-connection-info-header">
        <span className="db-tables-panel-header-label">{t("moduleHost.capability.cluster")}</span>
        <div className="db-tables-panel-header-tags">
          <span className="db-tables-panel-header-tag">
            {t("moduleHost.listCount", { count: String(items.length) })}
          </span>
        </div>
      </header>
      {error ? <p className="form-hint cloud-resource-list__error">{error}</p> : null}
      {items.length === 0 ? (
        <div className="cloud-resource-list__empty">
          <p>{error ? t("moduleHost.emptyList") : t("moduleHost.noNodes")}</p>
        </div>
      ) : (
        <div className="cloud-resource-list__body">
          <DbTablesPanelGrid
            columns={[
              { id: "address", header: t("moduleHost.address"), nameCell: true, render: (row) => row.address },
              { id: "state", header: t("moduleHost.state"), render: (row) => row.state || "—" },
            ]}
            rows={items}
            rowKey={(row) => row.address}
            virtualizeRows
          />
        </div>
      )}
    </div>
  );
}

function UnknownPane({ capabilityId, known }: { capabilityId: string; known: boolean }) {
  const { t } = useI18n();
  return (
    <div className="cloud-resource-list">
      <div className="cloud-resource-list__empty">
        <p>{known ? t("moduleHost.emptyCapability") : t("moduleHost.unknownCapability", { id: capabilityId })}</p>
      </div>
    </div>
  );
}
