import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../../i18n";
import { Button } from "../../../components/ui/primitives/Button";
import { Select } from "../../../components/ui/form/Select";
import { DockHandle, DockLayout, DockPanel } from "../../../components/dock";
import { isConnectionEnabled, type DbConnectionConfig } from "../api";
import { useDbSchemaContext } from "../schema/DbSchemaContext";
import { useDbTreeChartFileStore } from "../../../stores/dbTreeChartFileStore";
import { WarnAlert } from "../../../components/ui/overlay/WarnAlert";
import type { TreeChartFieldSelection, TreeChartListPanel, TreeChartPanelStats } from "./treeChartTypes";
import {
  fetchTreeChartDownstreamCountMap,
  fetchTreeChartFilteredRows,
  fetchTreeChartRows,
  formatTreeChartPanelTitle,
} from "./treeChartQuery";
import { useTreeChartDatabaseSchema } from "./useTreeChartDatabaseSchema";
import { TreeChartFieldSelectDialog } from "./TreeChartFieldSelectDialog";
import { TreeChartListView } from "./TreeChartListView";
import {
  buildTreeChartDocument,
  parseTreeChartDocument,
  serializeTreeChartDocument,
} from "./treeChartDocument";
import { restoreTreeChartPanels } from "./treeChartSession";

interface TreeChartPanelProps {
  connections: DbConnectionConfig[];
  fileId: string;
}

type FieldDialogMode = "first" | "next" | "edit";

function createPanelId(): string {
  return `tree-chart-panel-${Date.now()}`;
}

function createEmptyPanel(selection: TreeChartFieldSelection): TreeChartListPanel {
  return {
    id: createPanelId(),
    selection,
    rows: [],
    loading: true,
    error: null,
  };
}

function panelsFromDocument(
  panels: Array<{ id: string; selection: TreeChartFieldSelection }>,
): TreeChartListPanel[] {
  return panels.map((panel, index) => ({
    id: panel.id,
    selection: panel.selection,
    rows: [],
    loading: index === 0,
    error: null,
  }));
}

function clearDownstreamPanels(
  panels: TreeChartListPanel[],
  fromIndex: number,
): TreeChartListPanel[] {
  return panels.map((panel, index) => {
    if (index <= fromIndex) {
      return panel;
    }
    return { ...panel, rows: [], loading: false, error: null };
  });
}

