import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ModuleActionDecl, ModuleCapabilityDecl } from "@omnipanel/plugin-sdk";
import { Button } from "../../components/ui/primitives/Button";
import { headerActionButtonClass } from "../../components/ui/primitives/headerActionButton";
import { CodeEditor } from "../../components/ui/content/CodeEditor";
import { FormDialog } from "../../components/ui/form/FormDialog";
import { TextInput } from "../../components/ui/form/TextInput";
import { useI18n } from "../../i18n";
import type { Connection } from "../../ipc/bindings";
import { DbTablesPanelGrid, type DbTablesPanelGridColumn } from "../database/workspace/DbTablesPanelGrid";
import { invokeModuleMethod } from "./moduleInvoke";
import { ModuleHistoryInspectDialog, type HistoryInspectMode } from "./ModuleHistoryInspectDialog";
import { editorLanguageFromType, formatHistoryTime, historyItemId } from "./moduleHostHistory";
import {
  actionLabel,
  actionMethod,
  actionTarget,
  capabilityChildItemKey,
  capabilityChildListMethod,
  capabilityGetMethod,
  capabilityHistoryGetMethod,
  capabilityItemKey,
  capabilityLabel,
  capabilityLanguage,
  capabilityListMethod,
  capabilityPane,
  capabilityValueKey,
  emptyFormDraft,
  extractContent,
  extractFacts,
  extractItems,
  extractMetrics,
  extractTree,
  filterTree,
  flattenTree,
  formatCell,
  isDangerAction,
  isProtectedRow,
  isSplitPane,
  mergeTreeChildren,
  rowField,
  rowItemKey,
  rowToFormDraft,
  type ModuleTreeNode,
} from "./moduleHostContract";

function isCancelled(err: unknown): boolean {
  return err instanceof Error && err.message === "cancelled";
}

