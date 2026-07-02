import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "../../../i18n";
import { useActionStore } from "../../../stores/actionStore";
import { introspectTable, type DbConnectionConfig } from "../api";
import type { TableDesignerTabState } from "../dbWorkspaceState";
import { makeQueryRunId } from "../queryRun";
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
}: TableDesignerDockPaneProps) {
  const { t } = useI18n();
  const enqueueAction = useActionStore((s) => s.enqueueAction);
  const driver = useMemo(() => resolveTableDesignerDriver(connection), [connection]);
  const initialPersisted = isValidDesignerTabState(persistedState) ? persistedState : null;
  const skipInitialLoadRef = useRef(Boolean(initialPersisted));

  const [model, setModel] = useState<TableDesignerModel | null>(initialPersisted?.model ?? null);
  const [baseline, setBaseline] = useState<TableDesignerModel | null>(initialPersisted?.baseline ?? null);
  const [loading, setLoading] = useState(!initialPersisted);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<{ kind: "success" | "error"; message: string } | null>(
    null,
  );
  const [reloadToken, setReloadToken] = useState(0);

  const persistState = useCallback(
    (nextModel: TableDesignerModel, nextBaseline: TableDesignerModel) => {
      onPersistState?.({ model: nextModel, baseline: nextBaseline });
    },
    [onPersistState],
  );

  const loadSchema = useCallback(() => {
    if (!driver.supportsTableDesign) {
      setLoading(false);
      setError(t("database.tableDesigner.unsupportedEngine"));
      setModel(null);
      setBaseline(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setSaveNotice(null);

    void introspectTable(connection, dbName, tableName)
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
  }, [connection, dbName, driver, persistState, tableName, t]);

  useEffect(() => {
    if (skipInitialLoadRef.current) {
      skipInitialLoadRef.current = false;
      return;
    }
    return loadSchema();
  }, [loadSchema, reloadToken]);

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
    const connForSchema = { ...connection, database: dbName };

    try {
      for (const sql of statements) {
        enqueueAction({
          type: "sql",
          title: t("database.tableDesigner.saveAction"),
          description: `${connection.name} · ${model.tableName}`,
          command: sql,
          resourceId: connection.id,
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
      setSaveNotice({ kind: "success", message: t("database.tableDesigner.saveSuccess") });
      onSaved?.();
    } catch (err) {
      setSaveNotice({
        kind: "error",
        message: typeof err === "string" ? err : t("database.tableDesigner.saveFailed"),
      });
    } finally {
      setSaving(false);
    }
  }, [baseline, connection, dbName, driver, enqueueAction, model, onSaved, persistState, t]);

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
      onReload={() => setReloadToken((token) => token + 1)}
      reloading={loading}
      dirty={dirty}
      saving={saving}
      onSave={() => void handleSave()}
      saveNotice={saveNotice}
      onDismissSaveNotice={() => setSaveNotice(null)}
    />
  );
}
