import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "../../../i18n";
import { useActionStore } from "../../../stores/actionStore";
import { introspectTable, type DbConnectionConfig } from "../api";
import type { TableDesignerTabState } from "../workspace/dbWorkspaceState";
import { makeQueryRunId } from "../sql/queryRun";
import { createEmptyTableModel } from "./drivers/genericDriver";
import { isNewTableBaseline } from "./applySql";
import { resolveTableDesignerDriver } from "./resolveTableDesignerDriver";
import { TableDesignerPanel } from "./TableDesignerPanel";
import type { TableDesignerModel } from "./types";

interface TableDesignerDockPaneProps {
  connection: DbConnectionConfig;
  dbName: string;
  tableName: string;
  persistedState?: TableDesignerTabState | null;
  onPersistState?: (state: TableDesignerTabState) => void;
  onSaved?: () => void;
  /** 新建表保存成功后回写真实表名（用于更新 Tab） */
  onTableCreated?: (tableName: string) => void;
}

function cloneModel(model: TableDesignerModel): TableDesignerModel {
  return structuredClone(model);
}

function isValidDesignerTabState(
  state: TableDesignerTabState | null | undefined,
): state is TableDesignerTabState {
  return Boolean(state?.model?.fields && state?.baseline?.fields);
}

export function TableDesignerDockPane({
  connection,
  dbName,
  tableName,
  persistedState,
  onPersistState,
  onSaved,
  onTableCreated,
}: TableDesignerDockPaneProps) {
  const { t } = useI18n();
  const enqueueAction = useActionStore((s) => s.enqueueAction);
  const connectionId = connection.id;
  const dbType = connection.db_type;
  const driver = useMemo(
    () => resolveTableDesignerDriver({ db_type: dbType }),
    [dbType],
  );
  const isCreating = !tableName.trim();
  const initialPersisted = isValidDesignerTabState(persistedState) ? persistedState : null;
  const initialCreateModel =
    !initialPersisted && isCreating
      ? createEmptyTableModel(() => driver.createEmptyField())
      : null;
  const skipInitialLoadRef = useRef(Boolean(initialPersisted) || Boolean(initialCreateModel));
  const skipCreatePromoteRef = useRef(false);
  const onPersistStateRef = useRef(onPersistState);
  onPersistStateRef.current = onPersistState;
  const connectionRef = useRef(connection);
  connectionRef.current = connection;

  const [model, setModel] = useState<TableDesignerModel | null>(
    initialPersisted?.model ?? initialCreateModel,
  );
  const [baseline, setBaseline] = useState<TableDesignerModel | null>(
    initialPersisted?.baseline ?? (initialCreateModel ? cloneModel(initialCreateModel) : null),
  );
  const [loading, setLoading] = useState(!initialPersisted && !initialCreateModel);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<{ kind: "success" | "error"; message: string } | null>(
    null,
  );
  const [reloadToken, setReloadToken] = useState(0);

  const persistState = useCallback(
    (nextModel: TableDesignerModel, nextBaseline: TableDesignerModel) => {
      onPersistStateRef.current?.({ model: nextModel, baseline: nextBaseline });
    },
    [],
  );

  const loadSchema = useCallback(() => {
    if (!driver.supportsTableDesign) {
      setLoading(false);
      setError(t("database.tableDesigner.unsupportedEngine"));
      setModel(null);
      setBaseline(null);
      return;
    }

    if (!tableName.trim()) {
      const empty = createEmptyTableModel(() => driver.createEmptyField());
      const emptyBaseline = cloneModel(empty);
      setModel(empty);
      setBaseline(emptyBaseline);
      persistState(empty, emptyBaseline);
      setLoading(false);
      setError(null);
      setSaveNotice(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setSaveNotice(null);
    const conn = connectionRef.current;

    void introspectTable(conn, dbName, tableName)
      .then((schema) => {
        if (cancelled) return;
        const next = driver.fromSchema(schema);
        const nextBaseline = cloneModel(next);
        setModel(next);
        setBaseline(nextBaseline);
        persistState(next, nextBaseline);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(String(err));
        setModel(null);
        setBaseline(null);
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [dbName, driver, persistState, tableName, t]);

  useEffect(() => {
    if (skipInitialLoadRef.current) {
      skipInitialLoadRef.current = false;
      return;
    }
    // 新建表保存成功后父组件回写 tableName：保留当前模型，勿立刻 introspect 冲掉
    if (skipCreatePromoteRef.current) {
      skipCreatePromoteRef.current = false;
      return;
    }
    return loadSchema();
  }, [connectionId, dbName, tableName, reloadToken, loadSchema]);

  useEffect(() => {
    if (!isValidDesignerTabState(persistedState) || model) {
      return;
    }
    setModel(persistedState.model);
    setBaseline(persistedState.baseline);
    setLoading(false);
    setError(null);
  }, [persistedState, model]);

  const dirty = useMemo(
    () => (baseline && model ? driver.hasModelChanges(baseline, model) : false),
    [baseline, model, driver],
  );

  const creating = Boolean(baseline && isNewTableBaseline(baseline));

  const handleSave = useCallback(async () => {
    if (!model || !baseline) return;

    const validationKey = driver.validate(model);
    if (validationKey) {
      setSaveNotice({
        kind: "error",
        message: t(`database.tableDesigner.validation.${validationKey}` as never),
      });
      return;
    }

    const statements = driver.buildApplySql(baseline, model, dbName);
    if (statements.length === 0) {
      setSaveNotice({ kind: "error", message: t("database.tableDesigner.noChanges") });
      return;
    }

    setSaving(true);
    setSaveNotice(null);
    const conn = connectionRef.current;
    const connForSchema = { ...conn, database: dbName };
    const createdName = isNewTableBaseline(baseline) ? model.tableName.trim() : "";

    try {
      for (const sql of statements) {
        enqueueAction({
          type: "sql",
          title: t("database.tableDesigner.saveAction"),
          description: `${conn.name} · ${model.tableName}`,
          command: sql,
          resourceId: conn.id,
          source: "用户",
        });
        await invoke("db_execute_query", {
          connection: connForSchema,
          sql,
          runId: makeQueryRunId(),
        });
      }
      const nextBaseline = cloneModel(model);
      setBaseline(nextBaseline);
      persistState(model, nextBaseline);
      setSaveNotice({
        kind: "success",
        message: createdName
          ? t("database.tableDesigner.createSuccess")
          : t("database.tableDesigner.saveSuccess"),
      });
      if (createdName) {
        skipCreatePromoteRef.current = true;
        onTableCreated?.(createdName);
      }
      onSaved?.();
    } catch (err) {
      setSaveNotice({
        kind: "error",
        message: typeof err === "string" ? err : t("database.tableDesigner.saveFailed"),
      });
    } finally {
      setSaving(false);
    }
  }, [baseline, dbName, driver, enqueueAction, model, onSaved, onTableCreated, persistState, t]);

  if (loading) {
    return <div className="db-table-designer-state">{t("common.loading")}</div>;
  }

  if (error || !model || !baseline) {
    return (
      <div className="db-table-designer-state db-table-designer-state--error">
        {error ?? t("database.tableDesigner.loadFailed")}
      </div>
    );
  }

  return (
    <TableDesignerPanel
      driver={driver}
      dbName={dbName}
      baseline={baseline}
      model={model}
      onModelChange={(next) => {
        setModel(next);
        setSaveNotice(null);
        persistState(next, baseline);
      }}
      onReload={creating ? undefined : () => setReloadToken((token) => token + 1)}
      reloading={loading}
      dirty={dirty}
      saving={saving}
      onSave={() => void handleSave()}
      saveNotice={saveNotice}
      onDismissSaveNotice={() => setSaveNotice(null)}
    />
  );
}