export function GenericCapabilityPane({
  pluginId,
  connection,
  capability,
  namespaceId,
  onMutate,
}: {
  pluginId: string;
  connection: Connection;
  capability: ModuleCapabilityDecl;
  namespaceId: string;
  onMutate?: () => Promise<void> | void;
}) {
  const { t } = useI18n();
  const [items, setItems] = useState<Record<string, unknown>[]>([]);
  const [children, setChildren] = useState<Record<string, unknown>[]>([]);
  const [history, setHistory] = useState<Record<string, unknown>[]>([]);
  const [keyword, setKeyword] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [facts, setFacts] = useState<Array<{ key: string; value: string }>>([]);
  const [metrics, setMetrics] = useState<ReturnType<typeof extractMetrics>>([]);
  const [tree, setTree] = useState<ModuleTreeNode[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [formMode, setFormMode] = useState<"create" | "edit" | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [inspect, setInspect] = useState<{
    mode: HistoryInspectMode;
    item: Record<string, unknown>;
    preview: string;
  } | null>(null);

  const listMethod = capabilityListMethod(capability);
  const childListMethod = capabilityChildListMethod(capability);
  const getMethod = capabilityGetMethod(capability);
  const historyGetMethod = capabilityHistoryGetMethod(capability);
  const itemKey = capabilityItemKey(capability);
  const childItemKey = capabilityChildItemKey(capability);
  const detail = capabilityPane(capability);
  const language = capabilityLanguage(capability);
  const valueKey = capabilityValueKey(capability);
  const title = capabilityLabel(capability, t);
  const columns = capability.columns.length
    ? capability.columns
    : detail === "logs"
      ? [
          { key: "timestamp", label: t("moduleHost.timestamp") },
          { key: "level", label: t("moduleHost.level") },
          { key: "message", label: t("moduleHost.message") },
        ]
      : [{ key: itemKey, label: itemKey }];
  const childColumns = capability.childColumns?.length ? capability.childColumns : columns;
  const formFields = capability.formFields ?? [];
  const actions = capability.actions;
  const toolbarActions = actions.filter((action) => actionTarget(action, detail) === "toolbar");
  const rowActions = actions.filter((action) => actionTarget(action, detail) === "row");
  const editorActions = actions.filter((action) => actionTarget(action, detail) === "editor");
  const childActions = actions.filter((action) => actionTarget(action, detail) === "child");
  const historyActions = actions.filter((action) => actionTarget(action, detail) === "history");

  const visible = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    if (!q) return items;
    return items.filter((row) =>
      columns.some((col) => formatCell(t, col.key, row[col.key]).toLowerCase().includes(q)),
    );
  }, [columns, items, keyword, t]);
  const visibleTree = useMemo(() => filterTree(tree, keyword), [keyword, tree]);
  const searchActive = Boolean(keyword.trim());

  const selected = items.find((row) => rowItemKey(row, itemKey) === selectedKey) ?? null;
  const keywordRef = useRef(keyword);
  keywordRef.current = keyword;
  const editorLanguage = editorLanguageFromType(
    selected ? rowField(selected, "type") || rowField(selected, "dataId") : "",
    language,
  );

  const toggleNode = async (node: ModuleTreeNode) => {
    const next = new Set(expanded);
    if (next.has(node.id)) {
      next.delete(node.id);
      setExpanded(next);
      return;
    }
    next.add(node.id);
    setExpanded(next);
    if (!node.leaf && node.children.length === 0) {
      await load(node.id);
    }
  };

  const load = useCallback(
    async (parentId?: string) => {
      setLoading(true);
      try {
        const payload = await invokeModuleMethod(
          pluginId,
          parentId
            ? childListMethod
            : detail === "facts" && getMethod
              ? getMethod
              : listMethod,
          {
            capabilityId: capability.id,
            namespaceId,
            keyword: keywordRef.current,
            parentId: parentId ?? "",
          },
          { connection },
        );
        if (detail === "facts") {
          setFacts(extractFacts(payload));
        } else if (detail === "metrics") {
          setMetrics(extractMetrics(payload));
        } else if (detail === "tree") {
          const nodes = extractTree(payload, itemKey);
          if (parentId) {
            setTree((cur) => mergeTreeChildren(cur, parentId, nodes));
            setItems((cur) => {
              const incoming = flattenTree(nodes);
              const keep = cur.filter((row) => !incoming.some((next) => rowItemKey(next, itemKey) === rowItemKey(row, itemKey)));
              return [...keep, ...incoming];
            });
            setError(null);
            return;
          }
          setTree(nodes);
          setItems(flattenTree(nodes));
          setSelectedKey(null);
          setContent("");
          setHistory([]);
          setError(null);
          return;
        }
        const rows = extractItems(payload);
        if (parentId) setChildren(rows);
        else {
          setItems(rows);
          setChildren([]);
          setSelectedKey(null);
          setContent("");
          setHistory([]);
          setInspect(null);
        }
        setError(null);
      } catch (err) {
        if (!isCancelled(err)) setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [capability.id, childListMethod, connection, detail, getMethod, itemKey, listMethod, namespaceId, pluginId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const openRow = async (row: Record<string, unknown>) => {
    const key = rowItemKey(row, itemKey);
    setSelectedKey(key);
    if (detail === "children") {
      await load(key);
      return;
    }
    if (detail === "tree") {
      if (!getMethod) return;
      try {
        const payload = await invokeModuleMethod<Record<string, unknown>>(
          pluginId,
          getMethod,
          { ...row, capabilityId: capability.id, namespaceId },
          { connection },
        );
        setContent(extractContent(payload, valueKey));
        setError(null);
      } catch (err) {
        if (!isCancelled(err)) setError(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    if (detail === "form") {
      if (!getMethod) {
        setDraft(rowToFormDraft(row, formFields.length ? formFields : columns));
        return;
      }
      try {
        const payload = await invokeModuleMethod<Record<string, unknown>>(
          pluginId,
          getMethod,
          { ...row, capabilityId: capability.id, namespaceId },
          { connection },
        );
        setDraft(rowToFormDraft({ ...row, ...payload }, formFields.length ? formFields : columns));
        setError(null);
      } catch (err) {
        if (!isCancelled(err)) setError(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    if ((detail !== "editor" && detail !== "kv") || !getMethod) return;
    try {
      const payload = await invokeModuleMethod<Record<string, unknown>>(
        pluginId,
        getMethod,
        { ...row, capabilityId: capability.id, namespaceId },
        { connection },
      );
      setContent(extractContent(payload, valueKey));
      if (capability.historyMethod) {
        const hist = await invokeModuleMethod(pluginId, capability.historyMethod, {
          ...row,
          capabilityId: capability.id,
          namespaceId,
        }, { connection });
        setHistory(extractItems(hist));
      } else {
        setHistory([]);
      }
      setError(null);
    } catch (err) {
      if (!isCancelled(err)) setError(err instanceof Error ? err.message : String(err));
    }
  };

  const inspectHistory = async (item: Record<string, unknown>, mode: HistoryInspectMode) => {
    if (!selected || !historyGetMethod) {
      setError(t("moduleHost.historyUnavailable"));
      return;
    }
    try {
      const payload = await invokeModuleMethod<Record<string, unknown>>(
        pluginId,
        historyGetMethod,
        { ...selected, ...item, capabilityId: capability.id, namespaceId },
        { connection },
      );
      setInspect({ mode, item, preview: extractContent(payload, valueKey) });
      setError(null);
    } catch (err) {
      if (!isCancelled(err)) setError(err instanceof Error ? err.message : String(err));
    }
  };

  const runAction = async (
    action: ModuleActionDecl,
    row?: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) => {
    const method = actionMethod(action);
    const payload: Record<string, unknown> = {
      ...(row ?? {}),
      ...extra,
      capabilityId: capability.id,
      namespaceId,
      content,
      ...draft,
      parentId: selectedKey ?? "",
      [valueKey]: content,
    };
    if (action.toggle && row) {
      payload[action.toggle] = row[action.toggle] === false;
    }
    try {
      await invokeModuleMethod(pluginId, method, payload, {
        connection,
        title: actionLabel(action, t),
        message: t("moduleHost.genericActionConfirm", { action: actionLabel(action, t) }),
      });
      await load(detail === "children" ? selectedKey ?? undefined : undefined);
      if (
        (detail === "editor" || detail === "kv" || detail === "form" || detail === "tree") &&
        selected &&
        method.toLowerCase().includes("delete")
      ) {
        setSelectedKey(null);
        setContent("");
        setHistory([]);
      } else if ((detail === "editor" || detail === "kv" || detail === "form" || detail === "tree") && selected) {
        await openRow(selected);
      }
      await onMutate?.();
    } catch (err) {
      if (!isCancelled(err)) setError(err instanceof Error ? err.message : String(err));
    }
  };

  const openCreate = () => {
    setDraft(emptyFormDraft(formFields));
    setFormMode("create");
  };

  const openEdit = (row: Record<string, unknown>) => {
    setDraft(rowToFormDraft(row, formFields));
    setSelectedKey(rowItemKey(row, itemKey));
    setFormMode("edit");
  };

  const submitForm = async () => {
    const createAction = toolbarActions[0];
    const updateAction = rowActions.find((action) => action.id === "update" || action.id === "edit") ?? rowActions[0];
    const creating = formMode === "create";
    const action = creating ? createAction : updateAction;
    if (!action) return;
    setFormMode(null);
    const row = { ...(selected ?? {}), ...draft };
    await runAction(action, row, draft);
    if (creating && (detail === "editor" || detail === "kv" || detail === "form" || detail === "tree")) {
      await openRow(row);
    }
  };

  const parentGrid: DbTablesPanelGridColumn<Record<string, unknown>>[] = [
    ...columns.map((col, index) => ({
      id: col.key,
      header: col.label?.trim() || col.key,
      nameCell: index === 0,
      render: (row: Record<string, unknown>) => formatCell(t, col.key, row[col.key]),
    })),
    ...(rowActions.length
      ? [
          {
            id: "__actions",
            header: t("moduleHost.actions"),
            variant: "actions" as const,
            render: (row: Record<string, unknown>) => (
              <div className="module-host-row-actions">
                {rowActions.map((action) => {
                  const locked = isDangerAction(action) && isProtectedRow(row, itemKey);
                  const isEdit = action.id === "update" || action.id === "edit";
                  return (
                    <Button
                      key={action.id}
                      type="button"
                      size="sm"
                      variant="ghost"
                      className={headerActionButtonClass(isDangerAction(action))}
                      disabled={locked}
                      title={locked ? t("moduleHost.cannotDeletePublic") : undefined}
                      onClick={() => (isEdit && formFields.length ? openEdit(row) : void runAction(action, row))}
                    >
                      {actionLabel(action, t)}
                    </Button>
                  );
                })}
              </div>
            ),
          },
        ]
      : []),
  ];
  const childGrid: DbTablesPanelGridColumn<Record<string, unknown>>[] = childColumns.map((col, index) => ({
    id: col.key,
    header: col.label?.trim() || col.key,
    nameCell: index === 0,
    render: (row: Record<string, unknown>) => formatCell(t, col.key, row[col.key]),
  }));

  return (
    <div className={isSplitPane(detail) ? "cloud-resource-list module-host-split" : "cloud-resource-list"}>
      {detail !== "facts" && detail !== "metrics" && detail !== "tree" ? (
      <div className="module-host-col">
        <header className="db-tables-panel-header db-connection-info-header">
          <span className="db-tables-panel-header-label">{title}</span>
          <div className="db-tables-panel-header-tags">
            <span className="db-tables-panel-header-tag">
              {loading ? "…" : t("moduleHost.listCount", { count: String(visible.length) })}
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
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className={headerActionButtonClass()}
              onClick={() => void load()}
            >
              {t("common.refresh")}
            </Button>
            {formFields.length > 0 && toolbarActions.length > 0 ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className={headerActionButtonClass()}
                onClick={openCreate}
              >
                {actionLabel(toolbarActions[0], t)}
              </Button>
            ) : (
              toolbarActions.map((action) => (
                <Button
                  key={action.id}
                  type="button"
                  size="sm"
                  variant="ghost"
                  className={headerActionButtonClass(isDangerAction(action))}
                  onClick={() => void runAction(action)}
                >
                  {actionLabel(action, t)}
                </Button>
              ))
            )}
          </div>
        </header>
        {error ? <p className="form-hint cloud-resource-list__error">{error}</p> : null}
        {!loading && visible.length === 0 ? (
          <div className="cloud-resource-list__empty">
            <p>{t("moduleHost.emptyList")}</p>
          </div>
        ) : (
          <div className="cloud-resource-list__body">
            <DbTablesPanelGrid
              columns={parentGrid}
              rows={visible}
              rowKey={(row) => rowItemKey(row, itemKey)}
              selectedRowKey={selectedKey}
              onRowClick={(row) => void openRow(row)}
              virtualizeRows
            />
          </div>
        )}
      </div>
      ) : null}
      {detail === "facts" ? (
        <div className="cloud-overview__body">
          <header className="db-tables-panel-header db-connection-info-header">
            <span className="db-tables-panel-header-label">{title}</span>
            <div className="db-tables-panel-header-actions">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className={headerActionButtonClass()}
                onClick={() => void load()}
              >
                {t("common.refresh")}
              </Button>
            </div>
          </header>
          {error ? <p className="form-hint cloud-resource-list__error">{error}</p> : null}
          {facts.length === 0 ? (
            <div className="cloud-resource-list__empty">
              <p>{t("moduleHost.emptyList")}</p>
            </div>
          ) : (
            <div className="cloud-overview__facts">
              {facts.map((fact) => (
                <div key={fact.key} className="cloud-overview__fact">
                  <span className="cloud-overview__fact-label">{fact.key}</span>
                  <span className="cloud-overview__fact-value">{fact.value || "—"}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
      {detail === "metrics" ? (
        <div className="cloud-resource-list">
          <header className="db-tables-panel-header db-connection-info-header">
            <span className="db-tables-panel-header-label">{title}</span>
            <div className="db-tables-panel-header-tags">
              <span className="db-tables-panel-header-tag">
                {t("moduleHost.listCount", { count: String(metrics.length) })}
              </span>
            </div>
            <div className="db-tables-panel-header-actions">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className={headerActionButtonClass()}
                onClick={() => void load()}
              >
                {t("common.refresh")}
              </Button>
            </div>
          </header>
          {error ? <p className="form-hint cloud-resource-list__error">{error}</p> : null}
          {metrics.length === 0 ? (
            <div className="cloud-resource-list__empty">
              <p>{t("moduleHost.emptyList")}</p>
            </div>
          ) : (
            <div className="cloud-overview__grid">
              {metrics.map((series) => {
                const last = series.points[series.points.length - 1];
                return (
                  <div key={series.id} className="cloud-overview__card">
                    <span className="cloud-overview__card-label">{series.label}</span>
                    <strong className="cloud-overview__card-value">
                      {last ? `${last.value}${series.unit ? ` ${series.unit}` : ""}` : "—"}
                    </strong>
                    <span className="cloud-overview__card-hint">
                      {t("moduleHost.metricPoints", { count: String(series.points.length) })}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : null}
      {detail === "tree" ? (
        <div className="module-host-col">
          <header className="db-tables-panel-header db-connection-info-header">
            <span className="db-tables-panel-header-label">{title}</span>
            <div className="db-tables-panel-header-tags">
              <span className="db-tables-panel-header-tag">
                {loading ? "…" : t("moduleHost.listCount", { count: String(flattenTree(visibleTree).length) })}
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
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className={headerActionButtonClass()}
                onClick={() => void load()}
              >
                {t("common.refresh")}
              </Button>
              {formFields.length > 0 && toolbarActions.length > 0 ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className={headerActionButtonClass()}
                  onClick={openCreate}
                >
                  {actionLabel(toolbarActions[0], t)}
                </Button>
              ) : (
                toolbarActions.map((action) => (
                  <Button
                    key={action.id}
                    type="button"
                    size="sm"
                    variant="ghost"
                    className={headerActionButtonClass(isDangerAction(action))}
                    onClick={() => void runAction(action)}
                  >
                    {actionLabel(action, t)}
                  </Button>
                ))
              )}
            </div>
          </header>
          {error ? <p className="form-hint cloud-resource-list__error">{error}</p> : null}
          {!loading && visibleTree.length === 0 ? (
            <div className="cloud-resource-list__empty">
              <p>{t("moduleHost.emptyList")}</p>
            </div>
          ) : (
            <div className="module-host-tree">
              <ModuleHostTree
                nodes={visibleTree}
                depth={0}
                selectedKey={selectedKey}
                expanded={expanded}
                forceExpand={searchActive}
                onToggle={(node) => void toggleNode(node)}
                onSelect={(row) => void openRow(row)}
              />
            </div>
          )}
        </div>
      ) : null}
      {detail === "editor" || detail === "kv" || detail === "tree" ? (
        <div className="module-host-editor">
          {selected ? (
            <>
              <header className="db-tables-panel-header db-connection-info-header">
                <span className="db-tables-panel-header-label">
                  {rowField(selected, columns[0]?.key ?? itemKey) || rowItemKey(selected, itemKey)}
                </span>
                <div className="db-tables-panel-header-actions">
                  {editorActions.map((action) => (
                    <Button
                      key={action.id}
                      type="button"
                      size="sm"
                      variant="ghost"
                      className={headerActionButtonClass(isDangerAction(action))}
                      onClick={() => void runAction(action, selected)}
                    >
                      {actionLabel(action, t)}
                    </Button>
                  ))}
                </div>
              </header>
              <div className="module-host-editor-body">
                {detail === "tree" && !getMethod ? (
                  <div className="cloud-overview__facts" style={{ padding: 16, overflow: "auto" }}>
                    {Object.entries(selected)
                      .filter(([, value]) => value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean")
                      .map(([key, value]) => (
                        <div key={key} className="cloud-overview__fact">
                          <span className="cloud-overview__fact-label">{key}</span>
                          <span className="cloud-overview__fact-value">{value == null ? "—" : String(value)}</span>
                        </div>
                      ))}
                  </div>
                ) : (
                  <CodeEditor
                    className="module-host-code-editor"
                    value={content}
                    onChange={setContent}
                    language={editorLanguage}
                    height="100%"
                  />
                )}
                {capability.historyMethod ? (
                  <div className="module-host-history-wrap">
                    <div className="module-host-history-head">
                      <h4 className="cloud-overview__title">{t("moduleHost.history")}</h4>
                      <span className="db-tables-panel-header-tag">
                        {t("moduleHost.listCount", { count: String(history.length) })}
                      </span>
                    </div>
                    {history.length > 0 ? (
                      <ul className="module-host-history">
                        {history.map((item) => {
                          const id = historyItemId(item);
                          return (
                            <li key={id || JSON.stringify(item)}>
                              <button
                                type="button"
                                className="module-host-history-meta"
                                onClick={() => void inspectHistory(item, "preview")}
                              >
                                <span className="module-host-history-time">
                                  {formatHistoryTime(item.lastModified) || id || "—"}
                                </span>
                                {rowField(item, "srcUser") ? (
                                  <span className="module-host-history-user">{rowField(item, "srcUser")}</span>
                                ) : null}
                              </button>
                              <div className="module-host-row-actions">
                                {historyGetMethod ? (
                                  <>
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="ghost"
                                      className={headerActionButtonClass()}
                                      onClick={() => void inspectHistory(item, "preview")}
                                    >
                                      {t("moduleHost.preview")}
                                    </Button>
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="ghost"
                                      className={headerActionButtonClass()}
                                      onClick={() => void inspectHistory(item, "compare")}
                                    >
                                      {t("moduleHost.compare")}
                                    </Button>
                                  </>
                                ) : null}
                                {historyActions.map((action) => (
                                  <Button
                                    key={action.id}
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    className={headerActionButtonClass(isDangerAction(action))}
                                    onClick={() => void runAction(action, { ...selected, ...item })}
                                  >
                                    {actionLabel(action, t)}
                                  </Button>
                                ))}
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      <p className="module-host-history-empty">{t("moduleHost.historyEmpty")}</p>
                    )}
                  </div>
                ) : null}
              </div>
            </>
          ) : (
            <div className="cloud-resource-list__empty">
              <p>{detail === "tree" ? t("moduleHost.pickNode") : t("moduleHost.pickItem")}</p>
            </div>
          )}
        </div>
      ) : null}
      {detail === "form" ? (
        <div className="module-host-editor">
          {selected ? (
            <>
              <header className="db-tables-panel-header db-connection-info-header">
                <span className="db-tables-panel-header-label">
                  {rowField(selected, columns[0]?.key ?? itemKey) || rowItemKey(selected, itemKey)}
                </span>
                <div className="db-tables-panel-header-actions">
                  {(editorActions.length ? editorActions : rowActions.filter((action) => action.id === "update")).map(
                    (action) => (
                      <Button
                        key={action.id}
                        type="button"
                        size="sm"
                        variant="ghost"
                        className={headerActionButtonClass(isDangerAction(action))}
                        onClick={() => void runAction(action, { ...selected, ...draft })}
                      >
                        {actionLabel(action, t)}
                      </Button>
                    ),
                  )}
                </div>
              </header>
              <div className="module-host-editor-body" style={{ padding: 16, overflow: "auto" }}>
                {(formFields.length ? formFields : columns).map((field) => (
                  <label key={field.key} className="module-host-field">
                    <span>{field.label?.trim() || field.key}</span>
                    <TextInput
                      value={draft[field.key] ?? ""}
                      onChange={(value) => setDraft((cur) => ({ ...cur, [field.key]: value }))}
                    />
                  </label>
                ))}
              </div>
            </>
          ) : (
            <div className="cloud-resource-list__empty">
              <p>{t("moduleHost.pickItem")}</p>
            </div>
          )}
        </div>
      ) : null}
      {detail === "children" ? (
        <div className="module-host-col">
          <header className="db-tables-panel-header db-connection-info-header">
            <span className="db-tables-panel-header-label">{t("moduleHost.children")}</span>
            <div className="db-tables-panel-header-tags">
              {selectedKey ? <span className="db-tables-panel-header-tag">{selectedKey}</span> : null}
              <span className="db-tables-panel-header-tag">
                {t("moduleHost.listCount", { count: String(children.length) })}
              </span>
            </div>
          </header>
          {!selectedKey ? (
            <div className="cloud-resource-list__empty">
              <p>{t("moduleHost.emptyList")}</p>
            </div>
          ) : (
            <div className="cloud-resource-list__body">
              <DbTablesPanelGrid
                columns={[
                  ...childGrid,
                  ...(childActions.length
                    ? [
                        {
                          id: "__childActions",
                          header: t("moduleHost.actions"),
                          variant: "actions" as const,
                          render: (row: Record<string, unknown>) => (
                            <div className="module-host-row-actions">
                              {childActions.map((action) => (
                                <Button
                                  key={action.id}
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  className={headerActionButtonClass(isDangerAction(action))}
                                  onClick={() => void runAction(action, row)}
                                >
                                  {action.toggle
                                    ? row[action.toggle] === false
                                      ? t("moduleHost.enable")
                                      : t("moduleHost.disable")
                                    : actionLabel(action, t)}
                                </Button>
                              ))}
                            </div>
                          ),
                        },
                      ]
                    : []),
                ]}
                rows={children}
                rowKey={(row) => rowItemKey(row, childItemKey) || JSON.stringify(row)}
                virtualizeRows
              />
            </div>
          )}
        </div>
      ) : null}
      <FormDialog
        open={formMode !== null}
        onClose={() => setFormMode(null)}
        title={formMode === "edit" ? t("moduleHost.editItem") : t("moduleHost.newItem")}
        primaryAction={{ label: t("common.save"), onClick: () => void submitForm() }}
      >
        {formFields.map((field) => (
          <label key={field.key} className="module-host-field">
            <span>{field.label?.trim() || field.key}</span>
            <TextInput
              value={draft[field.key] ?? ""}
              onChange={(value) => setDraft((cur) => ({ ...cur, [field.key]: value }))}
              disabled={formMode === "edit" && field.key === itemKey.split(",")[0]}
            />
          </label>
        ))}
      </FormDialog>
      <ModuleHistoryInspectDialog
        open={inspect !== null}
        mode={inspect?.mode ?? "preview"}
        title={
          inspect?.mode === "compare" ? t("moduleHost.historyCompare") : t("moduleHost.historyPreview")
        }
        subtitle={
          selected
            ? `${rowField(selected, "dataId") || rowItemKey(selected, itemKey)} · ${
                formatHistoryTime(inspect?.item.lastModified) || historyItemId(inspect?.item ?? {})
              }`
            : undefined
        }
        language={editorLanguage}
        preview={inspect?.preview ?? ""}
        leftLabel={t("moduleHost.historyVersion")}
        rightLabel={t("moduleHost.historyCurrent")}
        left={inspect?.preview ?? ""}
        right={content}
        onClose={() => setInspect(null)}
      />
    </div>
  );
}

function ModuleHostTree({
  nodes,
  depth,
  selectedKey,
  expanded,
  forceExpand,
  onToggle,
  onSelect,
}: {
  nodes: ModuleTreeNode[];
  depth: number;
  selectedKey: string | null;
  expanded: Set<string>;
  forceExpand: boolean;
  onToggle: (node: ModuleTreeNode) => void;
  onSelect: (row: Record<string, unknown>) => void;
}) {
  return (
    <>
      {nodes.map((node) => {
        const open = forceExpand || expanded.has(node.id);
        return (
          <div key={node.id}>
            <button
              type="button"
              className={`module-host-tree-row${selectedKey === node.id ? " is-selected" : ""}`}
              style={{ paddingLeft: 8 + depth * 16 }}
              onClick={() => onSelect(node.raw)}
            >
              {node.leaf ? (
                <span className="module-host-tree-toggle" />
              ) : (
                <span
                  className="module-host-tree-toggle"
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggle(node);
                  }}
                >
                  {open ? "▾" : "▸"}
                </span>
              )}
              <span className="module-host-tree-label">{node.label}</span>
            </button>
            {open && node.children.length > 0 ? (
              <ModuleHostTree
                nodes={node.children}
                depth={depth + 1}
                selectedKey={selectedKey}
                expanded={expanded}
                forceExpand={forceExpand}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            ) : null}
          </div>
        );
      })}
    </>
  );
}