export function TreeChartPanel({ connections, fileId }: TreeChartPanelProps) {
  const { t } = useI18n();
  const { databasesByConnId } = useDbSchemaContext();
  const fileDocument = useDbTreeChartFileStore((state) => {
    const node = state.nodes.find((entry) => entry.id === fileId);
    return node?.document ?? null;
  });
  const updateFileDocument = useDbTreeChartFileStore((state) => state.updateFileDocument);
  const flushToDisk = useDbTreeChartFileStore((state) => state.flushToDisk);

  const [connId, setConnId] = useState("");
  const [database, setDatabase] = useState("");
  const [panels, setPanels] = useState<TreeChartListPanel[]>([]);
  const [selectedRowByPanelId, setSelectedRowByPanelId] = useState<Record<string, number>>({});
  const [panelStatsById, setPanelStatsById] = useState<Record<string, TreeChartPanelStats>>({});
  const [statsEnabledByPanelId, setStatsEnabledByPanelId] = useState<Record<string, boolean>>({});
  const [showIdByPanelId, setShowIdByPanelId] = useState<Record<string, boolean>>({});
  const [deleteTargetPanelId, setDeleteTargetPanelId] = useState<string | null>(null);
  const [fieldDialogOpen, setFieldDialogOpen] = useState(false);
  const [fieldDialogMode, setFieldDialogMode] = useState<FieldDialogMode>("first");
  const [editingPanelId, setEditingPanelId] = useState<string | null>(null);
  const [hydratedFileId, setHydratedFileId] = useState<string | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const skipSaveRef = useRef(true);
  const sessionRestoreRef = useRef(false);
  const persistStateRef = useRef({
    connId: "",
    database: "",
    panels: [] as TreeChartListPanel[],
    selectedRowByPanelId: {} as Record<string, number>,
  });

  persistStateRef.current = {
    connId,
    database,
    panels,
    selectedRowByPanelId,
  };

  const resetSelection = useCallback(() => {
    setSelectedRowByPanelId({});
    setPanelStatsById({});
    setStatsEnabledByPanelId({});
    setShowIdByPanelId({});
  }, []);

  const clearPanelStats = useCallback((panelId: string) => {
    setPanelStatsById((prev) => {
      if (!(panelId in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[panelId];
      return next;
    });
  }, []);

  const sqlConnections = useMemo(
    () => connections.filter((conn) => isConnectionEnabled(conn)),
    [connections],
  );

  const connection = useMemo(
    () => sqlConnections.find((conn) => conn.id === connId) ?? null,
    [sqlConnections, connId],
  );

  const databaseOptions = useMemo(() => {
    if (!connId) {
      return [{ value: "", label: t("database.workspace.noDatabase"), disabled: true }];
    }
    const names = databasesByConnId[connId] ?? [];
    if (names.length === 0) {
      return [{ value: "", label: t("database.workspace.noDatabase"), disabled: true }];
    }
    return names.map((name) => ({ value: name, label: name }));
  }, [connId, databasesByConnId, t]);

  const schema = useTreeChartDatabaseSchema(connection, database);
  const tables = schema?.tables ?? [];
  const headerReady = Boolean(connection && database.trim());

  const fieldDialogInitial = useMemo(() => {
    if (fieldDialogMode === "edit" && editingPanelId) {
      return panels.find((panel) => panel.id === editingPanelId)?.selection ?? null;
    }
    return null;
  }, [fieldDialogMode, editingPanelId, panels]);

  const fieldDialogIsFirstPanel = useMemo(() => {
    if (fieldDialogMode === "first") {
      return true;
    }
    if (fieldDialogMode === "next") {
      return false;
    }
    if (fieldDialogMode === "edit" && editingPanelId) {
      const index = panels.findIndex((panel) => panel.id === editingPanelId);
      return index <= 0;
    }
    return true;
  }, [fieldDialogMode, editingPanelId, panels]);

  useEffect(() => {
    if (hydratedFileId === fileId) {
      return;
    }
    const parsed = parseTreeChartDocument(fileDocument);
    skipSaveRef.current = true;
    sessionRestoreRef.current = false;
    setConnId(parsed.connId);
    setDatabase(parsed.database);
    setPanels(panelsFromDocument(parsed.panels));
    setSelectedRowByPanelId(parsed.selectedRowByPanelId ?? {});
    setPanelStatsById({});
    setStatsEnabledByPanelId({});
    setShowIdByPanelId({});
    setFieldDialogOpen(false);
    setEditingPanelId(null);
    setHydratedFileId(fileId);
  }, [fileDocument, fileId, hydratedFileId]);

  useEffect(() => {
    if (hydratedFileId !== fileId || skipSaveRef.current) {
      skipSaveRef.current = false;
      return;
    }
    if (saveTimerRef.current != null) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      const document = serializeTreeChartDocument(
        buildTreeChartDocument(
          connId,
          database,
          panels.map((panel) => ({ id: panel.id, selection: panel.selection })),
          selectedRowByPanelId,
        ),
      );
      updateFileDocument(fileId, document);
      void flushToDisk();
    }, 300);
    return () => {
      if (saveTimerRef.current != null) {
        window.clearTimeout(saveTimerRef.current);
      }
    };
  }, [
    connId,
    database,
    panels,
    selectedRowByPanelId,
    fileId,
    hydratedFileId,
    updateFileDocument,
    flushToDisk,
  ]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current != null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      if (hydratedFileId !== fileId) {
        return;
      }
      const snapshot = persistStateRef.current;
      const document = serializeTreeChartDocument(
        buildTreeChartDocument(
          snapshot.connId,
          snapshot.database,
          snapshot.panels.map((panel) => ({ id: panel.id, selection: panel.selection })),
          snapshot.selectedRowByPanelId,
        ),
      );
      updateFileDocument(fileId, document);
      void flushToDisk();
    };
  }, [fileId, hydratedFileId, updateFileDocument, flushToDisk]);

  const loadPanelRows = useCallback(
    async (panelId: string, selection: TreeChartFieldSelection) => {
      if (!connection || !database.trim()) {
        return;
      }
      setPanels((prev) =>
        prev.map((panel) =>
          panel.id === panelId ? { ...panel, loading: true, error: null } : panel,
        ),
      );
      try {
        const rows = await fetchTreeChartRows(connection, database, selection);
        setPanels((prev) =>
          prev.map((panel) =>
            panel.id === panelId ? { ...panel, rows, loading: false, error: null } : panel,
          ),
        );
        clearPanelStats(panelId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setPanels((prev) =>
          prev.map((panel) =>
            panel.id === panelId ? { ...panel, rows: [], loading: false, error: message } : panel,
          ),
        );
        clearPanelStats(panelId);
      }
    },
    [connection, database, clearPanelStats],
  );

  const loadFilteredPanelRows = useCallback(
    async (
      panelId: string,
      selection: TreeChartFieldSelection,
      parentDownstreamValue: string,
    ) => {
      if (!connection || !database.trim()) {
        return;
      }
      setPanels((prev) =>
        prev.map((panel) =>
          panel.id === panelId ? { ...panel, loading: true, error: null } : panel,
        ),
      );
      try {
        const rows = await fetchTreeChartFilteredRows(
          connection,
          database,
          selection,
          parentDownstreamValue,
        );
        setPanels((prev) =>
          prev.map((panel) =>
            panel.id === panelId ? { ...panel, rows, loading: false, error: null } : panel,
          ),
        );
        clearPanelStats(panelId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setPanels((prev) =>
          prev.map((panel) =>
            panel.id === panelId ? { ...panel, rows: [], loading: false, error: message } : panel,
          ),
        );
        clearPanelStats(panelId);
      }
    },
    [connection, database, clearPanelStats],
  );

  const isPanelAwaitingParent = useCallback(
    (panelIndex: number) => {
      if (panelIndex <= 0) {
        return false;
      }
      const parentPanel = panels[panelIndex - 1];
      if (!parentPanel) {
        return true;
      }
      return selectedRowByPanelId[parentPanel.id] == null;
    },
    [panels, selectedRowByPanelId],
  );

  const runPanelStats = useCallback(
    async (panelIndex: number) => {
      const panel = panels[panelIndex];
      const nextPanel = panels[panelIndex + 1];
      if (!panel || !nextPanel || !connection || !database.trim() || panel.rows.length === 0) {
        return;
      }

      setPanelStatsById((prev) => ({
        ...prev,
        [panel.id]: {
          loading: true,
          countsByRowIndex: prev[panel.id]?.countsByRowIndex ?? {},
        },
      }));

      try {
        const countMap = await fetchTreeChartDownstreamCountMap(
          connection,
          database,
          nextPanel.selection,
        );
        const countsByRowIndex: Record<number, number> = {};
        panel.rows.forEach((row, rowIndex) => {
          countsByRowIndex[rowIndex] = countMap.get(row.downstreamRelation) ?? 0;
        });
        setPanelStatsById((prev) => ({
          ...prev,
          [panel.id]: { loading: false, countsByRowIndex },
        }));
      } catch {
        setPanelStatsById((prev) => ({
          ...prev,
          [panel.id]: { loading: false, countsByRowIndex: {} },
        }));
      }
    },
    [connection, database, panels],
  );

  const canAutoStatsPanel = useCallback(
    (panelIndex: number) => {
      const panel = panels[panelIndex];
      if (!panel || !headerReady || !connection || !database.trim()) {
        return false;
      }
      if (panelIndex >= panels.length - 1) {
        return false;
      }
      if (panel.loading || panel.error || panel.rows.length === 0) {
        return false;
      }
      return !isPanelAwaitingParent(panelIndex);
    },
    [connection, database, headerReady, panels, isPanelAwaitingParent],
  );

  const togglePanelStats = useCallback(
    (panelIndex: number) => {
      const panel = panels[panelIndex];
      if (!panel) {
        return;
      }
      setStatsEnabledByPanelId((prev) => {
        const enabled = !prev[panel.id];
        if (!enabled) {
          clearPanelStats(panel.id);
          const next = { ...prev };
          delete next[panel.id];
          return next;
        }
        return { ...prev, [panel.id]: true };
      });
    },
    [panels, clearPanelStats],
  );

  const isPanelShowId = useCallback(
    (panelId: string) => showIdByPanelId[panelId] !== false,
    [showIdByPanelId],
  );

  const togglePanelShowId = useCallback((panelId: string) => {
    setShowIdByPanelId((prev) => {
      const visible = prev[panelId] !== false;
      if (visible) {
        return { ...prev, [panelId]: false };
      }
      const next = { ...prev, [panelId]: true };
      return next;
    });
  }, []);

  useEffect(() => {
    if (!connection || !database.trim()) {
      return;
    }
    panels.forEach((panel, index) => {
      if (!statsEnabledByPanelId[panel.id] || !canAutoStatsPanel(index)) {
        return;
      }
      void runPanelStats(index);
    });
  }, [
    panels,
    statsEnabledByPanelId,
    connection,
    database,
    canAutoStatsPanel,
    runPanelStats,
  ]);

  useEffect(() => {
    if (hydratedFileId !== fileId || !headerReady || !connection || !database.trim()) {
      return;
    }
    if (sessionRestoreRef.current) {
      return;
    }
    if (panels.length === 0) {
      sessionRestoreRef.current = true;
      return;
    }

    sessionRestoreRef.current = true;
    const panelDefs = panels.map((panel) => ({
      id: panel.id,
      selection: panel.selection,
    }));
    const savedSelection = selectedRowByPanelId;

    setPanels((prev) =>
      prev.map((panel) => ({ ...panel, loading: true, error: null })),
    );

    void restoreTreeChartPanels(panelDefs, savedSelection, connection, database).then(
      (restored) => {
        setPanels(restored);
      },
    );
  }, [
    hydratedFileId,
    fileId,
    headerReady,
    connection,
    database,
    panels.length,
  ]);

  const handleRowClick = useCallback(
    (panelIndex: number, rowIndex: number) => {
      const panel = panels[panelIndex];
      const row = panel?.rows[rowIndex];
      if (!panel || !row) {
        return;
      }

      setSelectedRowByPanelId((prev) => {
        const next: Record<string, number> = {};
        for (let i = 0; i <= panelIndex; i += 1) {
          const entry = panels[i];
          const selected = i === panelIndex ? rowIndex : prev[entry.id];
          if (selected != null) {
            next[entry.id] = selected;
          }
        }
        return next;
      });

      const nextPanel = panels[panelIndex + 1];
      setPanels((prev) => {
        const cleared = clearDownstreamPanels(prev, panelIndex);
        if (!nextPanel) {
          return cleared;
        }
        return cleared.map((entry) => {
          if (entry.id === nextPanel.id) {
            clearPanelStats(entry.id);
            return { ...entry, rows: [], loading: true, error: null };
          }
          return entry;
        });
      });

      if (nextPanel) {
        void loadFilteredPanelRows(nextPanel.id, nextPanel.selection, row.downstreamRelation);
      }
    },
    [panels, loadFilteredPanelRows, clearPanelStats],
  );

  const openFieldDialog = useCallback((mode: FieldDialogMode) => {
    setEditingPanelId(null);
    setFieldDialogMode(mode);
    setFieldDialogOpen(true);
  }, []);

  const openPanelEdit = useCallback((panelId: string) => {
    setEditingPanelId(panelId);
    setFieldDialogMode("edit");
    setFieldDialogOpen(true);
  }, []);

  const performDeletePanel = useCallback(
    (panelId: string) => {
      const deleteIndex = panels.findIndex((panel) => panel.id === panelId);
      setPanels((prev) => prev.filter((panel) => panel.id !== panelId));
      setSelectedRowByPanelId((prev) => {
        const next = { ...prev };
        delete next[panelId];
        if (deleteIndex >= 0) {
          for (let i = deleteIndex + 1; i < panels.length; i += 1) {
            delete next[panels[i].id];
          }
        }
        return next;
      });
      setPanelStatsById((prev) => {
        const next = { ...prev };
        delete next[panelId];
        return next;
      });
      setStatsEnabledByPanelId((prev) => {
        const next = { ...prev };
        delete next[panelId];
        return next;
      });
      setShowIdByPanelId((prev) => {
        const next = { ...prev };
        delete next[panelId];
        return next;
      });
    },
    [panels],
  );

  const requestDeletePanel = useCallback((panelId: string) => {
    setDeleteTargetPanelId(panelId);
  }, []);

  const handleFieldConfirm = useCallback(
    (selection: TreeChartFieldSelection) => {
      if (!headerReady) {
        return;
      }
      if (fieldDialogMode === "edit" && editingPanelId) {
        const editIndex = panels.findIndex((panel) => panel.id === editingPanelId);
        const isFirst = editIndex <= 0;
        setSelectedRowByPanelId((prev) => {
          const next = { ...prev };
          for (let i = editIndex; i < panels.length; i += 1) {
            delete next[panels[i].id];
          }
          return next;
        });
        setPanels((prev) =>
          clearDownstreamPanels(
            prev.map((panel) =>
              panel.id === editingPanelId
                ? {
                    ...panel,
                    selection,
                    rows: [],
                    loading: isFirst,
                    error: null,
                  }
                : panel,
            ),
            editIndex,
          ),
        );
        if (isFirst) {
          void loadPanelRows(editingPanelId, selection);
        }
        return;
      }
      const isFirst = fieldDialogMode === "first";
      const panel: TreeChartListPanel = {
        ...createEmptyPanel(selection),
        loading: isFirst,
      };
      if (fieldDialogMode === "first") {
        resetSelection();
        setPanels([panel]);
      } else {
        setPanels((prev) => [...prev, { ...panel, loading: false }]);
      }
      if (isFirst) {
        void loadPanelRows(panel.id, selection);
      }
    },
    [
      fieldDialogMode,
      editingPanelId,
      headerReady,
      loadPanelRows,
      panels,
      resetSelection,
    ],
  );

  const connectionOptions = useMemo(
    () =>
      sqlConnections.length > 0
        ? sqlConnections.map((conn) => ({
            value: conn.id,
            label: conn.name,
          }))
        : [{ value: "", label: t("database.results.noConnection"), disabled: true }],
    [sqlConnections, t],
  );

  return (
    <div className="tree-chart-panel">
      <div className="tree-chart-panel__header">
        <Select
          className="db-select tree-chart-panel__select"
          value={connId}
          onChange={(value) => {
            setConnId(value);
            setDatabase("");
            setPanels([]);
            resetSelection();
            sessionRestoreRef.current = true;
          }}
          title={t("database.workspace.connection")}
          searchable
          placeholder={t("database.results.noConnection")}
          options={connectionOptions}
        />
        <Select
          className="db-select tree-chart-panel__select"
          value={database}
          onChange={(value) => {
            setDatabase(value);
            setPanels([]);
            resetSelection();
            sessionRestoreRef.current = true;
          }}
          disabled={!connId}
          title={t("database.workspace.database")}
          searchable
          placeholder={t("database.workspace.noDatabase")}
          options={databaseOptions}
        />
      </div>

      <div className="tree-chart-panel__split-wrap">
        {panels.length === 0 ? (
          <div className="tree-chart-panel__empty-state">
            <Button
              variant="secondary"
              disabled={!headerReady}
              onClick={() => openFieldDialog("first")}
            >
              {t("database.treeChart.selectFields")}
            </Button>
            {!headerReady ? (
              <p className="tree-chart-panel__empty-hint">{t("database.treeChart.selectConnDbFirst")}</p>
            ) : null}
          </div>
        ) : (
          <DockLayout className="tree-chart-panel__split">
            {panels.map((panel, index) => (
              <Fragment key={panel.id}>
                {index > 0 ? <DockHandle /> : null}
                <DockPanel minSize="15%">
                  <section className="tree-chart-panel__column">
                    <header className="tree-chart-panel__column-header">
                      <span className="tree-chart-panel__column-title">
                        {formatTreeChartPanelTitle(panel.selection)}
                      </span>
                      <div className="tree-chart-panel__column-actions">
                        {index < panels.length - 1 ? (
                          <Button
                            variant="icon"
                            size="icon-sm"
                            className={`tree-chart-panel__column-toggle${
                              statsEnabledByPanelId[panel.id]
                                ? " tree-chart-panel__column-toggle--active"
                                : ""
                            }`}
                            title={
                              statsEnabledByPanelId[panel.id]
                                ? t("database.treeChart.panelStatsToggleOn")
                                : t("database.treeChart.panelStatsToggleOff")
                            }
                            aria-label={t("database.treeChart.panelStats")}
                            aria-pressed={statsEnabledByPanelId[panel.id] ?? false}
                            disabled={
                              !headerReady ||
                              panel.rows.length === 0 ||
                              isPanelAwaitingParent(index)
                            }
                            onClick={() => togglePanelStats(index)}
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14" aria-hidden>
                              <path d="M18 20V10M12 20V4M6 20v-6" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          </Button>
                        ) : null}
                        <Button
                          variant="icon"
                          size="icon-sm"
                          className={`tree-chart-panel__column-toggle${
                            isPanelShowId(panel.id)
                              ? " tree-chart-panel__column-toggle--active"
                              : ""
                          }`}
                          title={
                            isPanelShowId(panel.id)
                              ? t("database.treeChart.panelShowIdToggleOn")
                              : t("database.treeChart.panelShowIdToggleOff")
                          }
                          aria-label={t("database.treeChart.panelShowId")}
                          aria-pressed={isPanelShowId(panel.id)}
                          disabled={
                            !headerReady ||
                            panel.rows.length === 0 ||
                            isPanelAwaitingParent(index)
                          }
                          onClick={() => togglePanelShowId(panel.id)}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14" aria-hidden>
                            <path d="M10 3h4v18h-4V3z" strokeLinecap="round" />
                            <path d="M4 9h16M4 15h16" strokeLinecap="round" />
                          </svg>
                        </Button>
                        <span
                          className="tree-chart-panel__column-actions-divider"
                          aria-hidden
                        />
                        <Button
                          variant="icon"
                          size="icon-sm"
                          title={t("database.treeChart.editPanel")}
                          aria-label={t("database.treeChart.editPanel")}
                          disabled={!headerReady}
                          onClick={() => openPanelEdit(panel.id)}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14" aria-hidden>
                            <path d="M12 20h9" strokeLinecap="round" />
                            <path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </Button>
                        <Button
                          variant="icon"
                          size="icon-sm"
                          title={t("database.treeChart.deletePanel")}
                          aria-label={t("database.treeChart.deletePanel")}
                          disabled={!headerReady}
                          onClick={() => requestDeletePanel(panel.id)}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14" aria-hidden>
                            <path d="M3 6h18M8 6V4h8v2M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6" strokeLinecap="round" strokeLinejoin="round" />
                            <path d="M10 11v6M14 11v6" strokeLinecap="round" />
                          </svg>
                        </Button>
                        <Button
                          variant="icon"
                          size="icon-sm"
                          title={t("database.treeChart.addPanel")}
                          aria-label={t("database.treeChart.addPanel")}
                          disabled={!headerReady}
                          onClick={() => openFieldDialog("next")}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14" aria-hidden>
                            <path d="M12 5v14M5 12h14" strokeLinecap="round" />
                          </svg>
                        </Button>
                      </div>
                    </header>
                    <div className="tree-chart-panel__column-body">
                      <TreeChartListView
                        panel={panel}
                        selectedRowIndex={selectedRowByPanelId[panel.id] ?? null}
                        onRowClick={(rowIndex) => handleRowClick(index, rowIndex)}
                        awaitingParentSelection={isPanelAwaitingParent(index)}
                        stats={
                          statsEnabledByPanelId[panel.id]
                            ? (panelStatsById[panel.id] ?? null)
                            : null
                        }
                        showIds={isPanelShowId(panel.id)}
                      />
                    </div>
                  </section>
                </DockPanel>
              </Fragment>
            ))}
          </DockLayout>
        )}
      </div>

      <TreeChartFieldSelectDialog
        open={fieldDialogOpen}
        onClose={() => {
          setFieldDialogOpen(false);
          setEditingPanelId(null);
        }}
        tables={tables}
        isFirstPanel={fieldDialogIsFirstPanel}
        initial={fieldDialogInitial}
        title={
          fieldDialogMode === "edit"
            ? t("database.treeChart.editPanelTitle")
            : undefined
        }
        subtitle={
          fieldDialogMode === "edit"
            ? t("database.treeChart.editPanelDesc")
            : undefined
        }
        onConfirm={handleFieldConfirm}
      />

      <WarnAlert
        open={deleteTargetPanelId != null}
        title={t("database.treeChart.deletePanelTitle")}
        message={t("database.treeChart.deletePanelMessage")}
        confirmLabel={t("common.confirm")}
        cancelLabel={t("common.cancel")}
        onConfirm={() => {
          if (deleteTargetPanelId) {
            performDeletePanel(deleteTargetPanelId);
          }
        }}
        onClose={() => setDeleteTargetPanelId(null)}
      />
    </div>
  );
}
